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
}

/** Multiget de atributos de varios itens (o ML aceita ate 20 ids por chamada em /items?ids=). */
export async function getItemsAttributes(ids: string[]): Promise<MlItemAttributes[]> {
  const attrs = 'id,title,price,currency_id,status,catalog_listing,catalog_product_id,permalink,sold_quantity,available_quantity,seller_id';
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

/** Total de visitas por anuncio entre duas datas (YYYY-MM-DD). Usa o endpoint em lote
 * /items/visits?ids= (ate 20 ids por chamada). Retorna um mapa itemId -> total de visitas. */
export async function getVisitsForItems(ids: string[], dateFrom: string, dateTo: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const data = await mlRequest<any[]>(`/items/visits?ids=${chunk.join(',')}&date_from=${dateFrom}&date_to=${dateTo}`);
      for (const entry of data || []) {
        if (entry?.item_id) out.set(entry.item_id, Number(entry.total_visits ?? 0));
      }
    } catch (err: any) {
      logger.warn(`[VISITAS] Falha no lote de visitas:`, err?.message || err);
    }
  }
  return out;
}

/** Unidades vendidas por anuncio nos ultimos `dias` (busca pedidos NAO cancelados via /orders/search),
 * separando ja em duas janelas: total do periodo e ultimos 7 dias. */
export async function getSoldUnitsByItem(dias = 30): Promise<Map<string, { total: number; d7: number }>> {
  const sellerId = await getMlUserId();
  const now = Date.now();
  const fromIso = new Date(now - dias * 24 * 60 * 60 * 1000).toISOString();
  const corte7 = now - 7 * 24 * 60 * 60 * 1000;

  const out = new Map<string, { total: number; d7: number }>();
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
        const q = Number(it.quantity ?? 0);
        const cur = out.get(id) || { total: 0, d7: 0 };
        cur.total += q;
        if (dentro7) cur.d7 += q;
        out.set(id, cur);
      }
    }
    offset += limit;
    const total = data.paging?.total ?? out.size;
    if (orders.length === 0 || offset >= total || offset >= MAX) break;
  }
  return out;
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

/** Tenta ler as avaliacoes (nota media + total) de um anuncio pela API oficial do ML. O ML
 * restringiu esse recurso; retorna null se nao houver acesso. Duas rotas conhecidas sao tentadas. */
export async function getItemRating(itemId: string): Promise<{ ratingAverage: number | null; total: number | null } | null> {
  try {
    const r = await mlRequest<any>(`/reviews/item/${itemId}`);
    const avg = r?.rating_average ?? r?.paging?.rating_average ?? null;
    const total = r?.paging?.total ?? r?.total ?? (Array.isArray(r?.reviews) ? r.reviews.length : null);
    if (avg != null || total != null) return { ratingAverage: avg != null ? Number(avg) : null, total: total != null ? Number(total) : null };
    return null;
  } catch {
    return null;
  }
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

  return { itemId, catalogProductId: productId ?? null, attr: attr ?? null, priceToWin, product, winnerItemId: winnerItemId ?? null, winnerViaMultiget, winnerViaSingle, reviewsViaItem, reviewsViaSearch, reviewsViaProduct };
}
