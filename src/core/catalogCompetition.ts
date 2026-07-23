import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemsAttributes, getPriceToWin, getSellerItemIds, MlItemAttributes, MlPriceToWin } from '../ml/mlClient';

/**
 * Analise de concorrencia de CATALOGO (Buy Box) dos anuncios do proprio seller no Mercado Livre.
 *
 * Nos anuncios de catalogo, varios vendedores disputam a MESMA pagina de produto e um algoritmo
 * do ML escolhe o "vencedor" (quem aparece com o botao de compra) por preco, frete, parcelamento
 * etc. O recurso /items/{id}/price_to_win diz, pra cada anuncio, se estamos ganhando ou perdendo
 * essa disputa e qual o preco necessario pra ganhar. Este modulo varre os anuncios de catalogo,
 * consulta esse recurso e monta uma lista priorizando o que estamos PERDENDO (maior potencial de
 * ganho). O resultado e cacheado em arquivo (a varredura e cara: 1 chamada por anuncio).
 */

export type SituacaoBuyBox = 'ganhando' | 'empatado' | 'perdendo' | 'indefinido';

export interface CatalogCompetitionView {
  itemId: string;
  title?: string;
  permalink?: string;
  catalogProductId?: string | null;
  /** status cru retornado pelo ML (winning, competing, sharing_first_place, listed...). */
  statusMl?: string;
  situacao: SituacaoBuyBox;
  precoAtual?: number | null;
  precoParaGanhar?: number | null;
  precoVencedor?: number | null;
  /** Quanto o preco atual esta ACIMA do preco pra ganhar (so faz sentido quando perdendo). */
  gap?: number | null;
  gapPercent?: number | null;
  visitShare?: string | number | null;
  vendidos?: number;
  disponivel?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Mapeia o status cru do ML para a nossa situacao simplificada. */
export function mapSituacao(statusMl: string | undefined): SituacaoBuyBox {
  switch ((statusMl || '').toLowerCase()) {
    case 'winning':
      return 'ganhando';
    case 'sharing_first_place':
      return 'empatado';
    case 'competing':
    case 'listed':
      return 'perdendo';
    default:
      return 'indefinido';
  }
}

/** Monta a view de um anuncio a partir dos seus atributos + resposta do price_to_win. Pura (testavel). */
export function buildCompetitionView(item: MlItemAttributes, ptw: MlPriceToWin): CatalogCompetitionView {
  const situacao = mapSituacao(ptw.status);
  const precoAtual = ptw.current_price ?? item.price ?? null;
  const precoParaGanhar = ptw.price_to_win ?? null;
  const precoVencedor = ptw.winner?.price ?? null;

  // Gap so e relevante quando estamos perdendo e temos os dois precos.
  let gap: number | null = null;
  let gapPercent: number | null = null;
  if (situacao === 'perdendo' && precoAtual != null && precoParaGanhar != null && precoParaGanhar > 0) {
    gap = round2(precoAtual - precoParaGanhar);
    gapPercent = round2((gap / precoParaGanhar) * 100);
  }

  return {
    itemId: item.id,
    title: item.title,
    permalink: item.permalink,
    catalogProductId: item.catalog_product_id ?? null,
    statusMl: ptw.status,
    situacao,
    precoAtual,
    precoParaGanhar,
    precoVencedor,
    gap,
    gapPercent,
    visitShare: ptw.visit_share ?? null,
    vendidos: item.sold_quantity,
    disponivel: item.available_quantity,
  };
}

/** Ordena: perdendo primeiro (maior gap = mais urgente), depois empatado, ganhando, indefinido. */
export function sortCompetitionViews(views: CatalogCompetitionView[]): CatalogCompetitionView[] {
  const ordem: Record<SituacaoBuyBox, number> = { perdendo: 0, empatado: 1, ganhando: 2, indefinido: 3 };
  return [...views].sort((a, b) => {
    if (ordem[a.situacao] !== ordem[b.situacao]) return ordem[a.situacao] - ordem[b.situacao];
    // dentro de "perdendo", o maior gap primeiro
    return (b.gap ?? -Infinity) - (a.gap ?? -Infinity);
  });
}

export interface CatalogCompetitionResult {
  items: CatalogCompetitionView[];
  updatedAt: string;
  /** Total de anuncios de catalogo analisados. */
  totalCatalogo: number;
  /** Quantos estamos perdendo (potencial de acao). */
  perdendo: number;
  /** true se a varredura parou no teto (pode haver mais anuncios nao analisados). */
  truncado: boolean;
}

// --- cache em arquivo (a varredura e cara; sobrevive a restart) ---
let cached: CatalogCompetitionResult | null = null;

function ensureDir(): void {
  const dir = path.dirname(config.catalogCompetitionCachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(): CatalogCompetitionResult | null {
  if (cached) return cached;
  try {
    if (fs.existsSync(config.catalogCompetitionCachePath)) {
      cached = JSON.parse(fs.readFileSync(config.catalogCompetitionCachePath, 'utf-8'));
    }
  } catch {
    cached = null;
  }
  return cached;
}

function persist(result: CatalogCompetitionResult): void {
  ensureDir();
  cached = result;
  // escrita atomica: grava num .tmp e renomeia, pra nunca deixar o JSON pela metade num crash.
  const tmp = config.catalogCompetitionCachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  fs.renameSync(tmp, config.catalogCompetitionCachePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ultimo resultado conhecido (do cache em memoria/arquivo), sem disparar varredura. */
export function getCatalogCompetition(): CatalogCompetitionResult | null {
  return load();
}

// Coalescing: uma varredura em andamento e reaproveitada por quem pedir de novo.
let scanInFlight: Promise<CatalogCompetitionResult> | null = null;

export function refreshCatalogCompetition(): Promise<CatalogCompetitionResult> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = doScan().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function doScan(): Promise<CatalogCompetitionResult> {
  if (!getMlAuthStatus().authenticated) {
    throw new Error('Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.');
  }

  const max = config.catalogScanMaxItems;
  const ids = await getSellerItemIds(max, true);
  const truncado = ids.length >= max;
  logger.info(`[CATALOGO] ${ids.length} anuncios candidatos (teto ${max}${truncado ? ', truncado' : ''}).`);

  const attrs = await getItemsAttributes(ids);
  // So anuncios de catalogo, ativos e com produto de catalogo vinculado disputam Buy Box.
  const catalogItems = attrs.filter((i) => i.catalog_listing === true && i.status === 'active' && i.catalog_product_id);
  logger.info(`[CATALOGO] ${catalogItems.length} anuncios de catalogo ativos para analisar.`);

  const views: CatalogCompetitionView[] = [];
  for (const item of catalogItems) {
    try {
      const ptw = await getPriceToWin(item.id);
      views.push(buildCompetitionView(item, ptw));
    } catch (err: any) {
      logger.warn(`[CATALOGO] Falha no price_to_win do anuncio ${item.id}:`, err?.message || err);
    }
    await sleep(200); // respeita a cota do ML sem correr risco de rajada
  }

  const sorted = sortCompetitionViews(views);
  const result: CatalogCompetitionResult = {
    items: sorted,
    updatedAt: new Date().toISOString(),
    totalCatalogo: sorted.length,
    perdendo: sorted.filter((v) => v.situacao === 'perdendo').length,
    truncado,
  };
  persist(result);
  logger.info(`[CATALOGO] Analise concluida: ${result.totalCatalogo} anuncios, ${result.perdendo} perdendo o Buy Box.`);
  return result;
}

/**
 * Loop de background: faz a primeira analise pouco depois de subir (se o ML estiver autorizado) e
 * repete a cada catalogScanIntervalHours. O painel responde na hora com o ultimo resultado.
 */
export function startCatalogLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    try {
      await refreshCatalogCompetition();
    } catch (err: any) {
      logger.warn('[CATALOGO] Falha na varredura de background:', err?.message || err);
    }
  };

  setTimeout(() => {
    run().catch((err) => logger.error('[CATALOGO] Erro na varredura inicial:', err?.message || err));
  }, 20000).unref();

  setInterval(() => {
    run().catch((err) => logger.error('[CATALOGO] Erro na varredura periodica:', err?.message || err));
  }, Math.max(1, config.catalogScanIntervalHours) * 60 * 60 * 1000).unref();

  logger.info(`[CATALOGO] Varredura de Buy Box em background ligada (a cada ${config.catalogScanIntervalHours}h).`);
}
