import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemPromotionsRaw, getItemsAttributes, getSaleFee, getSellerItemIds, MlApiError, MlItemAttributes } from '../ml/mlClient';
import { getConversion } from './conversion';

/**
 * PROPOSTAS DE PROMOCAO DO MERCADO LIVRE (v35).
 *
 * O ML passou a oferecer, anuncio por anuncio, promocoes prontas: oferta relampago, campanhas
 * (11.11 etc.), e campanhas em que ELE banca parte do desconto ("reduzimos R$ X das suas tarifas").
 * Na tela do vendedor isso aparece em /anuncios/lista/promos. Aqui a mesma lista vem da API
 * seller-promotions, e para cada proposta estimamos quanto sobra por venda comparado ao preco atual.
 *
 * Leitura pura: nada aqui adere, recusa ou muda preco.
 *
 * O "voce recebe" e ESTIMATIVA: preco proposto + parte que o ML banca - tarifa pela tabela do ML
 * naquele preco - frete medio por unidade dos ultimos 30 dias. A tela do ML pode divergir alguns
 * centavos (arredondamento, frete do envio real). O campo `estimativa` diz o que entrou na conta.
 */

export const ROTULO_DO_TIPO: Record<string, string> = {
  DEAL: 'Campanha do ML',
  MARKETPLACE_CAMPAIGN: 'Campanha co-participada (ML banca parte)',
  SMART: 'Co-participacao automatica (ML banca parte)',
  PRICE_MATCHING: 'Preco competitivo (ML banca parte)',
  PRICE_MATCHING_MELI_ALL: 'Preco competitivo (ML banca tudo)',
  LIGHTNING: 'Oferta relampago',
  DOD: 'Oferta do dia',
  PRICE_DISCOUNT: 'Desconto proprio',
  SELLER_CAMPAIGN: 'Campanha propria',
  SELLER_COUPON_CAMPAIGN: 'Cupom proprio',
  VOLUME: 'Desconto por quantidade',
  PRE_NEGOTIATED: 'Desconto pre-acordado',
  UNHEALTHY_STOCK: 'Estoque parado no Full',
};

export type SituacaoPromocao = 'proposta' | 'participando' | 'encerrada' | 'outra';

export function situacaoDoStatus(status: string | undefined | null): SituacaoPromocao {
  const s = String(status || '').toLowerCase();
  if (s === 'candidate') return 'proposta';
  if (s === 'started' || s === 'pending' || s === 'programmed' || s === 'active') return 'participando';
  if (s === 'finished' || s === 'expired' || s === 'deleted') return 'encerrada';
  return 'outra';
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
};
const positivo = (...vs: unknown[]): number | null => {
  for (const v of vs) {
    const n = num(v);
    if (n != null && n > 0) return n;
  }
  return null;
};
const r2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

export interface PromocaoNormalizada {
  /** id da campanha no ML (P-MLB...), quando vem; SMART/relampago as vezes so trazem ref_id/offer_id */
  promocaoId: string | null;
  tipo: string;
  rotulo: string;
  nome: string | null;
  status: string;
  situacao: SituacaoPromocao;
  /** preco ao comprador que o ML propoe (ou que esta valendo, se ja participa) */
  precoProposto: number | null;
  precoMinimo: number | null;
  precoMaximo: number | null;
  precoOriginal: number | null;
  /** % do preco original que o ML banca (co-participacao). null = o ML nao banca nada. */
  mlPercentual: number | null;
  vendedorPercentual: number | null;
  inicio: string | null;
  fim: string | null;
  prazoParaAderir: string | null;
  ofertaId: string | null;
}

/**
 * Le um registro cru de /seller-promotions/items. Funcao PURA, e tolerante: a API muda nomes de
 * campo entre tipos de promocao (end_date x finish_date, ref_id x offer_id), e o que nao vier fica
 * null em vez de quebrar a varredura inteira.
 */
export function normalizarPromocao(raw: any, precoAtual: number | null): PromocaoNormalizada {
  const tipo = String(raw?.type || raw?.promotion_type || 'DESCONHECIDO').toUpperCase();
  const status = String(raw?.status || '');
  const precoOriginal = positivo(raw?.original_price, precoAtual);
  return {
    promocaoId: raw?.id ? String(raw.id) : raw?.promotion_id ? String(raw.promotion_id) : null,
    tipo,
    rotulo: ROTULO_DO_TIPO[tipo] ?? tipo,
    nome: raw?.name ? String(raw.name) : null,
    status,
    situacao: situacaoDoStatus(status),
    // Candidato de campanha costuma vir sem `price` e com a faixa sugerida; SMART/relampago trazem `price`.
    precoProposto: positivo(raw?.price, raw?.deal_price, raw?.suggested_discounted_price, raw?.max_discounted_price),
    precoMinimo: positivo(raw?.min_discounted_price),
    precoMaximo: positivo(raw?.max_discounted_price),
    precoOriginal,
    mlPercentual: positivo(raw?.meli_percentage, raw?.meli_percent, raw?.benefits?.meli_percent),
    vendedorPercentual: positivo(raw?.seller_percentage, raw?.seller_percent, raw?.benefits?.seller_percent),
    inicio: raw?.start_date ?? null,
    fim: raw?.finish_date ?? raw?.end_date ?? null,
    prazoParaAderir: raw?.deadline_date ?? null,
    ofertaId: raw?.offer_id ?? raw?.ref_id ?? null,
  };
}

export interface ContaDaVenda {
  /** quanto o ML banca, em reais por unidade */
  mlBanca: number;
  voceRecebe: number | null;
  voceRecebeHoje: number | null;
  /** voceRecebe - voceRecebeHoje: negativo = abre mao disso por venda em troca de vender mais */
  diferencaPorVenda: number | null;
  estimativa: string;
}

/** Funcao PURA: a conta do "voce recebe" de uma proposta contra o preco atual. */
export function contaDaVenda(p: {
  precoAtual: number | null;
  precoProposto: number | null;
  precoOriginal: number | null;
  mlPercentual: number | null;
  tarifaAtual: number | null;
  tarifaProposta: number | null;
  fretePorUnidade: number | null;
}): ContaDaVenda {
  const frete = p.fretePorUnidade ?? 0;
  const mlBanca = p.mlPercentual && p.precoOriginal ? (p.precoOriginal * p.mlPercentual) / 100 : 0;
  const voceRecebe =
    p.precoProposto != null && p.tarifaProposta != null ? p.precoProposto + mlBanca - p.tarifaProposta - frete : null;
  const voceRecebeHoje = p.precoAtual != null && p.tarifaAtual != null ? p.precoAtual - p.tarifaAtual - frete : null;
  const partes = ['preco proposto', mlBanca ? `+ R$ ${mlBanca.toFixed(2)} bancados pelo ML` : null, '- tarifa pela tabela do ML'];
  partes.push(p.fretePorUnidade != null ? `- frete medio R$ ${frete.toFixed(2)}/un (30 dias)` : '(sem frete: anuncio sem vendas no periodo)');
  return {
    mlBanca: r2(mlBanca) ?? 0,
    voceRecebe: r2(voceRecebe),
    voceRecebeHoje: r2(voceRecebeHoje),
    diferencaPorVenda: voceRecebe != null && voceRecebeHoje != null ? r2(voceRecebe - voceRecebeHoje) : null,
    estimativa: partes.filter(Boolean).join(' '),
  };
}

export interface LinhaPromocao extends PromocaoNormalizada, ContaDaVenda {
  itemId: string;
  titulo: string | null;
  permalink: string | null;
  precoAtual: number | null;
  descontoPercentual: number | null;
  /** quando ESTE sistema viu a proposta pela primeira vez — e o que define "nova" */
  vistaPrimeiroEm: string;
}

export interface PromocoesResult {
  atualizadoEm: string;
  apiDisponivel: boolean;
  /** quando a API recusa (ex.: 403 por falta de permissao no app), o motivo vem aqui */
  avisoDaApi: string | null;
  anunciosAnalisados: number;
  anunciosComErro: number;
  truncado: boolean;
  itens: LinhaPromocao[];
  /** chave (anuncio|tipo|campanha) -> primeira vez vista. Sobrevive entre varreduras. */
  vistas: Record<string, string>;
}

export function chaveDaPromocao(itemId: string, p: Pick<PromocaoNormalizada, 'tipo' | 'promocaoId' | 'ofertaId'>): string {
  return `${itemId}|${p.tipo}|${p.promocaoId ?? p.ofertaId ?? ''}`;
}

/** Monta a linha final de uma promocao. PURA: recebe as tarifas ja buscadas. */
export function montarLinha(
  item: Pick<MlItemAttributes, 'id' | 'title' | 'permalink' | 'price'>,
  promo: PromocaoNormalizada,
  tarifas: { atual: number | null; proposta: number | null },
  fretePorUnidade: number | null,
  vistaPrimeiroEm: string,
): LinhaPromocao {
  const precoAtual = num(item.price);
  const base = promo.precoOriginal ?? precoAtual;
  const conta = contaDaVenda({
    precoAtual,
    precoProposto: promo.precoProposto,
    precoOriginal: promo.precoOriginal,
    mlPercentual: promo.mlPercentual,
    tarifaAtual: tarifas.atual,
    tarifaProposta: tarifas.proposta,
    fretePorUnidade,
  });
  return {
    ...promo,
    ...conta,
    itemId: item.id,
    titulo: item.title ?? null,
    permalink: item.permalink ?? null,
    precoAtual,
    descontoPercentual: base && promo.precoProposto ? r2((1 - promo.precoProposto / base) * 100) : null,
    vistaPrimeiroEm,
  };
}

/** Propostas abertas primeiro; dentro delas, as que menos tiram de cada venda. */
export function ordenarLinhas(linhas: LinhaPromocao[]): LinhaPromocao[] {
  const ordem: Record<SituacaoPromocao, number> = { proposta: 0, participando: 1, outra: 2, encerrada: 3 };
  return [...linhas].sort((a, b) => {
    if (ordem[a.situacao] !== ordem[b.situacao]) return ordem[a.situacao] - ordem[b.situacao];
    return (b.diferencaPorVenda ?? -Infinity) - (a.diferencaPorVenda ?? -Infinity);
  });
}

// ---------------------------------------------------------------- cache e varredura

let cached: PromocoesResult | null = null;

function persist(result: PromocoesResult): void {
  const dir = path.dirname(config.promocoesCachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  cached = result;
  const tmp = config.promocoesCachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  fs.renameSync(tmp, config.promocoesCachePath);
}

export function getPromocoes(): PromocoesResult | null {
  if (cached) return cached;
  try {
    if (fs.existsSync(config.promocoesCachePath)) cached = JSON.parse(fs.readFileSync(config.promocoesCachePath, 'utf-8'));
  } catch {
    cached = null;
  }
  return cached;
}

let scanInFlight: Promise<PromocoesResult> | null = null;

export function refreshPromocoes(): Promise<PromocoesResult> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = doScan().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

/** Executa `fn` sobre a lista com no maximo `n` chamadas ao ML ao mesmo tempo. */
async function emLotes<T>(lista: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (i < lista.length) await fn(lista[i++]);
  });
  await Promise.all(trabalhadores);
}

async function doScan(): Promise<PromocoesResult> {
  if (!getMlAuthStatus().authenticated) {
    throw new Error('Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.');
  }
  const max = config.promocoesScanMaxItems;
  const ids = await getSellerItemIds(max, false);
  const attrs = await getItemsAttributes(ids);

  const conv = getConversion();
  const fretePorItem = new Map<string, number>();
  for (const c of conv?.items ?? []) if (c.vendas30 > 0) fretePorItem.set(c.itemId, c.frete30 / c.vendas30);

  const anteriores = getPromocoes()?.vistas ?? {};
  const vistas: Record<string, string> = {};
  const agora = new Date().toISOString();

  // A mesma (preco, tipo de anuncio, categoria) se repete muito: busca a tarifa uma vez so.
  const tarifas = new Map<string, Promise<number | null>>();
  const tarifa = (item: MlItemAttributes, preco: number | null): Promise<number | null> => {
    if (preco == null || !item.listing_type_id) return Promise.resolve(null);
    const site = item.id.slice(0, 3);
    const k = `${site}|${preco}|${item.listing_type_id}|${item.category_id ?? ''}`;
    if (!tarifas.has(k)) {
      tarifas.set(k, getSaleFee(site, preco, item.listing_type_id, item.category_id).catch(() => null));
    }
    return tarifas.get(k)!;
  };

  const itens: LinhaPromocao[] = [];
  let erros = 0;
  let recusas = 0;
  let avisoDaApi: string | null = null;

  await emLotes(attrs, 4, async (item) => {
    // Se a API recusou os primeiros anuncios por permissao, nao adianta martelar os outros 190.
    if (recusas >= 3 && itens.length === 0) return;
    let brutos: any[];
    try {
      brutos = await getItemPromotionsRaw(item.id);
    } catch (err: any) {
      erros++;
      // Mantem a data de "vista" das propostas deste anuncio: senao, na proxima varredura que
      // funcionar, elas voltariam como novas e o aviso diario repetiria tudo.
      for (const [k, v] of Object.entries(anteriores)) if (k.startsWith(`${item.id}|`)) vistas[k] = v;
      if (err instanceof MlApiError && (err.status === 401 || err.status === 403)) {
        recusas++;
        avisoDaApi = `O ML recusou a leitura de promocoes (${err.status}: ${err.message}). Talvez falte ligar a permissao de promocoes no aplicativo do ML (DevCenter).`;
      }
      return;
    }
    const precoAtual = num(item.price);
    const tarifaAtual = await tarifa(item, precoAtual);
    for (const raw of brutos) {
      const promo = normalizarPromocao(raw, precoAtual);
      if (promo.situacao === 'encerrada') continue;
      const chave = chaveDaPromocao(item.id, promo);
      vistas[chave] = anteriores[chave] ?? agora;
      const tarifaProposta = await tarifa(item, promo.precoProposto);
      itens.push(
        montarLinha(item, promo, { atual: tarifaAtual, proposta: tarifaProposta }, fretePorItem.get(item.id) ?? null, vistas[chave]),
      );
    }
  });

  const apiDisponivel = !(recusas > 0 && itens.length === 0);
  const result: PromocoesResult = {
    atualizadoEm: agora,
    apiDisponivel,
    avisoDaApi: apiDisponivel ? (erros ? `${erros} anuncio(s) nao responderam; ficaram de fora desta varredura.` : null) : avisoDaApi,
    anunciosAnalisados: attrs.length,
    anunciosComErro: erros,
    truncado: ids.length >= max,
    itens: ordenarLinhas(itens),
    vistas,
  };
  persist(result);
  logger.info(
    `[PROMOCOES] ${attrs.length} anuncios, ${result.itens.filter((i) => i.situacao === 'proposta').length} proposta(s) abertas, ${erros} erro(s).`,
  );
  return result;
}

export function startPromocoesLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    try {
      await refreshPromocoes();
    } catch (err: any) {
      logger.warn('[PROMOCOES] Falha na varredura de background:', err?.message || err);
    }
  };
  // Depois das outras varreduras: o frete medio vem da de conversao.
  setTimeout(() => run().catch((e) => logger.error('[PROMOCOES] Erro inicial:', e?.message || e)), 150000).unref();
  setInterval(
    () => run().catch((e) => logger.error('[PROMOCOES] Erro periodico:', e?.message || e)),
    Math.max(1, config.promocoesScanIntervalHours) * 60 * 60 * 1000,
  ).unref();
  logger.info(`[PROMOCOES] Varredura de promocoes em background ligada (a cada ${config.promocoesScanIntervalHours}h).`);
}
