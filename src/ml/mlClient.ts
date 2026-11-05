import { config } from '../config';
import { logger } from '../logger';
import { ensureValidMlToken } from './mlOauthClient';

export class MlApiError extends Error {
  status: number;
  /** v39: corpo cru da resposta de erro (so preenchido na escrita, pra ir pro historico). */
  corpo?: unknown;
  constructor(status: number, message: string, corpo?: unknown) {
    super(message);
    this.name = 'MlApiError';
    this.status = status;
    this.corpo = corpo;
  }
  /** Motivos que o ML costuma mandar em `cause` (lista de {message} ou strings). */
  get causas(): string[] {
    const c = (this.corpo as any)?.cause;
    if (!Array.isArray(c)) return [];
    return c.map((x: any) => (typeof x === 'string' ? x : x?.message || x?.code || JSON.stringify(x))).filter(Boolean);
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
  /** gold_special (Classico), gold_pro (Premium)... — define a tarifa de venda. */
  listing_type_id?: string;
  category_id?: string;
  /** v40: modo/logistica/frete gratis — entra na conta do frete que o vendedor paga. */
  shipping?: { mode?: string; logistic_type?: string; free_shipping?: boolean } | null;
  condition?: string;
}

/** Multiget de atributos de varios itens (o ML aceita ate 20 ids por chamada em /items?ids=). */
export async function getItemsAttributes(ids: string[]): Promise<MlItemAttributes[]> {
  const attrs = 'id,title,price,currency_id,status,catalog_listing,catalog_product_id,permalink,sold_quantity,available_quantity,seller_id,date_created,health,listing_type_id,category_id,shipping,condition';
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

/**
 * SKU do anuncio — a unica ponte entre o anuncio no ML e o custo no Tiny.
 *
 * O ML guarda isso em tres lugares diferentes, por camadas historicas: `seller_custom_field` (o
 * campo antigo), o atributo `SELLER_SKU` (o atual), e dentro de cada variacao quando o anuncio tem
 * variacoes. Funcao pura pra poder testar sem rede: errar aqui nao daria erro, daria margem em
 * branco no anuncio errado.
 */
export function extrairSku(item: any): { sku: string | null; origem: string | null } {
  const limpar = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    return s.length > 0 ? s : null;
  };

  const atributo = (lista: any[] | undefined, id: string): string | null => {
    if (!Array.isArray(lista)) return null;
    const a = lista.find((x) => x?.id === id);
    return limpar(a?.value_name ?? a?.values?.[0]?.name);
  };

  const doAtributo = atributo(item?.attributes, 'SELLER_SKU');
  if (doAtributo) return { sku: doAtributo, origem: 'attributes.SELLER_SKU' };

  const doCampo = limpar(item?.seller_custom_field);
  if (doCampo) return { sku: doCampo, origem: 'seller_custom_field' };

  // Variacoes: pega a PRIMEIRA que tiver SKU, e marca a origem pra ficar claro que o anuncio tem
  // mais de um SKU e um custo unico nao representa o anuncio inteiro.
  const variacoes = Array.isArray(item?.variations) ? item.variations : [];
  for (const v of variacoes) {
    const doVar = atributo(v?.attributes, 'SELLER_SKU') ?? limpar(v?.seller_custom_field);
    if (doVar) {
      return { sku: doVar, origem: variacoes.length > 1 ? 'variacoes (multiplos SKUs)' : 'variacoes' };
    }
  }

  return { sku: null, origem: null };
}

/** Multiget so dos campos onde o SKU pode estar. Devolve itemId -> sku + de onde veio. */
export async function getItemsSkus(ids: string[]): Promise<Map<string, { sku: string | null; origem: string | null; title?: string }>> {
  const attrs = 'id,title,seller_custom_field,attributes,variations';
  const out = new Map<string, { sku: string | null; origem: string | null; title?: string }>();

  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const data = await mlRequest<Array<{ code: number; body: any }>>(
      `/items?ids=${chunk.join(',')}&attributes=${attrs}`,
    );
    for (const entry of data || []) {
      if (entry?.code === 200 && entry.body?.id) {
        const { sku, origem } = extrairSku(entry.body);
        out.set(entry.body.id, { sku, origem, title: entry.body.title });
      }
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
  /** frete pago pelo vendedor, rateado pelos itens. Preenchido so quando os envios sao resolvidos. */
  frete: number;
  freteD7: number;
}

/** Uma linha de pedido, guardada pra permitir o rateio do frete depois. */
export interface LinhaDePedido {
  shipmentId: string | null;
  itemId: string;
  valor: number;
  dentro7: boolean;

  // --- campos que so servem pro armazenamento permanente ---
  // A varredura enxerga uma janela movel de 30 dias; guardar a LINHA do pedido, com id e data,
  // transforma isso em historico de verdade — e sem chamada extra, porque o pedido ja veio inteiro.
  /** id do pedido: junto com itemId, e a chave que evita gravar a mesma venda duas vezes */
  orderId?: string;
  dataCriacao?: string;
  status?: string;
  /** o ML manda o SKU dentro do item do pedido — de graca, sem consultar o anuncio */
  sku?: string | null;
  titulo?: string | null;
  quantidade?: number;
  precoUnitario?: number;
  /** comissao POR UNIDADE, como o ML informa. null quando o pedido veio sem sale_fee. */
  saleFee?: number | null;
}

function vazio(): VendasDoAnuncio {
  return {
    unidades: 0, unidadesD7: 0, bruto: 0, brutoD7: 0, comissao: 0, comissaoD7: 0,
    itensSemComissao: 0, frete: 0, freteD7: 0,
  };
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
export async function getSalesByItem(dias = 30): Promise<{ porItem: Map<string, VendasDoAnuncio>; linhas: LinhaDePedido[] }> {
  const sellerId = await getMlUserId();
  const now = Date.now();
  const fromIso = new Date(now - dias * 24 * 60 * 60 * 1000).toISOString();
  const corte7 = now - 7 * 24 * 60 * 60 * 1000;

  const out = new Map<string, VendasDoAnuncio>();
  const linhas: LinhaDePedido[] = [];
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

      const shipmentId = o?.shipping?.id != null ? String(o.shipping.id) : null;

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
        linhas.push({
          shipmentId, itemId: id, valor: bruto, dentro7,
          orderId: String(o.id),
          dataCriacao: o.date_created,
          status: String(o.status ?? ''),
          sku: it?.item?.seller_sku ?? it?.item?.seller_custom_field ?? null,
          titulo: it?.item?.title ?? null,
          quantidade: qtd,
          precoUnitario: preco,
          saleFee: temFee ? Number(it.sale_fee) : null,
        });
      }
    }
    offset += limit;
    const total = data.paging?.total ?? out.size;
    if (orders.length === 0 || offset >= total || offset >= MAX) break;
  }
  return { porItem: out, linhas };
}

/** Compatibilidade: so as unidades, derivadas do mesmo varrimento. */
export async function getSoldUnitsByItem(dias = 30): Promise<Map<string, { total: number; d7: number }>> {
  const { porItem } = await getSalesByItem(dias);
  const out = new Map<string, { total: number; d7: number }>();
  for (const [id, v] of porItem) out.set(id, { total: v.unidades, d7: v.unidadesD7 });
  return out;
}

/**
 * DIAGNOSTICO: sale_fee e por UNIDADE ou pela LINHA inteira?
 *
 * Um pedido de quantidade 1 nao distingue as duas leituras. Mas a razao denuncia:
 *   por unidade -> sale_fee / unit_price fica constante em qualquer quantidade
 *   pela linha  -> sale_fee / (unit_price * quantidade) e que fica constante
 *
 * Varre os pedidos recentes, separa por quantidade e devolve as duas razoes. Se o calculo estiver
 * errado, o liquido erra por um fator igual a quantidade — e passa despercebido justamente porque
 * a maioria dos pedidos tem quantidade 1.
 */
export async function diagnosticarSaleFee(dias = 90): Promise<any> {
  const sellerId = await getMlUserId();
  const fromIso = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const linhas: Array<{ pedido: string; item: string; qtd: number; unit: number; fee: number; sobreUnit: number; sobreLinha: number }> = [];
  const limit = 50;
  let offset = 0;

  for (;;) {
    const data = await mlRequest<{ results?: any[]; paging?: { total?: number } }>(
      `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(fromIso)}&sort=date_desc&limit=${limit}&offset=${offset}`,
    );
    const orders = data.results || [];
    for (const o of orders) {
      if (String(o.status) === 'cancelled') continue;
      for (const it of o.order_items || []) {
        const qtd = Number(it.quantity ?? 0);
        const unit = Number(it.unit_price ?? 0);
        const fee = Number(it.sale_fee ?? NaN);
        if (!qtd || !unit || !Number.isFinite(fee)) continue;
        linhas.push({
          pedido: String(o.id),
          item: it?.item?.id,
          qtd,
          unit: Math.round(unit * 100) / 100,
          fee: Math.round(fee * 100) / 100,
          sobreUnit: Math.round((fee / unit) * 10000) / 100,
          sobreLinha: Math.round((fee / (unit * qtd)) * 10000) / 100,
        });
      }
    }
    offset += limit;
    const total = data.paging?.total ?? linhas.length;
    if (orders.length === 0 || offset >= total || offset >= 2000) break;
  }

  const porQtd = new Map<number, { n: number; somaSobreUnit: number; somaSobreLinha: number }>();
  for (const l of linhas) {
    const cur = porQtd.get(l.qtd) || { n: 0, somaSobreUnit: 0, somaSobreLinha: 0 };
    cur.n++;
    cur.somaSobreUnit += l.sobreUnit;
    cur.somaSobreLinha += l.sobreLinha;
    porQtd.set(l.qtd, cur);
  }

  const resumo = Array.from(porQtd.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([qtd, v]) => ({
      quantidade: qtd,
      linhas: v.n,
      mediaFeeSobreUnitPrice: Math.round((v.somaSobreUnit / v.n) * 100) / 100 + '%',
      mediaFeeSobreLinhaToda: Math.round((v.somaSobreLinha / v.n) * 100) / 100 + '%',
    }));

  const comQtdMaior = linhas.filter((l) => l.qtd > 1);
  let veredicto: string;
  if (comQtdMaior.length === 0) {
    veredicto = `Nenhum pedido com quantidade > 1 nos ultimos ${dias} dias. Sem isso NAO da pra decidir — o calculo segue assumindo "por unidade".`;
  } else {
    const q1 = porQtd.get(1);
    const mediaQ1 = q1 ? q1.somaSobreUnit / q1.n : null;
    const mediaMaiorSobreUnit = comQtdMaior.reduce((t, l) => t + l.sobreUnit, 0) / comQtdMaior.length;
    const mediaMaiorSobreLinha = comQtdMaior.reduce((t, l) => t + l.sobreLinha, 0) / comQtdMaior.length;
    if (mediaQ1 == null) {
      veredicto = 'Sem pedidos de quantidade 1 para comparar.';
    } else {
      const difUnit = Math.abs(mediaMaiorSobreUnit - mediaQ1);
      const difLinha = Math.abs(mediaMaiorSobreLinha - mediaQ1);
      veredicto = difUnit < difLinha
        ? `POR UNIDADE. Em quantidade >1, fee/unit_price (${mediaMaiorSobreUnit.toFixed(2)}%) ficou proximo do padrao de quantidade 1 (${mediaQ1.toFixed(2)}%). O calculo atual (fee x quantidade) esta certo.`
        : `PELA LINHA INTEIRA. Em quantidade >1, fee/(unit x qtd) (${mediaMaiorSobreLinha.toFixed(2)}%) ficou proximo do padrao de quantidade 1 (${mediaQ1.toFixed(2)}%). O calculo atual SUPERESTIMA a comissao — precisa parar de multiplicar pela quantidade.`;
    }
  }

  return {
    veredicto,
    periodoDias: dias,
    linhasAnalisadas: linhas.length,
    linhasComQuantidadeMaiorQue1: comQtdMaior.length,
    porQuantidade: resumo,
    exemplosComQuantidadeMaiorQue1: comQtdMaior.slice(0, 10),
  };
}

/**
 * Custo do frete PAGO PELO VENDEDOR num envio. Devolve null quando o ML nao informa.
 *
 * O ML nao e consistente na forma: as vezes `senders[].cost`, as vezes `gross_amount` menos o que
 * o comprador pagou (`receiver.cost`). Tentamos as duas leituras e ficamos com a primeira que
 * fizer sentido. Envio ja despachado nunca muda de custo — por isso quem chama guarda pra sempre.
 */
export async function getShipmentCost(shipmentId: string): Promise<number | null> {
  try {
    const d = await mlRequest<any>(`/shipments/${shipmentId}/costs`);

    const dosSenders = Array.isArray(d?.senders)
      ? d.senders.reduce((t: number, s: any) => t + Number(s?.cost ?? 0), 0)
      : null;
    if (dosSenders != null && Number.isFinite(dosSenders) && dosSenders > 0) {
      return Math.round(dosSenders * 100) / 100;
    }

    const bruto = Number(d?.gross_amount ?? NaN);
    const doComprador = Number(d?.receiver?.cost ?? 0);
    if (Number.isFinite(bruto)) {
      const doVendedor = Math.max(0, bruto - (Number.isFinite(doComprador) ? doComprador : 0));
      return Math.round(doVendedor * 100) / 100;
    }

    // Respondeu, mas sem numero reconhecivel: 0 e uma resposta legitima (frete pago pelo comprador).
    return dosSenders === 0 ? 0 : null;
  } catch {
    return null;
  }
}

/**
 * SONDA DE PUBLICIDADE.
 *
 * Nao consegui ler a documentacao de Product Ads (o ML bloqueia o acesso automatizado), entao em
 * vez de adivinhar endpoints, bate nas rotas conhecidas e relata o que a SUA conta responde. Mesmo
 * metodo que resolveu a questao das opinioes.
 *
 * Um 403 aqui geralmente nao e falta de permissao no app, e sim TOKEN ANTIGO: o token carrega os
 * escopos do momento em que foi emitido. Mudar a permissao no app nao atualiza um token ja
 * existente — tem que reconectar.
 */
export async function sondarPublicidade(): Promise<any> {
  const sellerId = await getMlUserId().catch(() => null);

  const rotas = [
    '/advertising/advertisers?product_id=PADS',
    '/advertising/product_ads/campaigns/search',
    '/advertising/product_ads/ads/search',
    sellerId ? `/advertising/product_ads/seller/${sellerId}/campaigns` : null,
    sellerId ? `/users/${sellerId}/item_ads` : null,
    '/advertising/campaigns',
  ].filter(Boolean) as string[];

  const resultados: any[] = [];
  for (const rota of rotas) {
    try {
      const corpo = await mlRequest<any>(rota, { 'Api-Version': '1' });
      const texto = JSON.stringify(corpo);
      resultados.push({
        rota,
        ok: true,
        // So o comeco: o objetivo e descobrir o FORMATO, nao despejar a resposta inteira.
        amostra: texto.length > 1200 ? texto.slice(0, 1200) + '...(cortado)' : corpo,
        chavesDoTopo: corpo && typeof corpo === 'object' ? Object.keys(corpo).slice(0, 20) : null,
      });
    } catch (err: any) {
      resultados.push({ rota, ok: false, status: err?.status ?? null, erro: String(err?.message || err) });
    }
    await sleep(120);
  }

  const funcionou = resultados.filter((r) => r.ok);
  const negados = resultados.filter((r) => r.status === 403 || r.status === 401);

  let diagnostico: string;
  if (funcionou.length > 0) {
    diagnostico = `${funcionou.length} rota(s) responderam. Da pra construir a analise de publicidade em cima delas.`;
  } else if (negados.length > 0) {
    diagnostico =
      'Todas negaram acesso. Quase sempre e o TOKEN, nao o app: o token guarda os escopos de quando foi ' +
      'emitido. Reconecte em /oauth/ml/login e rode de novo.';
  } else {
    diagnostico = 'Nenhuma rota conhecida respondeu. Pode ser que a conta nao tenha campanhas ativas, ou que os caminhos tenham mudado.';
  }

  return { diagnostico, sellerId, resultados };
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

/**
 * PROMOCOES (v35) — Central de Promocoes do ML, a mesma fonte da tela /anuncios/lista/promos.
 *
 * `/seller-promotions/items/{id}?app_version=v2` devolve TODAS as promocoes ligadas ao anuncio:
 * as que ele ja participa (started/pending) e as propostas abertas (candidate). Leitura pura;
 * aderir e um POST na mesma rota, que fica fora deste servico de proposito.
 */
export async function getItemPromotionsRaw(itemId: string): Promise<any[]> {
  const data = await mlRequest<any>(`/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

/** Campanhas para as quais o vendedor foi convidado (visao por campanha, nao por anuncio). */
export async function getSellerPromotionsRaw(): Promise<any> {
  const sellerId = await getMlUserId();
  return mlRequest<any>(`/seller-promotions/users/${sellerId}?app_version=v2`);
}

/**
 * Tarifa de venda que o ML cobraria por UMA unidade a esse preco, pela tabela oficial
 * (/sites/{site}/listing_prices). Usada pra estimar o "voce recebe" de um preco que ainda nao
 * vendeu — a comissao real (sale_fee dos pedidos) so existe depois da venda.
 */
export async function getSaleFee(siteId: string, price: number, listingTypeId: string, categoryId?: string): Promise<number | null> {
  const qs = new URLSearchParams({ price: String(price), listing_type_id: listingTypeId });
  if (categoryId) qs.set('category_id', categoryId);
  const data = await mlRequest<any>(`/sites/${siteId}/listing_prices?${qs.toString()}`);
  const linha = Array.isArray(data) ? data.find((d: any) => d?.listing_type_id === listingTypeId) ?? data[0] : data;
  const fee = Number(linha?.sale_fee_amount);
  return Number.isFinite(fee) ? fee : null;
}

export interface PrecoDeVenda {
  /** preco que o comprador paga agora (ja com a promocao ativa, se houver) */
  preco: number | null;
  /** preco "cheio" do anuncio */
  precoCheio: number | null;
  /** id da promocao que esta definindo o preco agora (C-MLB..., P-MLB...), quando ha */
  /** id da campanha que define o preco (P-MLB..., C-MLB...): metadata.campaign_id */
  promocaoAtivaId: string | null;
  /** id da oferta (OFFER-MLB...): metadata.promotion_id; bate com o ref_id da promocao */
  ofertaAtivaId: string | null;
  promocaoAtivaTipo: string | null;
}

/** Le a resposta de /items/{id}/sale_price. Pura e tolerante a campos ausentes. */
export function parsePrecoDeVenda(d: any): PrecoDeVenda | null {
  if (!d || typeof d !== 'object') return null;
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const meta = d.metadata ?? {};
  return {
    preco: n(d.amount),
    precoCheio: n(d.regular_amount),
    // Conferido em 2026-11-04 (MLB3752079801): campaign_id = "P-MLB18193008" (o id da promocao) e
    // promotion_id = "OFFER-MLB3752079801-..." (o ref_id). Sem campaign_id (campanha propria),
    // o promotion_id pode ser o proprio C-MLB...
    promocaoAtivaId: meta.campaign_id ?? (meta.promotion_id && !String(meta.promotion_id).startsWith('OFFER-') ? meta.promotion_id : null),
    ofertaAtivaId: meta.promotion_id ?? null,
    promocaoAtivaTipo: meta.promotion_type ? String(meta.promotion_type).toUpperCase() : null,
  };
}

/**
 * Preco de venda ATUAL do anuncio e qual promocao o define. Sem isso, "hoje" seria o preco cheio
 * (R$ 78,90) quando o comprador na verdade paga o preco da campanha ativa (R$ 36,99), e a
 * comparacao com as propostas ficaria muito otimista.
 */
export async function getSalePriceRaw(itemId: string): Promise<any> {
  return mlRequest<any>(`/items/${encodeURIComponent(itemId)}/sale_price?context=channel_marketplace`);
}

// --- ESCRITA (v39) ---------------------------------------------------------------------------
// Tudo abaixo ALTERA dados reais da conta. So a adesao a promocoes usa, atras da trava
// PROMOCOES_ENABLED + simulacao + confirmacao (core/promocoesAdesao.ts). Nenhuma ferramenta do
// assistente/Gerente chama isto.

/** POST com o token do ML. Sem retry de 429: repetir poderia aderir duas vezes. */
async function mlPost<T>(path: string, body: unknown): Promise<T> {
  let retried401 = false;
  for (;;) {
    const token = await ensureValidMlToken();
    const res = await fetchWithTimeout(`${config.mlApiBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 401 = token vencido: o ML recusou antes de gravar, entao repetir uma vez e seguro.
    if (res.status === 401 && !retried401) {
      retried401 = true;
      continue;
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = { message: text };
    }
    if (!res.ok) throw new MlApiError(res.status, data?.message || data?.error || `Erro HTTP ${res.status}`, data);
    return data as T;
  }
}

/**
 * v39, DIAGNOSTICO: as rotas candidatas do custo de frete gratis que o vendedor paga num preco.
 * A doc do ML nao abre daqui; o /debug/promocoes devolve as respostas cruas pra escolher a certa.
 */
export async function sondarCustosDaVenda(itemId: string, precos: number[]): Promise<any> {
  const uid = await getMlUserId();
  const item = await mlRequest<any>(`/items/${encodeURIComponent(itemId)}?attributes=id,price,listing_type_id,category_id,shipping,condition`);
  const dims = item?.shipping?.dimensions;
  const tentar = (p: string) => mlRequest<any>(p).catch((e: any) => ({ erro: e?.message || String(e), status: e?.status ?? null }));
  const porPreco: Record<string, any> = {};
  for (const preco of precos) {
    const base = `item_price=${preco}&listing_type_id=${item?.listing_type_id}&mode=${item?.shipping?.mode ?? 'me2'}&condition=${item?.condition ?? 'new'}&logistic_type=${item?.shipping?.logistic_type ?? ''}&verbose=true`;
    porPreco[String(preco)] = {
      tarifa: await tentar(`/sites/${itemId.slice(0, 3)}/listing_prices?price=${preco}&listing_type_id=${item?.listing_type_id}&category_id=${item?.category_id}`),
      tarifaComEnvio: await tentar(`/sites/${itemId.slice(0, 3)}/listing_prices?price=${preco}&listing_type_id=${item?.listing_type_id}&category_id=${item?.category_id}&shipping_mode=${item?.shipping?.mode ?? ''}&logistic_type=${item?.shipping?.logistic_type ?? ''}&free_shipping=${item?.shipping?.free_shipping ? 'true' : 'false'}`),
      freteGratisPorItem: await tentar(`/users/${uid}/shipping_options/free?item_id=${itemId}&${base}`),
      freteGratisPorDimensao: dims ? await tentar(`/users/${uid}/shipping_options/free?dimensions=${encodeURIComponent(dims)}&${base}`) : 'anuncio sem shipping.dimensions',
    };
  }
  return { shipping: item?.shipping ?? null, listingType: item?.listing_type_id, categoria: item?.category_id, porPreco, freteDoAnuncio: await tentar(`/items/${itemId}/shipping_options/free`) };
}

/**
 * v40: frete que o VENDEDOR paga por unidade com frete gratis, a esse preco. E o numero que a tela
 * de promocoes do ML usa no "voce recebe": conferido em 2026-11-04 no MLB5332741758 (Full, Classico):
 * 172,69 - tarifa 20,72 - frete 21,75 = 130,22, igual a tela; a 249,99 o frete sobe para 25,45.
 * O custo muda por faixa de preco, por isso e consultado por preco.
 */
export async function getFreteGratis(
  item: Pick<MlItemAttributes, 'id' | 'listing_type_id' | 'shipping' | 'condition'>,
  preco: number,
): Promise<number | null> {
  const uid = await getMlUserId();
  const qs = new URLSearchParams({
    item_id: item.id,
    item_price: String(preco),
    listing_type_id: item.listing_type_id ?? '',
    mode: item.shipping?.mode ?? 'me2',
    condition: item.condition ?? 'new',
    logistic_type: item.shipping?.logistic_type ?? '',
    verbose: 'true',
  });
  const d = await mlRequest<any>(`/users/${uid}/shipping_options/free?${qs.toString()}`);
  const custo = Number(d?.coverage?.all_country?.list_cost);
  return Number.isFinite(custo) ? custo : null;
}

/** v42, DIAGNOSTICO: detalhe de uma candidata/oferta em /seller-promotions/{candidates|offers}/{id}. */
export async function sondarDetalheDaOferta(rota: 'candidates' | 'offers', id: string): Promise<any> {
  return mlRequest<any>(`/seller-promotions/${rota}/${encodeURIComponent(id)}?app_version=v2`).catch((e: any) => ({ erro: e?.message || String(e), status: e?.status ?? null }));
}

/** Dados basicos do anuncio pra simulacao (titulo, preco cheio, status). */
export async function getItemBasico(itemId: string): Promise<{ id: string; title?: string; price?: number; status?: string }> {
  return mlRequest<any>(`/items/${encodeURIComponent(itemId)}?attributes=id,title,price,status`);
}

/** Adere o anuncio a uma promocao (POST /seller-promotions/items/{id}). */
export async function joinPromotion(itemId: string, corpo: Record<string, unknown>): Promise<any> {
  return mlPost<any>(`/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`, corpo);
}

