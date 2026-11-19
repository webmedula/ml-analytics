import { obterCustos } from './custos';
import { classificarCusto, comCustoManual, LacunaDoAnuncio, resumirLacunas, ResumoDeLacunas } from './margem';
import { listarManuais } from './custosManuais';
import { getItemsSkus, getSalesByItem, getSellerItemIds } from '../ml/mlClient';
import { logger } from '../logger';

/**
 * Varredura que junta anuncio (ML), custo (Tiny) e venda (ML) num unico mapa.
 *
 * O objetivo nao e so calcular margem: e produzir a LISTA DE LACUNAS ordenada por dinheiro. Um
 * anuncio sem custo cadastrado que fatura R$ 4 mil vale mais atencao que trinta que faturam R$ 30
 * juntos, e sem o faturamento do lado a lista viraria um monte de tarefa sem prioridade.
 */

export interface ResultadoMargem {
  atualizadoEm: string;
  janelaDias: number;
  resumo: ResumoDeLacunas;
  anuncios: LacunaDoAnuncio[];
  custoDoTiny: { produtosLidos: number; skusComCusto: number; skusSemCusto: number; atualizadoEm: string };
}

let cache: ResultadoMargem | null = null;

async function etapa<T>(nome: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err: any) {
    const e = new Error(`${nome}: ${err?.message || err}`);
    (e as any).status = err?.status;
    throw e;
  }
}

/**
 * v53: SKU e titulo de cada anuncio ativo, sem custo e sem vendas. E o que o Gerente precisa para
 * juntar anuncios do mesmo produto; nao depende do Tiny nem da busca de pedidos. Cache de 6h.
 */
export interface SkusDosAnuncios { atualizadoEm: string; anuncios: Array<{ itemId: string; sku: string | null; titulo: string }> }
let skusCache: SkusDosAnuncios | null = null;
const SEIS_HORAS = 6 * 60 * 60 * 1000;

export async function obterSkusDosAnuncios(forcar = false, maxAnuncios = 500): Promise<SkusDosAnuncios> {
  if (!forcar && skusCache && Date.now() - Date.parse(skusCache.atualizadoEm) < SEIS_HORAS) return skusCache;
  const ids = await etapa('lista de anuncios do ML', () => getSellerItemIds(maxAnuncios, false));
  const skus = await etapa('SKU dos anuncios no ML', () => getItemsSkus(ids));
  skusCache = { atualizadoEm: new Date().toISOString(), anuncios: [...skus.entries()].map(([itemId, x]) => ({ itemId, sku: x.sku, titulo: x.title ?? '' })) };
  return skusCache;
}

export function getMargem(): ResultadoMargem | null {
  return cache;
}

/** v54: reaplica os custos manuais na ultima varredura, sem ir ao ML nem ao Tiny de novo. */
export function reaplicarCustosManuais(): ResultadoMargem | null {
  if (!cache) return null;
  const manuais = listarManuais();
  const anuncios = cache.anuncios.map((a) => comCustoManual(a, manuais));
  cache = { ...cache, anuncios, resumo: resumirLacunas(anuncios) };
  return cache;
}

export async function refreshMargem(maxAnuncios = 500, dias = 30): Promise<ResultadoMargem> {
  // v53: cada etapa diz o nome quando falha (antes vinha so a mensagem crua do ML, sem saber de onde).
  const ids = await etapa('lista de anuncios do ML', () => getSellerItemIds(maxAnuncios, false));
  const skus = await etapa('SKU dos anuncios no ML', () => getItemsSkus(ids));
  skusCache = { atualizadoEm: new Date().toISOString(), anuncios: [...skus.entries()].map(([itemId, x]) => ({ itemId, sku: x.sku, titulo: x.title ?? '' })) };
  const custos = await etapa('custo no Tiny', () => obterCustos());
  const { porItem } = await etapa('vendas dos ultimos dias no ML', () => getSalesByItem(dias));

  const semCusto = new Set(custos.semCusto);
  const manuais = listarManuais();
  const anuncios: LacunaDoAnuncio[] = [];

  for (const [itemId, info] of skus.entries()) {
    const { estado, custo } = classificarCusto(info.sku, custos.custos, semCusto);
    const v = porItem.get(itemId);
    // Liquido = bruto - comissao - frete. O mesmo numero que a aba Desempenho usa; margem so
    // acrescenta a mercadoria. Manter a conta em UM lugar evita dois "liquidos" diferentes no painel.
    const liquido = v ? Math.round((v.bruto - v.comissao - v.frete) * 100) / 100 : 0;

    anuncios.push(comCustoManual({
      itemId,
      titulo: info.title || '',
      sku: info.sku,
      origemDoSku: info.origem,
      estado,
      custo,
      liquido,
      unidades: v?.unidades ?? 0,
      bruto: v ? Math.round(v.bruto * 100) / 100 : 0,
      unidadesD7: v?.unidadesD7 ?? 0,
    }, manuais));
  }

  // Ordena por dinheiro preso: quem cuida do cadastro comeca pelo topo e para quando quiser, tendo
  // resolvido a maior parte do valor.
  anuncios.sort((a, b) => b.liquido - a.liquido);

  const resultado: ResultadoMargem = {
    atualizadoEm: new Date().toISOString(),
    janelaDias: dias,
    resumo: resumirLacunas(anuncios),
    anuncios,
    custoDoTiny: {
      produtosLidos: custos.produtosLidos,
      skusComCusto: Object.keys(custos.custos).length,
      skusSemCusto: custos.semCusto.length,
      atualizadoEm: custos.atualizadoEm,
    },
  };

  cache = resultado;
  logger.info(
    `[MARGEM] ${anuncios.length} anuncios; cobertura ${resultado.resumo.cobertura}% ` +
    `(${resultado.resumo.coberturaPorLiquido}% do faturamento).`,
  );
  return resultado;
}
