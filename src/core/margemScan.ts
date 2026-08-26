import { obterCustos } from './custos';
import { classificarCusto, LacunaDoAnuncio, resumirLacunas, ResumoDeLacunas } from './margem';
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

export function getMargem(): ResultadoMargem | null {
  return cache;
}

export async function refreshMargem(maxAnuncios = 500, dias = 30): Promise<ResultadoMargem> {
  const ids = await getSellerItemIds(maxAnuncios, false);
  const skus = await getItemsSkus(ids);
  const custos = await obterCustos();
  const { porItem } = await getSalesByItem(dias);

  const semCusto = new Set(custos.semCusto);
  const anuncios: LacunaDoAnuncio[] = [];

  for (const [itemId, info] of skus.entries()) {
    const { estado, custo } = classificarCusto(info.sku, custos.custos, semCusto);
    const v = porItem.get(itemId);
    // Liquido = bruto - comissao - frete. O mesmo numero que a aba Desempenho usa; margem so
    // acrescenta a mercadoria. Manter a conta em UM lugar evita dois "liquidos" diferentes no painel.
    const liquido = v ? Math.round((v.bruto - v.comissao - v.frete) * 100) / 100 : 0;

    anuncios.push({
      itemId,
      titulo: info.title || '',
      sku: info.sku,
      origemDoSku: info.origem,
      estado,
      custo,
      liquido,
      unidades: v?.unidades ?? 0,
    });
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
