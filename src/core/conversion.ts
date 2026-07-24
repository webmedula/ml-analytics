import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemsAttributes, getSellerItemIds, getSoldUnitsByItem, getVisitsWindows } from '../ml/mlClient';

/**
 * Conversao por anuncio = unidades vendidas / visitas, em duas janelas (30 e 7 dias).
 * Visitas vem da API de visitas (em lote); vendas dos pedidos dos ultimos 30 dias (a janela de 7
 * dias e derivada dos mesmos pedidos, sem chamada extra). Muita visita e pouca venda = problema de
 * preco/foto/reputacao; pouca visita = problema de posicionamento.
 */

export interface ConversionView {
  itemId: string;
  title?: string;
  permalink?: string;
  /** estoque disponivel do anuncio (available_quantity) — cobre TODOS os anuncios, nao so catalogo. */
  disponivel?: number;
  visitas30: number;
  vendas30: number;
  conversao30: number | null;
  visitas7: number;
  vendas7: number;
  conversao7: number | null;
}

/** Conversao em % = vendas / visitas * 100. Sem visitas => null (nao da pra calcular). */
export function taxaConversao(vendas: number, visitas: number): number | null {
  if (!visitas || visitas <= 0) return null;
  return Math.round((vendas / visitas) * 1000) / 10;
}

export interface ConversionResult {
  items: ConversionView[];
  updatedAt: string;
  totalAnalisados: number;
  /** Conversao media (ponderada por visitas) em cada janela. */
  conversaoMedia30: number | null;
  conversaoMedia7: number | null;
  truncado: boolean;
}

function dateStr(offsetDias: number): string {
  return new Date(Date.now() - offsetDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function mediaPonderada(views: ConversionView[], janela: '30' | '7'): number | null {
  let vendas = 0;
  let visitas = 0;
  for (const v of views) {
    vendas += janela === '30' ? v.vendas30 : v.vendas7;
    visitas += janela === '30' ? v.visitas30 : v.visitas7;
  }
  return taxaConversao(vendas, visitas);
}

let cached: ConversionResult | null = null;

function ensureDir(): void {
  const dir = path.dirname(config.conversionCachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist(result: ConversionResult): void {
  ensureDir();
  cached = result;
  const tmp = config.conversionCachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  fs.renameSync(tmp, config.conversionCachePath);
}

export function getConversion(): ConversionResult | null {
  if (cached) return cached;
  try {
    if (fs.existsSync(config.conversionCachePath)) cached = JSON.parse(fs.readFileSync(config.conversionCachePath, 'utf-8'));
  } catch {
    cached = null;
  }
  return cached;
}

let scanInFlight: Promise<ConversionResult> | null = null;

export function refreshConversion(): Promise<ConversionResult> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = doScan().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function doScan(): Promise<ConversionResult> {
  if (!getMlAuthStatus().authenticated) throw new Error('Mercado Livre nao autorizado.');

  const max = config.conversionMaxItems;
  const ids = await getSellerItemIds(max, false); // todos os anuncios ativos (nao so catalogo)
  const truncado = ids.length >= max;
  logger.info(`[CONVERSAO] ${ids.length} anuncios ativos (teto ${max}${truncado ? ', truncado' : ''}).`);

  const attrs = await getItemsAttributes(ids);
  const [visitasMap, vendasMap] = await Promise.all([
    getVisitsWindows(ids),
    getSoldUnitsByItem(30),
  ]);

  const items: ConversionView[] = attrs.map((a) => {
    const vis = visitasMap.get(a.id) || { v30: 0, v7: 0 };
    const v30 = vis.v30;
    const v7 = vis.v7;
    const sold = vendasMap.get(a.id) || { total: 0, d7: 0 };
    return {
      itemId: a.id,
      title: a.title,
      permalink: a.permalink,
      disponivel: a.available_quantity,
      visitas30: v30,
      vendas30: sold.total,
      conversao30: taxaConversao(sold.total, v30),
      visitas7: v7,
      vendas7: sold.d7,
      conversao7: taxaConversao(sold.d7, v7),
    };
  });

  // Ordena por "mais visitas com pior conversao" primeiro (maior potencial de melhoria).
  items.sort((a, b) => {
    const ca = a.conversao30 ?? Infinity;
    const cb = b.conversao30 ?? Infinity;
    if (ca !== cb) return ca - cb;
    return b.visitas30 - a.visitas30;
  });

  const result: ConversionResult = {
    items,
    updatedAt: new Date().toISOString(),
    totalAnalisados: items.length,
    conversaoMedia30: mediaPonderada(items, '30'),
    conversaoMedia7: mediaPonderada(items, '7'),
    truncado,
  };
  persist(result);
  logger.info(`[CONVERSAO] Concluido: ${items.length} anuncios; conversao media 30d = ${result.conversaoMedia30}%`);
  return result;
}

export function startConversionLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    try {
      await refreshConversion();
    } catch (err: any) {
      logger.warn('[CONVERSAO] Falha na varredura de background:', err?.message || err);
    }
  };
  setTimeout(() => run().catch((e) => logger.error('[CONVERSAO] Erro inicial:', e?.message || e)), 45000).unref();
  setInterval(() => run().catch((e) => logger.error('[CONVERSAO] Erro periodico:', e?.message || e)), Math.max(1, config.catalogScanIntervalHours) * 60 * 60 * 1000).unref();
  logger.info(`[CONVERSAO] Varredura de conversao em background ligada (a cada ${config.catalogScanIntervalHours}h).`);
}
