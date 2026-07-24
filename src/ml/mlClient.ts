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

export interface MlPriceToWin {
  item_id?: string;
  status?: string; // 'winning' | 'competing' | 'sharing_first_place' | 'listed' | ...
  current_price?: number | null;
  currency_id?: string;
  price_to_win?: number | null;
  competitors_sharing_first_place?: number;
  visit_share?: string | number | null;
  boosts?: unknown;
  winner?: { item_id?: string; price?: number | null; currency_id?: string; seller_id?: number } | null;
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

/** Diagnostico: devolve as respostas CRUAS do ML pra um anuncio (atributos + price_to_win + produto). */
export async function debugItemRaw(itemId: string): Promise<any> {
  const [attr] = await getItemsAttributes([itemId]);
  const priceToWin = await getPriceToWin(itemId).catch((e) => ({ erro: String(e?.message || e) }));
  let product: any = null;
  const productId = attr?.catalog_product_id;
  if (productId) product = await getCatalogProduct(productId).catch((e) => ({ erro: String(e?.message || e) }));
  return { itemId, catalogProductId: productId ?? null, attr: attr ?? null, priceToWin, product };
}
