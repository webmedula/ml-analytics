import fs from 'node:fs';
import { config } from '../config';
import { logger } from '../logger';
import { listarProdutos } from '../tiny/tinyClient';

/**
 * CUSTO POR SKU, vindo do Tiny.
 *
 * E o numero que transforma "liquido" em MARGEM. Sem ele o painel responde quanto entrou; com ele
 * responde quanto SOBROU — e so a segunda pergunta decide se vale patrocinar, baixar preco ou
 * repor estoque.
 *
 * Guardado em arquivo porque custo muda pouco e cada varredura e uma sequencia de chamadas ao ERP.
 * Menos chamada tambem significa menos renovacao de token, e portanto menos risco de brigar com o
 * outro servico que emite nota fiscal na mesma conta.
 */

interface CacheCustos {
  /** chave normalizada do SKU -> custo em reais. SKU sem custo cadastrado NAO entra aqui. */
  custos: Record<string, number>;
  /** SKUs que existem no Tiny mas estao sem custo — distingue "nao cadastrado" de "nao existe". */
  semCusto: string[];
  atualizadoEm: string;
  produtosLidos: number;
}

let cache: CacheCustos | null = null;

/**
 * Normaliza o SKU pra comparacao. O mesmo produto costuma aparecer como "RL-6003" no Tiny e
 * " rl-6003 " no ML; casar so na string exata perderia o par silenciosamente.
 */
export function chaveSku(sku: string | null | undefined): string | null {
  if (typeof sku !== 'string') return null;
  const limpo = sku.trim().toUpperCase().replace(/\s+/g, ' ');
  return limpo.length > 0 ? limpo : null;
}

function carregar(): CacheCustos | null {
  if (cache) return cache;
  try {
    if (fs.existsSync(config.custosCachePath)) {
      cache = JSON.parse(fs.readFileSync(config.custosCachePath, 'utf-8'));
      return cache;
    }
  } catch {
    // cache corrompido: recomeca em vez de derrubar a varredura
  }
  return null;
}

function salvar(dados: CacheCustos): void {
  try {
    if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = config.custosCachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dados), 'utf-8');
    fs.renameSync(tmp, config.custosCachePath);
  } catch (err: any) {
    logger.warn('[CUSTOS] Falha ao gravar o cache:', err?.message || err);
  }
}

function vencido(c: CacheCustos | null): boolean {
  if (!c) return true;
  const idadeH = (Date.now() - new Date(c.atualizadoEm).getTime()) / 3_600_000;
  return !Number.isFinite(idadeH) || idadeH >= config.custosValidadeHoras;
}

/** Le o catalogo inteiro do Tiny e regrava o cache de custos. */
export async function atualizarCustos(limite = 5000): Promise<CacheCustos> {
  const produtos = await listarProdutos(limite);

  const custos: Record<string, number> = {};
  const semCusto: string[] = [];

  for (const p of produtos) {
    const chave = chaveSku(p.sku);
    if (!chave) continue;
    if (p.custo != null && p.custo > 0) custos[chave] = p.custo;
    else if (!custos[chave]) semCusto.push(chave);
  }

  const novo: CacheCustos = {
    custos,
    semCusto,
    atualizadoEm: new Date().toISOString(),
    produtosLidos: produtos.length,
  };
  cache = novo;
  salvar(novo);

  logger.info(`[CUSTOS] ${produtos.length} produto(s) do Tiny; ${Object.keys(custos).length} com custo.`);
  return novo;
}

/** Cache de custos, atualizando quando vencido. `forcar` ignora a validade. */
export async function obterCustos(forcar = false): Promise<CacheCustos> {
  const atual = carregar();
  if (!forcar && !vencido(atual)) return atual!;
  try {
    return await atualizarCustos();
  } catch (err: any) {
    // Cache velho vale mais que nenhum custo: o painel mostra a data e o usuario decide se confia.
    if (atual) {
      logger.warn('[CUSTOS] Falha ao atualizar; usando o cache anterior:', err?.message || err);
      return atual;
    }
    throw err;
  }
}

export interface Emparelhamento {
  /** SKUs do ML que acharam custo */
  comCusto: number;
  /** SKUs do ML que existem no Tiny mas sem custo cadastrado */
  semCustoNoTiny: number;
  /** SKUs do ML que nao existem no Tiny */
  foraDoTiny: number;
  /** anuncios do ML sem SKU nenhum — impossivel casar */
  semSku: number;
}

/**
 * Cruza os SKUs do ML com o cache de custos e conta em qual dos quatro estados cada anuncio caiu.
 * Funcao pura: e o que permite testar o emparelhamento sem ML nem Tiny na frente.
 */
export function emparelhar(
  skusDoMl: Array<string | null>,
  custos: Record<string, number>,
  semCusto: string[],
): Emparelhamento {
  const conhecidosSemCusto = new Set(semCusto);
  const r: Emparelhamento = { comCusto: 0, semCustoNoTiny: 0, foraDoTiny: 0, semSku: 0 };

  for (const bruto of skusDoMl) {
    const chave = chaveSku(bruto);
    if (!chave) r.semSku++;
    else if (custos[chave] != null) r.comCusto++;
    else if (conhecidosSemCusto.has(chave)) r.semCustoNoTiny++;
    else r.foraDoTiny++;
  }

  return r;
}
