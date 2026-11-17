import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { chaveSku, obterCustos } from './custos';
import { impostosComCache, tabelaDeImpostos, type ImpostosDoBackup } from './diagnosticoCustos';
import type { LacunaDoAnuncio } from './margem';
import { getMargem, refreshMargem } from './margemScan';

/**
 * LUCRO POR PRODUTO, NUM LUGAR SO (v51).
 *
 * Uma ficha por SKU com o custo unitario (Tiny) e o % de imposto da venda (notas reais do backup). E a
 * fonte que a aba Promocoes, o Gerente e a Central de Ocorrencias leem, para todos mostrarem o MESMO
 * numero. Ninguem mais le custo direto do Tiny para calcular lucro.
 *
 * Lucro de uma venda = o que o ML deposita (preco + parte do ML − tarifa − frete) − custo − imposto.
 * Sem custo o lucro fica null ("nao sei"), nunca zero. Sem imposto conhecido, sai o lucro antes do
 * imposto e o campo `lucro` fica null.
 */

export interface FichaDeLucro {
  sku: string;
  custoUnitario: number | null;
  impostoPct: number | null;
  impostoOrigem: 'produto' | 'geral' | null;
}

export interface Fichas {
  atualizadoEm: string;
  /** anuncio do ML -> SKU normalizado */
  porItem: Record<string, string>;
  porSku: Record<string, FichaDeLucro>;
  imposto: { disponivel: boolean; motivo: string | null; percentualGeral: number | null; observacao: string | null };
}

export interface LucroDaVenda {
  custo: number | null;
  imposto: number | null;
  /** recebe − custo (sem o imposto) */
  lucroAntesDoImposto: number | null;
  /** recebe − custo − imposto. null quando falta custo ou imposto. */
  lucro: number | null;
  /** lucro ÷ preco, em % */
  margemPct: number | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Monta as fichas. PURA. */
export function montarFichas(
  anuncios: Pick<LacunaDoAnuncio, 'itemId' | 'sku'>[],
  custos: Record<string, number>,
  impostos: ImpostosDoBackup,
  agora = new Date(),
): Fichas {
  const dados = impostos.disponivel ? impostos.dados : null;
  const tabela = tabelaDeImpostos(dados);
  const porItem: Record<string, string> = {};
  const skus = new Set<string>(Object.keys(custos));
  for (const a of anuncios) {
    const k = chaveSku(a.sku);
    if (!k) continue;
    porItem[a.itemId] = k;
    skus.add(k);
  }
  for (const k of tabela.porSku.keys()) skus.add(k);
  const porSku: Record<string, FichaDeLucro> = {};
  for (const k of skus) {
    const { pct, origem } = tabela.pctDoSku(k);
    porSku[k] = { sku: k, custoUnitario: custos[k] ?? null, impostoPct: pct, impostoOrigem: origem };
  }
  return {
    atualizadoEm: agora.toISOString(),
    porItem,
    porSku,
    imposto: {
      disponivel: !!dados,
      motivo: impostos.disponivel ? null : impostos.motivo,
      percentualGeral: tabela.pctGeral,
      observacao: dados?.regime.observacao ?? null,
    },
  };
}

/** Lucro de UMA unidade vendida a `preco`, recebendo `recebe` do ML. PURA. */
export function lucroDaVenda(recebe: number | null | undefined, preco: number | null | undefined, ficha: FichaDeLucro | null | undefined, unidades = 1): LucroDaVenda {
  const custo = ficha?.custoUnitario != null ? r2(ficha.custoUnitario * unidades) : null;
  const imposto = ficha?.impostoPct != null && preco != null ? r2((preco * ficha.impostoPct) / 100) : null;
  const antes = recebe != null && custo != null ? r2(recebe - custo) : null;
  const lucro = antes != null && imposto != null ? r2(antes - imposto) : null;
  return { custo, imposto, lucroAntesDoImposto: antes, lucro, margemPct: lucro != null && preco ? Math.round((lucro / preco) * 1000) / 10 : null };
}

// ---------- promocoes ----------

export interface LucroDaPromocao {
  custoUnitario: number | null;
  impostoPct: number | null;
  /** lucro por venda no preco proposto */
  lucroPorVenda: number | null;
  lucroAntesDoImposto: number | null;
  /** lucro por venda no preco de hoje */
  lucroHoje: number | null;
  /** lucro proposto − lucro de hoje */
  diferencaDeLucro: number | null;
  /** true quando o lucro da proposta (com imposto, ou antes dele se o imposto nao for conhecido) fica abaixo de zero */
  daPrejuizo: boolean | null;
}

type LinhaComPreco = { itemId: string; precoProposto: number | null; precoAtual: number | null; voceRecebe: number | null; voceRecebeHoje: number | null };

/** Acrescenta o lucro a uma linha de promocao. PURA. */
export function lucroDaPromocao(l: LinhaComPreco, fichas: Fichas | null): LucroDaPromocao {
  const sku = fichas?.porItem[l.itemId];
  const ficha = sku ? fichas!.porSku[sku] : undefined;
  const prop = lucroDaVenda(l.voceRecebe, l.precoProposto, ficha);
  const hoje = lucroDaVenda(l.voceRecebeHoje, l.precoAtual, ficha);
  const referencia = prop.lucro ?? prop.lucroAntesDoImposto;
  return {
    custoUnitario: ficha?.custoUnitario ?? null,
    impostoPct: ficha?.impostoPct ?? null,
    lucroPorVenda: prop.lucro,
    lucroAntesDoImposto: prop.lucroAntesDoImposto,
    lucroHoje: hoje.lucro,
    diferencaDeLucro: prop.lucro != null && hoje.lucro != null ? r2(prop.lucro - hoje.lucro) : null,
    daPrejuizo: referencia == null ? null : referencia < 0,
  };
}

export function comLucro<T extends LinhaComPreco>(linhas: T[], fichas: Fichas | null = getFichas()): Array<T & LucroDaPromocao> {
  return linhas.map((l) => ({ ...l, ...lucroDaPromocao(l, fichas) }));
}

// ---------- cache e atualizacao ----------

let fichas: Fichas | null = null;
export function getFichas(): Fichas | null {
  return fichas;
}

export async function refreshFichas(): Promise<Fichas> {
  const atual = getMargem();
  const idadeH = atual ? (Date.now() - new Date(atual.atualizadoEm).getTime()) / 3_600_000 : Infinity;
  const margem = atual && idadeH < 6 ? atual : await refreshMargem();
  const [custos, impostos] = await Promise.all([obterCustos(), impostosComCache()]);
  fichas = montarFichas(margem.anuncios, custos.custos, impostos);
  logger.info(`[LUCRO] ${Object.keys(fichas.porSku).length} ficha(s); imposto ${fichas.imposto.disponivel ? `${fichas.imposto.percentualGeral}% geral` : 'indisponivel'}.`);
  return fichas;
}

/** Fichas prontas; sem cache (ou com o imposto ainda sendo somado no backup), refaz. */
export async function obterFichas(forcar = false): Promise<Fichas> {
  if (forcar || !fichas) return refreshFichas();
  if (!fichas.imposto.disponivel && Date.now() - new Date(fichas.atualizadoEm).getTime() > 5 * 60_000) return refreshFichas();
  return fichas;
}

export function startFichasLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    try {
      await refreshFichas();
    } catch (err: any) {
      logger.warn('[LUCRO] Falha ao montar as fichas:', err?.message || err);
    }
  };
  // Depois da varredura de promocoes (150 s), que e quem mais usa as fichas.
  setTimeout(() => run().catch(() => undefined), 200_000).unref();
  setInterval(() => run().catch(() => undefined), Math.max(1, config.promocoesScanIntervalHours) * 3600_000).unref();
}
