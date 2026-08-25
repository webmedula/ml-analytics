import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemsAttributes, getSalesByItem, getSellerItemIds, getVisitsWindows } from '../ml/mlClient';
import { gravarDia, podar, SnapshotDiario } from './history';

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

  // --- dinheiro (janela de 30 dias e de 7) ---
  /** preco x quantidade, antes de descontos */
  bruto30: number;
  bruto7: number;
  /** comissao REAL cobrada pelo ML (sale_fee), nao estimada por tabela */
  comissao30: number;
  comissao7: number;
  /** bruto - comissao. NAO desconta frete pago pelo vendedor nem custo do produto. */
  liquido30: number;
  liquido7: number;
  /** liquido / bruto, em % — quanto sobra de cada real vendido depois da comissao */
  margemComissao30: number | null;
  /** liquido / unidades — quanto cada venda deixa, em media */
  ticketLiquido30: number | null;
  /** true quando algum item do periodo veio sem sale_fee: a comissao esta subestimada */
  comissaoIncompleta: boolean;
}

/** Percentual do bruto que sobra depois da comissao. Sem bruto => null. */
export function margemDaComissao(bruto: number, liquido: number): number | null {
  if (!bruto || bruto <= 0) return null;
  return Math.round((liquido / bruto) * 1000) / 10;
}

function arredonda(v: number): number {
  return Math.round(v * 100) / 100;
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
  /** Totais da conta no periodo — o que o painel mostra como KPI. */
  bruto30: number;
  comissao30: number;
  liquido30: number;
  bruto7: number;
  comissao7: number;
  liquido7: number;
  /** Algum anuncio ficou com comissao subestimada (item sem sale_fee na resposta do ML). */
  comissaoIncompleta: boolean;
  /**
   * O liquido NAO desconta frete pago pelo vendedor nem custo do produto. O painel precisa dizer
   * isso, senao o numero e lido como lucro — e nao e.
   */
  liquidoInclui: string;
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
    getSalesByItem(30),
  ]);

  const items: ConversionView[] = attrs.map((a) => {
    const vis = visitasMap.get(a.id) || { v30: 0, v7: 0 };
    const v30 = vis.v30;
    const v7 = vis.v7;
    const sold = vendasMap.get(a.id);
    const unidades30 = sold?.unidades ?? 0;
    const unidades7 = sold?.unidadesD7 ?? 0;
    const bruto30 = arredonda(sold?.bruto ?? 0);
    const bruto7 = arredonda(sold?.brutoD7 ?? 0);
    const comissao30 = arredonda(sold?.comissao ?? 0);
    const comissao7 = arredonda(sold?.comissaoD7 ?? 0);
    const liquido30 = arredonda(bruto30 - comissao30);
    const liquido7 = arredonda(bruto7 - comissao7);

    return {
      itemId: a.id,
      title: a.title,
      permalink: a.permalink,
      disponivel: a.available_quantity,
      visitas30: v30,
      vendas30: unidades30,
      conversao30: taxaConversao(unidades30, v30),
      visitas7: v7,
      vendas7: unidades7,
      conversao7: taxaConversao(unidades7, v7),
      bruto30,
      bruto7,
      comissao30,
      comissao7,
      liquido30,
      liquido7,
      margemComissao30: margemDaComissao(bruto30, liquido30),
      ticketLiquido30: unidades30 > 0 ? arredonda(liquido30 / unidades30) : null,
      comissaoIncompleta: (sold?.itensSemComissao ?? 0) > 0,
    };
  });

  // Ordena por "mais visitas com pior conversao" primeiro (maior potencial de melhoria).
  items.sort((a, b) => {
    const ca = a.conversao30 ?? Infinity;
    const cb = b.conversao30 ?? Infinity;
    if (ca !== cb) return ca - cb;
    return b.visitas30 - a.visitas30;
  });

  const soma = (campo: keyof ConversionView): number =>
    arredonda(items.reduce((t, i) => t + (Number(i[campo]) || 0), 0));

  const result: ConversionResult = {
    items,
    updatedAt: new Date().toISOString(),
    totalAnalisados: items.length,
    conversaoMedia30: mediaPonderada(items, '30'),
    conversaoMedia7: mediaPonderada(items, '7'),
    bruto30: soma('bruto30'),
    comissao30: soma('comissao30'),
    liquido30: soma('liquido30'),
    bruto7: soma('bruto7'),
    comissao7: soma('comissao7'),
    liquido7: soma('liquido7'),
    comissaoIncompleta: items.some((i) => i.comissaoIncompleta),
    liquidoInclui: 'Bruto menos a comissao real do ML. NAO desconta frete pago pelo vendedor nem o custo do produto.',
    truncado,
  };
  persist(result);

  // Grava o retrato do dia. E o que permite, amanha, responder "esta subindo ou caindo?" e
  // "aquela promocao funcionou?" — perguntas que o ML nao responde retroativamente.
  try {
    const snapshots: SnapshotDiario[] = items.map((i) => ({
      data: new Date().toISOString().slice(0, 10),
      itemId: i.itemId,
      titulo: i.title,
      preco: attrs.find((a) => a.id === i.itemId)?.price ?? null,
      estoque: i.disponivel ?? null,
      visitas: i.visitas30,
      unidades30: i.vendas30,
      liquido30: i.liquido30,
      emPromocao: null, // preenchido quando a leitura de promocoes entrar
    }));
    gravarDia(snapshots);
    podar();
  } catch (err: any) {
    // Historico e complemento: se falhar, a analise do dia continua valendo.
    logger.warn('[HISTORICO] Falha ao gravar o dia:', err?.message || err);
  }

  logger.info(
    `[CONVERSAO] Concluido: ${items.length} anuncios; conversao media 30d = ${result.conversaoMedia30}%; ` +
    `bruto 30d = R$ ${result.bruto30.toFixed(2)}; liquido 30d = R$ ${result.liquido30.toFixed(2)}`,
  );
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
