import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getShipmentCost } from '../ml/mlClient';

/**
 * CUSTO DE FRETE PAGO PELO VENDEDOR.
 *
 * Sem isso, "liquido" mente: numa loja que vende itens de R$ 20 a R$ 70, o frete que sai do seu
 * bolso costuma ser MAIOR que a comissao do ML. Um produto de R$ 68 com R$ 18 de frete tem o frete
 * como maior custo depois da mercadoria.
 *
 * Custa uma chamada por envio, o que seria caro numa varredura de 30 dias. Mas ha uma propriedade
 * que salva: o custo de um envio JA DESPACHADO nunca muda. Entao busca-se uma vez e guarda-se pra
 * sempre; nas varreduras seguintes so os envios novos custam chamada.
 */

interface CacheFretes {
  /** shipmentId -> custo do vendedor em reais. -1 = o ML nao informou (nao tenta de novo toda vez). */
  custos: Record<string, number>;
  atualizadoEm: string;
}

let cache: CacheFretes | null = null;

function caminho(): string {
  return path.join(config.dataDir, 'shipping-costs.json');
}

function carregar(): CacheFretes {
  if (cache) return cache;
  try {
    if (fs.existsSync(caminho())) {
      cache = JSON.parse(fs.readFileSync(caminho(), 'utf-8'));
      return cache!;
    }
  } catch {
    // cache corrompido: recomeca em vez de derrubar a varredura
  }
  cache = { custos: {}, atualizadoEm: new Date().toISOString() };
  return cache;
}

function salvar(): void {
  if (!cache) return;
  try {
    if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
    cache.atualizadoEm = new Date().toISOString();
    const tmp = caminho() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    fs.renameSync(tmp, caminho());
  } catch (err: any) {
    logger.warn('[FRETE] Falha ao gravar o cache:', err?.message || err);
  }
}

export interface ResultadoFretes {
  /** shipmentId -> custo do vendedor (0 quando o ML informou que nao houve custo) */
  custos: Map<string, number>;
  buscadosAgora: number;
  vindosDoCache: number;
  /** envios que ficaram de fora por causa do teto desta varredura */
  naoBuscados: number;
  semInformacao: number;
}

/**
 * Resolve o custo de uma lista de envios, usando cache e respeitando um teto por varredura.
 *
 * O teto existe pra primeira execucao nao consumir a cota inteira do ML de uma vez: ela pega os N
 * mais recentes, e as proximas varreduras vao completando o passado. O painel mostra quantos ainda
 * faltam, pra ninguem achar que o numero ja esta completo.
 */
export async function resolverFretes(shipmentIds: string[]): Promise<ResultadoFretes> {
  const c = carregar();
  const custos = new Map<string, number>();
  let vindosDoCache = 0;
  let buscadosAgora = 0;
  let semInformacao = 0;

  const faltando: string[] = [];
  for (const id of shipmentIds) {
    if (!id) continue;
    const guardado = c.custos[id];
    if (guardado !== undefined) {
      vindosDoCache++;
      if (guardado >= 0) custos.set(id, guardado);
      else semInformacao++;
    } else {
      faltando.push(id);
    }
  }

  const teto = Math.max(0, config.fretesPorVarredura);
  const buscar = faltando.slice(0, teto);
  const naoBuscados = faltando.length - buscar.length;

  for (const id of buscar) {
    const custo = await getShipmentCost(id);
    if (custo == null) {
      c.custos[id] = -1;
      semInformacao++;
    } else {
      c.custos[id] = custo;
      custos.set(id, custo);
    }
    buscadosAgora++;
  }

  if (buscadosAgora > 0) salvar();

  logger.info(
    `[FRETE] ${vindosDoCache} do cache, ${buscadosAgora} buscados agora` +
    (naoBuscados > 0 ? `, ${naoBuscados} adiados pro proximo ciclo (teto de ${teto})` : ''),
  );

  return { custos, buscadosAgora, vindosDoCache, naoBuscados, semInformacao };
}

/**
 * Rateia o frete de um pedido entre seus itens, na proporcao do valor de cada linha.
 *
 * Um pedido com duas linhas de valores diferentes nao deve dividir o frete meio a meio: quem
 * representa 80% do valor carrega 80% do custo. Funcao pura.
 */
export function ratearFrete(freteTotal: number, valoresDasLinhas: number[]): number[] {
  const total = valoresDasLinhas.reduce((s, v) => s + v, 0);
  if (!(freteTotal > 0) || valoresDasLinhas.length === 0) return valoresDasLinhas.map(() => 0);
  // Sem valor nenhum (tudo zero), divide igualmente — nao ha proporcao a respeitar.
  if (total <= 0) return valoresDasLinhas.map(() => Math.round((freteTotal / valoresDasLinhas.length) * 100) / 100);
  return valoresDasLinhas.map((v) => Math.round(((v / total) * freteTotal) * 100) / 100);
}
