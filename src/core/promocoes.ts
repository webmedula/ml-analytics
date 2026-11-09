import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getFreteGratis, getItemPromotionsRaw, getItemsAttributes, getSaleFee, getSalePriceRaw, getSellerItemIds, MlApiError, MlItemAttributes, parsePrecoDeVenda, PrecoDeVenda } from '../ml/mlClient';
import { getConversion } from './conversion';
import { getCatalogCompetition } from './catalogCompetition';
import { bancoDisponivel, gravarFotosDePromocoes } from '../db/banco';
import { montarFotos } from './promocoesAcompanhamento';

/**
 * PROPOSTAS DE PROMOCAO DO MERCADO LIVRE (v35).
 *
 * O ML passou a oferecer, anuncio por anuncio, promocoes prontas: oferta relampago, campanhas
 * (11.11 etc.), e campanhas em que ELE banca parte do desconto ("reduzimos R$ X das suas tarifas").
 * Na tela do vendedor isso aparece em /anuncios/lista/promos. Aqui a mesma lista vem da API
 * seller-promotions, e para cada proposta estimamos quanto sobra por venda comparado ao preco atual.
 *
 * Leitura: nada aqui adere ou muda preco. A adesao (v39) fica em promocoesAdesao.ts, so pelo painel.
 *
 * O "voce recebe" e ESTIMATIVA: preco proposto + parte que o ML banca - tarifa pela tabela do ML
 * naquele preco - frete gratis que o ML cobra naquele preco (v40; sem ele, frete medio dos ultimos 30 dias). A tela do ML pode divergir alguns
 * centavos (arredondamento, frete do envio real). O campo `estimativa` diz o que entrou na conta.
 */

export const ROTULO_DO_TIPO: Record<string, string> = {
  DEAL: 'Campanha do ML',
  MARKETPLACE_CAMPAIGN: 'Campanha co-participada (ML banca parte)',
  SMART: 'Co-participacao automatica (ML banca parte)',
  SMART_LIGHTNING: 'Oferta relampago co-participada (ML banca parte)',
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

/**
 * As tres situacoes da tela de promocoes do ML: ATIVA (e ela que define o preco agora),
 * PROGRAMADA (voce aderiu e ainda nao comecou, ou aderiu mas outra promocao esta valendo) e
 * "Nova proposta" (ainda nao aderiu).
 */
export type SituacaoPromocao = 'proposta' | 'programada' | 'ativa' | 'encerrada' | 'outra';

/** "participando" = ativa ou programada (o vendedor ja aderiu). */
export const participa = (s: SituacaoPromocao): boolean => s === 'ativa' || s === 'programada';

/**
 * Tipos em que o ML cria a oferta pronta. Na API elas aparecem como started/pending mesmo quando
 * o vendedor NAO aderiu (conferido em 2026-11-03 no MLB4109133481: PRICE_MATCHING "started" e
 * SMART_LIGHTNING "pending", sem data, apareciam na tela do ML como "Nova proposta").
 * Ja no MLB3752079801 (2026-11-04) uma relampago com horario marcado (6/nov 0h-12h) aparecia como
 * PROGRAMADA: oferta pronta COM data de inicio = o vendedor aceitou e o ML agendou.
 */
const OFERTA_CRIADA_PELO_ML = new Set(['SMART', 'PRICE_MATCHING', 'PRICE_MATCHING_MELI_ALL', 'SMART_LIGHTNING', 'UNHEALTHY_STOCK']);

/** O que o sale_price diz sobre a promocao que define o preco agora. */
export interface PromocaoAtiva {
  promocaoId?: string | null;
  ofertaId?: string | null;
}

const ehAtiva = (promocaoId: string | null, ofertaId: string | null, a: PromocaoAtiva | null | undefined): boolean =>
  !!a && ((!!a.promocaoId && promocaoId === a.promocaoId) || (!!a.ofertaId && ofertaId === a.ofertaId));

/**
 * Situacao de uma promocao do anuncio, como a tela do ML mostra:
 * - ATIVA: e a que define o preco agora (sale_price: campaign_id = id da promocao, ou
 *   promotion_id = ref_id da oferta).
 * - PROGRAMADA: status "pending" (a doc do ML: aprovada e programada). Conferido em 2026-11-04 no
 *   MLB3752079801: SMART_LIGHTNING "pending" aparece na tela como "Oferta relampago 6/nov PROGRAMADA".
 * - Nova proposta: candidata, ou oferta pronta do ML ("started") que nao esta definindo o preco
 *   (ex.: PRICE_MATCHING "started" no MLB4109133481 aparecia como "Nova proposta").
 */
export function situacaoDaPromocao(
  tipo: string,
  status: string | undefined | null,
  promocaoId: string | null,
  ativa: PromocaoAtiva | string | null | undefined,
  inicio?: string | null,
  agora = Date.now(),
  ofertaId: string | null = null,
): SituacaoPromocao {
  const a: PromocaoAtiva | null = typeof ativa === 'string' ? { promocaoId: ativa } : ativa ?? null;
  const s = String(status || '').toLowerCase();
  const base = situacaoDoStatus(s);
  if (base === 'encerrada' || base === 'proposta' || base === 'outra') return base;
  if (ehAtiva(promocaoId, ofertaId, a)) return 'ativa';
  if (s === 'pending') return 'programada';
  if (inicio && Date.parse(inicio) > agora) return 'programada';
  if (OFERTA_CRIADA_PELO_ML.has(tipo)) return 'proposta';
  // Campanha a que o vendedor aderiu e ja comecou: e a ativa se nao sabemos qual define o preco.
  return a?.promocaoId || a?.ofertaId ? 'programada' : 'ativa';
}

/** Candidatas que o proprio ML organiza: preco acima do de hoje nao faria efeito (vale o menor). */
const CANDIDATA_DO_ML = new Set(['DEAL', 'LIGHTNING', 'DOD', 'MARKETPLACE_CAMPAIGN']);

export function situacaoDoStatus(status: string | undefined | null): SituacaoPromocao {
  const s = String(status || '').toLowerCase();
  if (s === 'candidate') return 'proposta';
  if (s === 'started' || s === 'pending' || s === 'programmed' || s === 'active') return 'ativa';
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
export function normalizarPromocao(
  raw: any,
  precoAtual: number | null,
  ativa?: PromocaoAtiva | string | null,
  precoDeVendaHoje?: number | null,
): PromocaoNormalizada {
  const tipo = String(raw?.type || raw?.promotion_type || 'DESCONHECIDO').toUpperCase();
  const status = String(raw?.status || '');
  const precoOriginal = positivo(raw?.original_price, precoAtual);
  const promocaoId = raw?.id ? String(raw.id) : raw?.promotion_id ? String(raw.promotion_id) : null;
  const candidato = situacaoDoStatus(status) === 'proposta';
  const ofertaId = raw?.offer_id ?? raw?.ref_id ?? null;
  // Preco que a TELA do ML propoe para candidatas (o suggested_discounted_price da API ela ignora):
  // - campanha/relampago/oferta do dia: o teto da faixa, sem passar do preco de hoje
  //   (MLB5332741758: teto 242,49, hoje 172,69 -> tela 172,69; MLB3827163247: teto 203,69 -> tela
  //   203,69, enquanto o suggested era 173,69). O ML aplica o menor preco, entao acima de hoje nao muda nada.
  // - campanha propria (SELLER_CAMPAIGN): o teto da faixa, que e o % da campanha (MLB3827163247:
  //   OUTUBRO 2026 a 284,99 = 5% do cheio; o suggested era 209,99).
  let precoProposto = candidato
    ? positivo(raw?.max_discounted_price, raw?.suggested_discounted_price, raw?.price)
    : positivo(raw?.price, raw?.deal_price, raw?.suggested_discounted_price);
  if (candidato && tipo === 'PRICE_DISCOUNT') precoProposto = positivo(raw?.suggested_discounted_price, raw?.max_discounted_price);
  const minimo = positivo(raw?.min_discounted_price);
  if (candidato && CANDIDATA_DO_ML.has(tipo) && precoProposto != null && precoDeVendaHoje != null && precoDeVendaHoje < precoProposto) {
    precoProposto = minimo != null ? Math.max(minimo, precoDeVendaHoje) : precoDeVendaHoje;
  }
  return {
    promocaoId,
    tipo,
    rotulo: ROTULO_DO_TIPO[tipo] ?? tipo,
    nome: raw?.name ? String(raw.name) : null,
    status,
    situacao: situacaoDaPromocao(tipo, status, promocaoId, ativa, raw?.start_date ?? null, Date.now(), ofertaId),
    precoProposto,
    precoMinimo: positivo(raw?.min_discounted_price),
    precoMaximo: positivo(raw?.max_discounted_price),
    precoOriginal,
    mlPercentual: positivo(raw?.meli_percentage, raw?.meli_percent, raw?.benefits?.meli_percent),
    vendedorPercentual: positivo(raw?.seller_percentage, raw?.seller_percent, raw?.benefits?.seller_percent),
    inicio: raw?.start_date ?? null,
    fim: raw?.finish_date ?? raw?.end_date ?? null,
    prazoParaAderir: raw?.deadline_date ?? null,
    ofertaId,
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
  /** frete medio por unidade dos ultimos 30 dias: so quando o ML nao informa o frete gratis */
  fretePorUnidade: number | null;
  /** v40: frete gratis que o vendedor paga em cada preco, pelo ML (o mesmo da tela de promocoes) */
  freteAtual?: number | null;
  freteProposto?: number | null;
}): ContaDaVenda {
  const media = p.fretePorUnidade ?? 0;
  const doMl = p.freteAtual != null && p.freteProposto != null;
  const freteHoje = doMl ? p.freteAtual! : media;
  const fretePromo = doMl ? p.freteProposto! : media;
  const mlBanca = p.mlPercentual && p.precoOriginal ? (p.precoOriginal * p.mlPercentual) / 100 : 0;
  const voceRecebe =
    p.precoProposto != null && p.tarifaProposta != null ? p.precoProposto + mlBanca - p.tarifaProposta - fretePromo : null;
  const voceRecebeHoje = p.precoAtual != null && p.tarifaAtual != null ? p.precoAtual - p.tarifaAtual - freteHoje : null;
  const partes = ['preco proposto', mlBanca ? `+ R$ ${mlBanca.toFixed(2)} bancados pelo ML` : null, '- tarifa pela tabela do ML'];
  partes.push(
    doMl
      ? `- frete gratis R$ ${fretePromo.toFixed(2)} (calculo do ML nesse preco)`
      : p.fretePorUnidade != null
        ? `- frete medio R$ ${media.toFixed(2)}/un (30 dias)`
        : '(sem frete: anuncio sem vendas no periodo)',
  );
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
  /** preco que o comprador paga HOJE (com a promocao ativa, se houver) */
  precoAtual: number | null;
  precoCheio: number | null;
  descontoPercentual: number | null;
  /** v47: status do anuncio no ML (active, paused, closed...). Ausente em cache de versao anterior. */
  statusAnuncio?: string | null;
  /** quando ESTE sistema viu a proposta pela primeira vez — e o que define "nova" */
  vistaPrimeiroEm: string;
  /**
   * v44: proposta com preco ACIMA do que o comprador paga hoje. O ML aplica o menor preco entre as
   * promocoes, entao aderir nao muda nada enquanto a atual valer (ex.: OUTUBRO 2026 a 2.754,05 com
   * a Meli Essencial a 1.733 no MLB3752079801). Nao entra na conta de ganho.
   */
  semEfeito?: boolean;
}

export interface AnuncioSemPromocao {
  itemId: string;
  titulo: string | null;
  permalink: string | null;
  precoAtual: number | null;
  vendas30: number | null;
}

/** v49: anuncios lidos sem nenhuma linha de promocao, os que mais vendem primeiro. PURA. */
export function anunciosSemPromocao(
  anuncios: Pick<MlItemAttributes, 'id' | 'title' | 'permalink' | 'price'>[],
  idsOk: Set<string>,
  linhas: Pick<LinhaPromocao, 'itemId'>[],
  vendas30: Map<string, number>,
  precoDeVenda: Map<string, number | null> = new Map(),
): AnuncioSemPromocao[] {
  const comPromo = new Set(linhas.map((l) => l.itemId));
  return anuncios
    .filter((a) => idsOk.has(a.id) && !comPromo.has(a.id))
    .map((a) => ({
      itemId: a.id,
      titulo: a.title ?? null,
      permalink: a.permalink ?? null,
      precoAtual: precoDeVenda.get(a.id) ?? num(a.price),
      vendas30: vendas30.get(a.id) ?? null,
    }))
    .sort((a, b) => (b.vendas30 ?? -1) - (a.vendas30 ?? -1) || (a.titulo ?? '').localeCompare(b.titulo ?? '', 'pt-BR'));
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
  /**
   * v49: anuncios lidos com sucesso que nao tem promocao nenhuma (nem ativa, nem programada, nem
   * proposta do ML). Sem isso eles nao aparecem na aba, que so lista linhas de promocao.
   */
  semPromocao?: AnuncioSemPromocao[];
  /** chave (anuncio|tipo|campanha) -> primeira vez vista. Sobrevive entre varreduras. */
  vistas: Record<string, string>;
}

export function chaveDaPromocao(itemId: string, p: Pick<PromocaoNormalizada, 'tipo' | 'promocaoId' | 'ofertaId'>): string {
  return `${itemId}|${p.tipo}|${p.promocaoId ?? p.ofertaId ?? ''}`;
}

/** Monta a linha final de uma promocao. PURA: recebe as tarifas ja buscadas. */
export function montarLinha(
  item: Pick<MlItemAttributes, 'id' | 'title' | 'permalink' | 'price' | 'status'>,
  promo: PromocaoNormalizada,
  tarifas: { atual: number | null; proposta: number | null },
  fretePorUnidade: number | null | { media: number | null; atual: number | null; proposta: number | null },
  vistaPrimeiroEm: string,
  precoDeVendaAtual?: number | null,
): LinhaPromocao {
  const precoAtual = precoDeVendaAtual ?? num(item.price);
  const base = promo.precoOriginal ?? precoAtual;
  const conta = contaDaVenda({
    precoAtual,
    precoProposto: promo.precoProposto,
    precoOriginal: promo.precoOriginal,
    mlPercentual: promo.mlPercentual,
    tarifaAtual: tarifas.atual,
    tarifaProposta: tarifas.proposta,
    ...(fretePorUnidade != null && typeof fretePorUnidade === 'object'
      ? { fretePorUnidade: fretePorUnidade.media, freteAtual: fretePorUnidade.atual, freteProposto: fretePorUnidade.proposta }
      : { fretePorUnidade }),
  });
  return {
    ...promo,
    ...conta,
    itemId: item.id,
    titulo: item.title ?? null,
    permalink: item.permalink ?? null,
    precoAtual,
    descontoPercentual: base && promo.precoProposto ? r2((1 - promo.precoProposto / base) * 100) : null,
    precoCheio: num(item.price),
    statusAnuncio: item.status ?? null,
    vistaPrimeiroEm,
  };
}

/**
 * A tela do ML mostra UMA "Oferta relampago" por anuncio: quando ha a co-participada (SMART_LIGHTNING,
 * com parte bancada pelo ML) como proposta, a relampago comum (LIGHTNING) candidata nao aparece.
 * Conferido em 2026-11-05 no MLB3827163247: a API traz as duas candidatas, a tela so a co-participada.
 */
export function semRelampagoDuplicada(linhas: LinhaPromocao[]): LinhaPromocao[] {
  const comCoParticipada = new Set(linhas.filter((l) => l.tipo === 'SMART_LIGHTNING' && l.situacao === 'proposta').map((l) => l.itemId));
  return linhas.filter((l) => !(l.tipo === 'LIGHTNING' && l.situacao === 'proposta' && comCoParticipada.has(l.itemId)));
}

/**
 * v44: compara cada proposta com o que o vendedor JA recebe hoje, incluindo a parte que o ML banca
 * na promocao ativa (antes o "hoje" era so preco - tarifa - frete, e a propria ativa aparecia com
 * ganho igual a parte do ML). Proposta acima do preco de hoje fica `semEfeito` (o ML aplica o menor).
 */
export function compararComOQueJaParticipa(linhas: LinhaPromocao[]): LinhaPromocao[] {
  const base = new Map<string, number>();
  for (const l of linhas) if (l.situacao === 'ativa' && l.voceRecebe != null) base.set(l.itemId, l.voceRecebe);
  return linhas.map((l) => {
    const hoje = base.get(l.itemId) ?? l.voceRecebeHoje;
    const semEfeito = l.situacao === 'proposta' && l.precoProposto != null && l.precoAtual != null && l.precoProposto > l.precoAtual + 0.005;
    const dif = semEfeito || l.voceRecebe == null || hoje == null ? null : Math.round((l.voceRecebe - hoje) * 100) / 100;
    return { ...l, voceRecebeHoje: hoje, diferencaPorVenda: l.situacao === 'ativa' ? 0 : dif, semEfeito };
  });
}

/** Propostas abertas primeiro; dentro delas, as que menos tiram de cada venda. */
export function ordenarLinhas(linhas: LinhaPromocao[]): LinhaPromocao[] {
  const ordem: Record<SituacaoPromocao, number> = { ativa: 0, programada: 1, proposta: 2, outra: 3, encerrada: 4 };
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

/**
 * v39: depois de aderir pelo painel, a linha passa a PROGRAMADA no cache na hora, sem esperar a
 * proxima varredura (o ML leva alguns minutos para refletir). A varredura seguinte confirma.
 */
export function marcarAderida(itemId: string, tipo: string, promocaoId: string | null): void {
  const r = getPromocoes();
  if (!r) return;
  const l = r.itens.find((x) => x.itemId === itemId && x.tipo === tipo && (promocaoId ? x.promocaoId === promocaoId : true) && x.situacao === 'proposta');
  if (!l) return;
  l.situacao = 'programada';
  persist({ ...r, itens: ordenarLinhas(r.itens) });
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
  const vendas30 = new Map<string, number>();
  for (const c of conv?.items ?? []) {
    vendas30.set(c.itemId, c.vendas30);
    if (c.vendas30 > 0) fretePorItem.set(c.itemId, c.frete30 / c.vendas30);
  }
  const precoDeVenda = new Map<string, number | null>();

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
  // v40: frete gratis por (anuncio, preco), pelo ML. Sem frete gratis ou se falhar: media de 30 dias.
  const fretes = new Map<string, Promise<number | null>>();
  const freteGratis = (item: MlItemAttributes, preco: number | null): Promise<number | null> => {
    if (preco == null || !item.shipping?.free_shipping) return Promise.resolve(null);
    const k = `${item.id}|${preco}`;
    if (!fretes.has(k)) fretes.set(k, getFreteGratis(item, preco).catch(() => null));
    return fretes.get(k)!;
  };

  const itens: LinhaPromocao[] = [];
  /** v46: anuncios cuja leitura de promocoes deu certo (os outros geram foto invalida) */
  const idsOk = new Set<string>();
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
    // Preco de venda de agora e qual promocao o define. Se falhar, segue com o preco cheio.
    idsOk.add(item.id);
    const venda: PrecoDeVenda | null = await getSalePriceRaw(item.id).then(parsePrecoDeVenda).catch(() => null);
    const precoCheio = num(item.price);
    const precoAtual = venda?.preco ?? precoCheio;
    precoDeVenda.set(item.id, precoAtual);
    const tarifaAtual = await tarifa(item, precoAtual);
    const freteAtual = await freteGratis(item, precoAtual);
    for (const raw of brutos) {
      const promo = normalizarPromocao(raw, precoCheio, venda ? { promocaoId: venda.promocaoAtivaId, ofertaId: venda.ofertaAtivaId } : null, venda?.preco ?? null);
      if (promo.situacao === 'encerrada') continue;
      // "Desconto proprio"/"campanha propria" como candidato e so o convite a criar um desconto seu,
      // vem em todo anuncio e nao e proposta do ML.
      // So o convite generico de "desconto proprio" (sem id nem nome) fica de fora: a tela do ML nao
      // o mostra. Campanha propria sem adesao (ex.: "OUTUBRO 2026" com botao Participar) aparece.
      if (promo.situacao === 'proposta' && promo.tipo === 'PRICE_DISCOUNT' && !promo.promocaoId && !promo.nome) continue;
      const chave = chaveDaPromocao(item.id, promo);
      vistas[chave] = anteriores[chave] ?? agora;
      const tarifaProposta = await tarifa(item, promo.precoProposto);
      const freteProposto = await freteGratis(item, promo.precoProposto);
      // Envio por conta do comprador: o vendedor nao paga frete (MLB4466707117, 2026-11-05: a tela do
      // ML nao desconta frete nenhum). A media de 30 dias so vale para quem oferece frete gratis.
      const media = item.shipping?.free_shipping === false ? 0 : fretePorItem.get(item.id) ?? null;
      itens.push(
        montarLinha(
          item,
          promo,
          { atual: tarifaAtual, proposta: tarifaProposta },
          freteAtual != null && freteProposto != null ? { media, atual: freteAtual, proposta: freteProposto } : media,
          vistas[chave],
          precoAtual,
        ),
      );
    }
  });

  const apiDisponivel = !(recusas > 0 && itens.length === 0);
  const linhasFinais = ordenarLinhas(compararComOQueJaParticipa(semRelampagoDuplicada(itens)));
  const result: PromocoesResult = {
    atualizadoEm: agora,
    apiDisponivel,
    avisoDaApi: apiDisponivel ? (erros ? `${erros} anuncio(s) nao responderam; ficaram de fora desta varredura.` : null) : avisoDaApi,
    anunciosAnalisados: attrs.length,
    anunciosComErro: erros,
    truncado: ids.length >= max,
    itens: linhasFinais,
    semPromocao: anunciosSemPromocao(attrs, idsOk, linhasFinais, vendas30, precoDeVenda),
    vistas,
  };
  persist(result);
  if (apiDisponivel) registrarFotos(result, attrs, idsOk, agora);
  logger.info(
    `[PROMOCOES] ${attrs.length} anuncios, ${result.itens.filter((i) => i.situacao === 'proposta').length} proposta(s) abertas, ${erros} erro(s).`,
  );
  return result;
}

/**
 * v46: grava o historico de fotos. Nunca derruba a varredura: sem banco (ou com erro), o painel
 * segue como na v45 e o bloco novo mostra "historico indisponivel".
 */
function registrarFotos(result: PromocoesResult, attrs: MlItemAttributes[], idsOk: Set<string>, tiradaEm: string): void {
  try {
    if (!bancoDisponivel()) {
      logger.warn('[PROMOCOES] Banco indisponivel: fotos de promocoes nao gravadas.');
      return;
    }
    const cc = getCatalogCompetition();
    const buybox = (id: string) => {
      const c = cc?.items.find((x) => x.itemId === id);
      return c
        ? { situacao: c.situacao ?? null, statusMl: c.statusMl ?? null, precoParaGanhar: c.precoParaGanhar ?? null, atualizadoEm: cc?.updatedAt ?? null }
        : null;
    };
    const fotos = montarFotos({ tiradaEm, itens: result.itens, anuncios: attrs, idsOk, truncado: result.truncado, buybox });
    const r = gravarFotosDePromocoes(fotos, config.promocoesFotosRetencaoDias);
    logger.info(`[PROMOCOES] ${r.gravadas} foto(s) gravada(s)${r.apagadas ? `, ${r.apagadas} antiga(s) apagada(s)` : ''}.`);
  } catch (err: any) {
    logger.warn('[PROMOCOES] Falha ao gravar as fotos de promocoes:', err?.message || err);
  }
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
