import { config } from '../config';
import { logger } from '../logger';
import { ensureValidMlToken } from './mlOauthClient';

export class MlApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MlApiError';
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_429_RETRIES = 2;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MlApiError(504, `Chamada a API do Mercado Livre excedeu ${REQUEST_TIMEOUT_MS / 1000}s sem resposta`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Chamada generica GET contra a API do Mercado Livre (Bearer OAuth2), com retry de 401/429. */
async function mlRequest<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
  let retried401 = false;
  let rateLimitRetries = 0;

  for (;;) {
    const token = await ensureValidMlToken();
    const url = `${config.mlApiBaseUrl}${path}`;

    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    });

    if (res.status === 401 && !retried401) {
      retried401 = true;
      logger.warn('[ML API] 401 recebido, tentando renovar token e repetir a chamada...');
      continue;
    }

    if (res.status === 429 && rateLimitRetries < MAX_429_RETRIES) {
      rateLimitRetries++;
      await sleep(1500 * rateLimitRetries);
      continue;
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      const mensagem = data?.message || `Erro HTTP ${res.status}`;
      throw new MlApiError(res.status, mensagem);
    }

    return data as T;
  }
}

/** Retorna o id numerico do usuario/seller autenticado no Mercado Livre. */
export async function getMlUserId(): Promise<number> {
  const me = await mlRequest<{ id: number }>('/users/me');
  return me.id;
}

/**
 * Lista ids de anuncio do seller autenticado (paginado). O ML limita offset+limit a 1000 no modo
 * padrao; paramos em `max`. onlyCatalog tenta filtrar direto na API; a checagem por atributo em
 * getItemsAttributes garante a corretude depois.
 */
export async function getSellerItemIds(max = 500, onlyCatalog = true): Promise<string[]> {
  const sellerId = await getMlUserId();
  const limit = 100;
  let offset = 0;
  const ids: string[] = [];

  for (;;) {
    const filtro = onlyCatalog ? '&catalog_listing=true' : '';
    const data = await mlRequest<{ results: string[]; paging?: { total?: number } }>(
      `/users/${sellerId}/items/search?status=active&limit=${limit}&offset=${offset}${filtro}`,
    );
    const results = data.results || [];
    ids.push(...results);
    offset += limit;
    const total = data.paging?.total ?? ids.length;
    if (results.length === 0 || ids.length >= max || offset >= total || offset >= 1000) break;
  }

  return ids.slice(0, max);
}

export interface MlItemAttributes {
  id: string;
  title?: string;
  price?: number | null;
  currency_id?: string;
  status?: string;
  catalog_listing?: boolean;
  catalog_product_id?: string | null;
  permalink?: string;
  sold_quantity?: number;
  available_quantity?: number;
  seller_id?: number;
  /** Data de criacao do anuncio — usada pra pesar a idade/historico antes de recriar. */
  date_created?: string;
  /** Qualidade do anuncio (0-1) segundo o ML. */
  health?: number | null;
}

/** Multiget de atributos de varios itens (o ML aceita ate 20 ids por chamada em /items?ids=). */
export async function getItemsAttributes(ids: string[]): Promise<MlItemAttributes[]> {
  const attrs = 'id,title,price,currency_id,status,catalog_listing,catalog_product_id,permalink,sold_quantity,available_quantity,seller_id,date_created,health';
  const out: MlItemAttributes[] = [];

  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const data = await mlRequest<Array<{ code: number; body: MlItemAttributes }>>(
      `/items?ids=${chunk.join(',')}&attributes=${attrs}`,
    );
    for (const entry of data || []) {
      if (entry?.code === 200 && entry.body?.id) out.push(entry.body);
    }
  }

  return out;
}

/** Apelido (nickname) publico de um vendedor no Mercado Livre — usado pra mostrar QUEM ganhou o Buy Box. */
export async function getSellerNickname(sellerId: number): Promise<string | null> {
  try {
    const u = await mlRequest<{ nickname?: string }>(`/users/${sellerId}`);
    return u?.nickname ?? null;
  } catch {
    return null;
  }
}

/** Vantagem que ajuda a ganhar o Buy Box (frete gratis, Full, parcelamento, mesmo dia...).
 * status: 'boosted' = o anuncio JA tem; 'opportunity' = NAO tem (poderia ganhar). */
export interface MlBoost {
  id: string;
  status?: string;
  description?: string;
}

export interface MlPriceToWin {
  item_id?: string;
  status?: string; // 'winning' | 'competing' | 'sharing_first_place' | 'listed' | ...
  current_price?: number | null;
  currency_id?: string;
  price_to_win?: number | null;
  competitors_sharing_first_place?: number;
  visit_share?: string | number | null;
  /** Vantagens do SEU anuncio (o que voce tem = boosted, o que falta = opportunity). */
  boosts?: MlBoost[];
  winner?: { item_id?: string; price?: number | null; currency_id?: string; seller_id?: number; boosts?: MlBoost[] } | null;
  reason?: unknown;
}

/** Situacao do anuncio na disputa do catalogo (Buy Box) e preco necessario pra ganhar. */
export async function getPriceToWin(itemId: string): Promise<MlPriceToWin> {
  return mlRequest<MlPriceToWin>(`/items/${itemId}/price_to_win?version=v2`);
}

/** Produto de catalogo (traz o buy_box_winner: quem esta ganhando a pagina, com item/seller/preco). */
export async function getCatalogProduct(productId: string): Promise<any> {
  return mlRequest<any>(`/products/${productId}`);
}

/**
 * Visitas por anuncio nas janelas de 30 e 7 dias, via /items/{id}/visits/time_window (1 chamada
 * por anuncio, mas confiavel). A chamada com last=30&unit=day ja traz o detalhe diario dos 30
 * dias: somamos tudo pra 30d e so os ultimos 7 dias pra 7d. Retorna itemId -> { v30, v7 }.
 */
export async function getVisitsWindows(ids: string[]): Promise<Map<string, { v30: number; v7: number }>> {
  const out = new Map<string, { v30: number; v7: number }>();
  const corte7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const id of ids) {
    try {
      const data = await mlRequest<any>(`/items/${id}/visits/time_window?last=30&unit=day`);
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      let v30 = Number(data?.total_visits ?? 0);
      if (!v30 && results.length) v30 = results.reduce((s, r) => s + Number(r.total ?? 0), 0);
      let v7 = 0;
      for (const r of results) {
        const t = new Date(r.date).getTime();
        if (Number.isFinite(t) && t >= corte7) v7 += Number(r.total ?? 0);
      }
      out.set(id, { v30, v7 });
    } catch (err: any) {
      logger.warn(`[VISITAS] Falha nas visitas do item ${id}:`, err?.message || err);
    }
    await sleep(60);
  }
  return out;
}

export interface VendasDoAnuncio {
  /** unidades no periodo inteiro e nos ultimos 7 dias */
  unidades: number;
  unidadesD7: number;
  /** preco x quantidade, antes de qualquer desconto */
  bruto: number;
  brutoD7: number;
  /** comissao REAL cobrada pelo ML (sale_fee dos itens), nao estimada por tabela */
  comissao: number;
  comissaoD7: number;
  /** quantos itens do periodo nao trouxeram sale_fee — se >0, a comissao esta subestimada */
  itensSemComissao: number;
}

function vazio(): VendasDoAnuncio {
  return { unidades: 0, unidadesD7: 0, bruto: 0, brutoD7: 0, comissao: 0, comissaoD7: 0, itensSemComissao: 0 };
}

/**
 * Vendas por anuncio nos ultimos `dias`, em DINHEIRO e em unidades, separando ja duas janelas.
 *
 * A comissao vem de `order_items[].sale_fee`, que e o valor que o ML de fato cobrou naquela venda —
 * melhor que estimar por tabela de categoria, porque promocao, tipo de anuncio e frete gratis mudam
 * a conta. O ML documenta sale_fee como valor POR UNIDADE, entao multiplicamos pela quantidade;
 * `/debug/order` existe pra conferir isso contra um pedido real da conta.
 *
 * NAO inclui frete pago pelo vendedor: esse dado exige uma chamada por envio
 * (/shipments/{id}/costs) e sairia caro numa varredura de 30 dias. Fica pra uma camada separada.
 */
export async function getSalesByItem(dias = 30): Promise<Map<string, VendasDoAnuncio>> {
  const sellerId = await getMlUserId();
  const now = Date.now();
  const fromIso = new Date(now - dias * 24 * 60 * 60 * 1000).toISOString();
  const corte7 = now - 7 * 24 * 60 * 60 * 1000;

  const out = new Map<string, VendasDoAnuncio>();
  const limit = 50;
  let offset = 0;
  const MAX = 4000;

  for (;;) {
    const data = await mlRequest<{ results?: any[]; paging?: { total?: number } }>(
      `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(fromIso)}&sort=date_desc&limit=${limit}&offset=${offset}`,
    );
    const orders = data.results || [];
    for (const o of orders) {
      if (String(o.status) === 'cancelled') continue;
      const dt = new Date(o.date_created).getTime();
      const dentro7 = Number.isFinite(dt) && dt >= corte7;

      for (const it of o.order_items || []) {
        const id = it?.item?.id;
        if (!id) continue;

        const qtd = Number(it.quantity ?? 0);
        const preco = Number(it.unit_price ?? 0);
        const bruto = preco * qtd;
        const temFee = it.sale_fee != null && Number.isFinite(Number(it.sale_fee));
        const comissao = temFee ? Number(it.sale_fee) * qtd : 0;

        const cur = out.get(id) || vazio();
        cur.unidades += qtd;
        cur.bruto += bruto;
        cur.comissao += comissao;
        if (!temFee) cur.itensSemComissao += 1;
        if (dentro7) {
          cur.unidadesD7 += qtd;
          cur.brutoD7 += bruto;
          cur.comissaoD7 += comissao;
        }
        out.set(id, cur);
      }
    }
    offset += limit;
    const total = data.paging?.total ?? out.size;
    if (orders.length === 0 || offset >= total || offset >= MAX) break;
  }
  return out;
}

/** Compatibilidade: so as unidades, derivadas do mesmo varrimento. */
export async function getSoldUnitsByItem(dias = 30): Promise<Map<string, { total: number; d7: number }>> {
  const vendas = await getSalesByItem(dias);
  const out = new Map<string, { total: number; d7: number }>();
  for (const [id, v] of vendas) out.set(id, { total: v.unidades, d7: v.unidadesD7 });
  return out;
}

/** Pedido mais recente, cru — pra conferir o significado de sale_fee contra um dado real. */
export async function getUltimoPedidoBruto(): Promise<any> {
  const sellerId = await getMlUserId();
  const data = await mlRequest<{ results?: any[] }>(`/orders/search?seller=${sellerId}&sort=date_desc&limit=1`);
  return data?.results?.[0] ?? null;
}

export interface MlQuestion {
  id: number;
  text: string;
  itemId: string;
  dateCreated: string;
  /** preenchido depois com o titulo/permalink do anuncio perguntado. */
  itemTitle?: string;
  permalink?: string;
}

/** Perguntas SEM resposta recebidas pelo vendedor (exige permissao de Perguntas no app do ML).
 * Ja preenche o titulo/permalink do anuncio de cada pergunta (multiget dos itens, em lote). */
export async function getUnansweredQuestions(max = 100): Promise<MlQuestion[]> {
  const sellerId = await getMlUserId();
  const limit = 50;
  let offset = 0;
  const out: MlQuestion[] = [];

  for (;;) {
    const data = await mlRequest<{ questions?: any[]; total?: number }>(
      `/questions/search?seller_id=${sellerId}&status=UNANSWERED&sort_fields=date_created&sort_types=DESC&limit=${limit}&offset=${offset}`,
    );
    const qs = data.questions || [];
    for (const q of qs) out.push({ id: q.id, text: q.text ?? '', itemId: q.item_id, dateCreated: q.date_created });
    offset += limit;
    const total = data.total ?? out.length;
    if (qs.length === 0 || out.length >= max || offset >= total) break;
  }

  const ids = Array.from(new Set(out.map((q) => q.itemId).filter(Boolean)));
  if (ids.length > 0) {
    const attrs = new Map<string, MlItemAttributes>();
    try {
      for (const it of await getItemsAttributes(ids)) attrs.set(it.id, it);
    } catch {
      // sem titulos: segue so com o id
    }
    for (const q of out) {
      const a = attrs.get(q.itemId);
      q.itemTitle = a?.title;
      q.permalink = a?.permalink;
    }
  }

  return out.slice(0, max);
}

export interface MlRating {
  ratingAverage: number | null;
  total: number | null;
  /** Qual rota da API respondeu — util pra diagnosticar acesso restrito. */
  rota: string;
  /** Produto do usuario (MLBU...) sob o qual o ML agrupa as opinioes deste anuncio. */
  userProductId: string | null;
  /**
   * A CHAVE DE AGRUPAMENTO das opinioes, lida do proprio review (`secondary_key`).
   * - Comeca com MLBU -> o pool e o produto do usuario (so seus anuncios).
   * - Comeca com MLB (sem U) -> o pool e o produto de CATALOGO, dividido com concorrentes.
   * Descoberto empiricamente em 2026-08-20; ver o comentario em classificarAnuncio.
   */
  chaveDoPool: string | null;
  /** `catalog_listing` que vem DENTRO do review: diz se aquele pool e de catalogo. */
  poolDeCatalogo: boolean | null;
  /** O anuncio a que o primeiro review pertence. Se for de OUTRO MLB, o pool e compartilhado. */
  anuncioDoPrimeiroReview: string | null;
}

/** Extrai nota media e total de opinioes das varias formas que o ML ja usou nessa resposta. */
export function parseRatingPayload(r: any): { ratingAverage: number | null; total: number | null } | null {
  if (!r || typeof r !== 'object') return null;
  const avgRaw = r.rating_average ?? r.paging?.rating_average ?? r.reviews_summary?.rating_average ?? null;
  const totalRaw = r.paging?.total ?? r.total ?? r.reviews_summary?.total ?? (Array.isArray(r.reviews) ? r.reviews.length : null);
  const ratingAverage = avgRaw != null && Number.isFinite(Number(avgRaw)) ? Number(avgRaw) : null;
  const total = totalRaw != null && Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null;
  if (ratingAverage == null && total == null) return null;
  return { ratingAverage, total };
}

/** Le, do primeiro review da resposta, a chave sob a qual o ML agrupa aquelas opinioes. */
export function parsePoolPayload(r: any): Pick<MlRating, 'userProductId' | 'chaveDoPool' | 'poolDeCatalogo' | 'anuncioDoPrimeiroReview'> {
  const primeiro = Array.isArray(r?.reviews) && r.reviews.length > 0 ? r.reviews[0] : null;
  return {
    userProductId: r?.user_product_id ?? null,
    chaveDoPool: primeiro?.secondary_key ?? null,
    poolDeCatalogo: typeof primeiro?.catalog_listing === 'boolean' ? primeiro.catalog_listing : null,
    anuncioDoPrimeiroReview: primeiro?.reviewable_object?.id ?? null,
  };
}

/**
 * Le as avaliacoes (nota media + total) de um id — que pode ser um ANUNCIO (MLB...) ou um PRODUTO
 * de catalogo (MLB...). O ML restringiu esse recurso; tentamos as duas rotas conhecidas e
 * devolvemos null se nenhuma responder. A rota que funcionou volta junto, pro diagnostico.
 */
export async function getRating(id: string): Promise<MlRating | null> {
  const rotas = [`/reviews/item/${id}`, `/reviews/search?item_id=${id}`];
  for (const rota of rotas) {
    try {
      const bruto = await mlRequest<any>(rota);
      const parsed = parseRatingPayload(bruto);
      if (parsed) return { ...parsed, rota, ...parsePoolPayload(bruto) };
    } catch {
      // rota indisponivel nessa conta/app — tenta a proxima
    }
  }
  return null;
}

/** Compatibilidade: nota media + total de um anuncio (sem a rota). */
export async function getItemRating(itemId: string): Promise<{ ratingAverage: number | null; total: number | null } | null> {
  const r = await getRating(itemId);
  return r ? { ratingAverage: r.ratingAverage, total: r.total } : null;
}

/** Diagnostico: devolve as respostas CRUAS do ML pra um anuncio (atributos + price_to_win +
 * produto + o anuncio do concorrente vencedor, pra confirmar se da pra pegar o vendedor dele). */
export async function debugItemRaw(itemId: string): Promise<any> {
  const [attr] = await getItemsAttributes([itemId]);
  const priceToWin: any = await getPriceToWin(itemId).catch((e) => ({ erro: String(e?.message || e) }));
  let product: any = null;
  const productId = attr?.catalog_product_id;
  if (productId) product = await getCatalogProduct(productId).catch((e) => ({ erro: String(e?.message || e) }));

  // Tenta buscar o anuncio do vencedor (item de OUTRO vendedor) — 2 formas, pra ver qual devolve
  // seller_id/permalink na sua conta.
  const winnerItemId = priceToWin?.winner?.item_id;
  let winnerViaMultiget: any = null;
  let winnerViaSingle: any = null;
  if (winnerItemId) {
    winnerViaMultiget = (await getItemsAttributes([winnerItemId]).catch((e) => [{ erro: String(e?.message || e) }]))[0] ?? null;
    winnerViaSingle = await mlRequest<any>(`/items/${winnerItemId}`).catch((e) => ({ erro: String(e?.message || e) }));
  }
  // Sondagem de AVALIACOES: tenta as rotas conhecidas de reviews pra ver se a sua conta tem acesso.
  const reviewsViaItem = await mlRequest<any>(`/reviews/item/${itemId}`).catch((e) => ({ erro: String(e?.message || e) }));
  const reviewsViaSearch = await mlRequest<any>(`/reviews/search?item_id=${itemId}`).catch((e) => ({ erro: String(e?.message || e) }));
  const reviewsViaProduct = productId
    ? await mlRequest<any>(`/reviews/item/${productId}`).catch((e) => ({ erro: String(e?.message || e) }))
    : null;

  // Sondagem de VISITAS: duas formas, pra confirmar qual retorna dados na sua conta.
  const hoje = new Date().toISOString().slice(0, 10);
  const trintaDias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const visitsTimeWindow = await mlRequest<any>(`/items/${itemId}/visits/time_window?last=30&unit=day`).catch((e) => ({ erro: String(e?.message || e) }));
  const visitsMulti = await mlRequest<any>(`/items/visits?ids=${itemId}&date_from=${trintaDias}&date_to=${hoje}`).catch((e) => ({ erro: String(e?.message || e) }));

  return { itemId, catalogProductId: productId ?? null, attr: attr ?? null, priceToWin, product, winnerItemId: winnerItemId ?? null, winnerViaMultiget, winnerViaSingle, reviewsViaItem, reviewsViaSearch, reviewsViaProduct, visitsTimeWindow, visitsMulti };
}
