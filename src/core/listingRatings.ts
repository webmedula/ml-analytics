import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemsAttributes, getRating, getSellerItemIds, MlItemAttributes, MlRating } from '../ml/mlClient';

/**
 * DIAGNOSTICO DE NOTA POR ANUNCIO — fase 1 da funcionalidade de recriacao de anuncios.
 *
 * Premissa que este modulo existe pra TESTAR, nao pra assumir: recriar um anuncio so zera a nota
 * se as opinioes estiverem presas ao ITEM (MLB). Quando o anuncio e de catalogo — ou e da lista
 * geral mas o ML o sincronizou com um produto de catalogo — as opinioes moram no PRODUTO e sao
 * compartilhadas com os concorrentes: o anuncio novo ja nasce com as mesmas estrelas e recriar so
 * joga fora historico de vendas e posicionamento.
 *
 * A checagem e empirica e usa o campo `secondary_key` que vem DENTRO de cada review: ele e a chave
 * sob a qual o ML agrupa aquelas opinioes. Comecando com MLBU, o pool e o produto do usuario (so
 * seus anuncios); comecando com MLB, e o produto de catalogo, dividido com concorrentes.
 *
 * Este modulo nao altera NADA no Mercado Livre — e leitura pura.
 */

export type ClassificacaoRecriacao =
  | 'recriavel'
  | 'depende_do_user_product'
  | 'preso_ao_catalogo'
  | 'indefinido'
  | 'poucas_opinioes'
  | 'nota_ok'
  | 'sem_opinioes'
  | 'sem_dados';

export interface EntradaClassificacao {
  itemId?: string;
  catalogListing?: boolean;
  catalogProductId?: string | null;
  notaItem: number | null;
  totalItem: number | null;
  /** Chave sob a qual o ML agrupa as opinioes (`secondary_key` do review). */
  chaveDoPool?: string | null;
  /** `catalog_listing` de dentro do review: aquele pool e de catalogo? */
  poolDeCatalogo?: boolean | null;
  /** MLB a que o primeiro review pertence — se for outro, o pool e compartilhado. */
  anuncioDoPrimeiroReview?: string | null;
  /** Nota minima aceitavel (abaixo disso o anuncio vira candidato). */
  limite: number;
  /** Minimo de opinioes pra levar a nota a serio (1 review ruim se dilui sozinha com o tempo). */
  minOpinioes: number;
}

/** Ids de produto do usuario comecam com MLBU; os de catalogo, com MLB seguido de digito. */
export function ehUserProduct(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^[A-Z]{3}U\d+$/.test(id);
}

export interface Classificacao {
  classificacao: ClassificacaoRecriacao;
  evidencia: string;
}

/**
 * Decide se recriar o anuncio zeraria a nota. Funcao PURA — e o coracao testavel da feature.
 *
 * COMO ISSO FOI DESCOBERTO (2026-08-20, dados reais da conta):
 *
 * A versao anterior comparava a nota buscada pelo id do ANUNCIO com a buscada pelo id do PRODUTO
 * de catalogo. Isso NUNCA funcionou: `/reviews/item/{productId}` responde
 * "not found item id MLB19872191" — a rota so aceita id de anuncio. O resultado e que todo anuncio
 * de catalogo caia em 'indefinido' e a comparacao jamais decidia nada.
 *
 * O sinal certo estava dentro da propria resposta, no primeiro review:
 *
 *   Balanca  MLB4196542749 (catalogo)     -> secondary_key MLB19872191   catalog_listing true
 *                                            1864 opinioes, e o primeiro review pertence a
 *                                            MLB3004510105 — anuncio de OUTRO vendedor.
 *   Tic-tac  MLB4881096643 (lista geral)  -> secondary_key MLBU4275986047 catalog_listing false
 *                                            1 opiniao, do proprio MLB4881096643.
 *
 * Ou seja: `secondary_key` E a chave do pool de opinioes. MLB... = produto de catalogo, dividido
 * com concorrentes. MLBU... = produto do usuario, so seus anuncios.
 */
export function classificarAnuncio(e: EntradaClassificacao): Classificacao {
  const nota = e.notaItem;
  const total = e.totalItem;

  if (nota == null && total == null) {
    return { classificacao: 'sem_dados', evidencia: 'A API de avaliacoes nao respondeu para este anuncio.' };
  }
  if (total != null && total <= 0) {
    return { classificacao: 'sem_opinioes', evidencia: 'Anuncio ainda sem opinioes registradas.' };
  }
  if (nota == null) {
    return { classificacao: 'sem_dados', evidencia: 'Total de opinioes disponivel, mas sem nota media na resposta do ML.' };
  }
  if (nota >= e.limite) {
    return { classificacao: 'nota_ok', evidencia: `Nota ${nota.toFixed(1)} >= limite ${e.limite.toFixed(1)}.` };
  }
  if (total != null && total < e.minOpinioes) {
    return {
      classificacao: 'poucas_opinioes',
      evidencia: `Nota ${nota.toFixed(1)}, mas so ${total} opiniao(oes) — abaixo do minimo de ${e.minOpinioes} para agir.`,
    };
  }

  // Nota baixa e relevante. Onde mora esse pool de opinioes?

  // 1. Evidencia mais forte: o primeiro review pertence a um anuncio de OUTRO vendedor.
  //    Isso e prova direta de pool compartilhado — nao ha o que recriar.
  if (e.anuncioDoPrimeiroReview && e.itemId && e.anuncioDoPrimeiroReview !== e.itemId) {
    return {
      classificacao: 'preso_ao_catalogo',
      evidencia:
        `As opinioes vem de um pool compartilhado: a primeira pertence ao anuncio ${e.anuncioDoPrimeiroReview}, ` +
        'que nao e este. Recriar nao zera.',
    };
  }

  // 2. O proprio review diz que o pool e de catalogo.
  if (e.poolDeCatalogo === true || (e.chaveDoPool && !ehUserProduct(e.chaveDoPool))) {
    return {
      classificacao: 'preso_ao_catalogo',
      evidencia:
        `As opinioes estao agrupadas no produto de catalogo ${e.chaveDoPool ?? e.catalogProductId ?? '(id nao informado)'}, ` +
        'dividido com os concorrentes. Recriar nao zera.',
    };
  }

  // 3. Atributos do anuncio confirmam catalogo, mesmo sem o sinal do review.
  if (e.catalogListing === true || e.catalogProductId) {
    return {
      classificacao: 'preso_ao_catalogo',
      evidencia: 'Anuncio vinculado ao catalogo: a opiniao pertence ao produto compartilhado. Recriar nao zera.',
    };
  }

  // 4. Pool no produto do usuario. Aqui a opiniao e SO SUA — mas zerar depende de o anuncio novo
  //    receber um MLBU novo em vez de ser reagrupado no mesmo. Isso o ML decide pelos atributos
  //    (marca, modelo, GTIN) e NAO esta confirmado. Nao prometemos o que nao sabemos.
  if (ehUserProduct(e.chaveDoPool)) {
    return {
      classificacao: 'depende_do_user_product',
      evidencia:
        `As opinioes sao suas, agrupadas no produto do usuario ${e.chaveDoPool}. Recriar so zera se o anuncio ` +
        'novo receber um produto do usuario diferente — o que precisa ser verificado antes da virada.',
    };
  }

  // 5. Sem produto nenhum e o review e do proprio anuncio: caso limpo.
  if (!e.catalogProductId && !e.chaveDoPool) {
    return {
      classificacao: 'recriavel',
      evidencia: 'Anuncio da lista geral sem produto vinculado: a opiniao mora no proprio MLB. Recriar zera.',
    };
  }

  return {
    classificacao: 'indefinido',
    evidencia: 'Nao foi possivel determinar onde as opinioes deste anuncio estao agrupadas.',
  };
}

export interface RatingView {
  itemId: string;
  title?: string;
  permalink?: string;
  catalogListing?: boolean;
  catalogProductId?: string | null;
  nota: number | null;
  totalAvaliacoes: number | null;
  notaProduto: number | null;
  totalAvaliacoesProduto: number | null;
  /** Chave sob a qual o ML agrupa as opinioes: MLBU... = so suas; MLB... = catalogo compartilhado. */
  chaveDoPool: string | null;
  userProductId: string | null;
  classificacao: ClassificacaoRecriacao;
  evidencia: string;
  vendidos?: number;
  disponivel?: number;
  preco?: number | null;
  criadoEm?: string;
}

export type ResumoRatings = Record<ClassificacaoRecriacao, number>;

export interface RatingsResult {
  items: RatingView[];
  updatedAt: string;
  limite: number;
  minOpinioes: number;
  totalAnalisados: number;
  /** false quando NENHUM anuncio devolveu nota: o app do ML nao tem acesso ao recurso de opinioes. */
  apiDeAvaliacoesDisponivel: boolean;
  /** Rota que respondeu (quando alguma respondeu) — ajuda a diagnosticar permissoes. */
  rotaUsada: string | null;
  resumo: ResumoRatings;
  truncado: boolean;
}

const ORDEM: Record<ClassificacaoRecriacao, number> = {
  recriavel: 0,
  depende_do_user_product: 1,
  indefinido: 2,
  preso_ao_catalogo: 3,
  poucas_opinioes: 4,
  nota_ok: 5,
  sem_opinioes: 6,
  sem_dados: 7,
};

/** Recriaveis primeiro e, dentro de cada grupo, a pior nota na frente. */
export function ordenarRatings(views: RatingView[]): RatingView[] {
  return [...views].sort((a, b) => {
    if (ORDEM[a.classificacao] !== ORDEM[b.classificacao]) return ORDEM[a.classificacao] - ORDEM[b.classificacao];
    return (a.nota ?? Infinity) - (b.nota ?? Infinity);
  });
}

export function resumir(views: RatingView[]): ResumoRatings {
  const base: ResumoRatings = {
    recriavel: 0, depende_do_user_product: 0, preso_ao_catalogo: 0, indefinido: 0, poucas_opinioes: 0,
    nota_ok: 0, sem_opinioes: 0, sem_dados: 0,
  };
  for (const v of views) base[v.classificacao]++;
  return base;
}

// --- cache em arquivo (a varredura e cara: ate 2 chamadas por anuncio) ---
let cached: RatingsResult | null = null;

function ensureDir(): void {
  const dir = path.dirname(config.ratingsCachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist(result: RatingsResult): void {
  ensureDir();
  cached = result;
  const tmp = config.ratingsCachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  fs.renameSync(tmp, config.ratingsCachePath);
}

export function getListingRatings(): RatingsResult | null {
  if (cached) return cached;
  try {
    if (fs.existsSync(config.ratingsCachePath)) cached = JSON.parse(fs.readFileSync(config.ratingsCachePath, 'utf-8'));
  } catch {
    cached = null;
  }
  return cached;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let scanInFlight: Promise<RatingsResult> | null = null;

export function refreshListingRatings(): Promise<RatingsResult> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = doScan().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

/** Monta a linha de um anuncio a partir dos atributos + as duas leituras de nota. Pura (testavel). */
export function buildRatingView(
  item: MlItemAttributes,
  ratingItem: MlRating | null,
  ratingProduto: MlRating | null,
  limite: number,
  minOpinioes: number,
): RatingView {
  const { classificacao, evidencia } = classificarAnuncio({
    itemId: item.id,
    catalogListing: item.catalog_listing,
    catalogProductId: item.catalog_product_id ?? null,
    notaItem: ratingItem?.ratingAverage ?? null,
    totalItem: ratingItem?.total ?? null,
    chaveDoPool: ratingItem?.chaveDoPool ?? null,
    poolDeCatalogo: ratingItem?.poolDeCatalogo ?? null,
    anuncioDoPrimeiroReview: ratingItem?.anuncioDoPrimeiroReview ?? null,
    limite,
    minOpinioes,
  });

  return {
    itemId: item.id,
    title: item.title,
    permalink: item.permalink,
    catalogListing: item.catalog_listing,
    catalogProductId: item.catalog_product_id ?? null,
    nota: ratingItem?.ratingAverage ?? null,
    totalAvaliacoes: ratingItem?.total ?? null,
    notaProduto: ratingProduto?.ratingAverage ?? null,
    totalAvaliacoesProduto: ratingProduto?.total ?? null,
    chaveDoPool: ratingItem?.chaveDoPool ?? null,
    userProductId: ratingItem?.userProductId ?? null,
    classificacao,
    evidencia,
    vendidos: item.sold_quantity,
    disponivel: item.available_quantity,
    preco: item.price ?? null,
    criadoEm: item.date_created,
  };
}

async function doScan(): Promise<RatingsResult> {
  if (!getMlAuthStatus().authenticated) {
    throw new Error('Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.');
  }

  const limite = config.ratingsMinScore;
  const minOpinioes = config.ratingsMinReviews;
  const max = config.ratingsScanMaxItems;

  // TODOS os anuncios ativos, nao so os de catalogo: os candidatos reais a recriacao sao
  // justamente os da lista geral, que a analise de Buy Box nem enxerga.
  const ids = await getSellerItemIds(max, false);
  const truncado = ids.length >= max;
  logger.info(`[NOTAS] ${ids.length} anuncios ativos (teto ${max}${truncado ? ', truncado' : ''}).`);

  const attrs = await getItemsAttributes(ids);

  let rotaUsada: string | null = null;

  const views: RatingView[] = [];
  for (const item of attrs) {
    try {
      const ratingItem = await getRating(item.id);
      if (ratingItem && !rotaUsada) rotaUsada = ratingItem.rota;

      // NAO buscamos mais a nota pelo id do produto de catalogo: /reviews/item/{productId}
      // responde "not found item id". O sinal de onde o pool mora vem dentro da propria resposta
      // do anuncio (secondary_key / catalog_listing do review).
      views.push(buildRatingView(item, ratingItem, null, limite, minOpinioes));
    } catch (err: any) {
      logger.warn(`[NOTAS] Falha ao avaliar o anuncio ${item.id}:`, err?.message || err);
    }
    await sleep(150); // respeita a cota do ML
  }

  const ordenados = ordenarRatings(views);
  const resumo = resumir(ordenados);
  const result: RatingsResult = {
    items: ordenados,
    updatedAt: new Date().toISOString(),
    limite,
    minOpinioes,
    totalAnalisados: ordenados.length,
    apiDeAvaliacoesDisponivel: ordenados.some((v) => v.nota != null || v.notaProduto != null),
    rotaUsada,
    resumo,
    truncado,
  };
  persist(result);

  if (!result.apiDeAvaliacoesDisponivel) {
    logger.warn('[NOTAS] Nenhum anuncio devolveu nota: o app do ML provavelmente nao tem acesso ao recurso de opinioes.');
  } else {
    logger.info(
      `[NOTAS] Concluido: ${result.totalAnalisados} anuncios — ${resumo.recriavel} recriavel(is), ` +
      `${resumo.preso_ao_catalogo} preso(s) ao catalogo, ${resumo.indefinido} indefinido(s).`,
    );
  }
  return result;
}

export function startRatingsLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    try {
      await refreshListingRatings();
    } catch (err: any) {
      logger.warn('[NOTAS] Falha na varredura de background:', err?.message || err);
    }
  };
  setTimeout(() => run().catch((e) => logger.error('[NOTAS] Erro inicial:', e?.message || e)), 75000).unref();
  setInterval(
    () => run().catch((e) => logger.error('[NOTAS] Erro periodico:', e?.message || e)),
    Math.max(1, config.ratingsScanIntervalHours) * 60 * 60 * 1000,
  ).unref();
  logger.info(`[NOTAS] Varredura de notas em background ligada (a cada ${config.ratingsScanIntervalHours}h).`);
}
