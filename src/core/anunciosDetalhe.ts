import { logger } from '../logger';
import { getFreteGratis, getItemsAttributes, getSaleFee, getSalePriceRaw, getVisitsWindows, parsePrecoDeVenda, type MlItemAttributes } from '../ml/mlClient';
import { getConversion } from './conversion';

/**
 * DADOS DO ANUNCIO COMO NA "GESTAO DE ANUNCIOS" DO ML (v54).
 *
 * Para os anuncios que mais faturam, o mesmo que a tela do vendedor mostra na linha do anuncio: preco e
 * preco em promocao, tipo (Classico/Premium), tarifa e frete a pagar, "Voce recebe", estoque, visitas,
 * vendas e conversao dos ultimos 7 dias e a qualidade.
 *
 * "Voce recebe" = preco que o comprador paga hoje − tarifa de venda pela tabela do ML nesse preco − frete
 * gratis que o ML cobra do vendedor nesse preco (zero quando o envio e por conta do comprador). E a mesma
 * conta da aba Promocoes; conferida contra a tela do ML (MLB5332741758: 172,69 − 20,72 − 21,75 = 130,22).
 */

export interface DetalheDoAnuncio {
  permalink: string | null;
  /** gold_special = Classico, gold_pro = Premium */
  tipo: string | null;
  tipoRotulo: string | null;
  /** preco "cheio" do anuncio */
  preco: number | null;
  /** o que o comprador paga agora (com a promocao ativa); null quando igual ao preco */
  precoPromocao: number | null;
  tarifa: number | null;
  frete: number | null;
  freteGratis: boolean | null;
  voceRecebe: number | null;
  estoque: number | null;
  visitas7: number | null;
  vendas7: number | null;
  /** vendas ÷ visitas dos ultimos 7 dias, em % */
  conversao7: number | null;
  /** qualidade do anuncio segundo o ML, de 0 a 100 */
  qualidade: number | null;
  status: string | null;
}

export const ROTULO_DO_TIPO_DE_ANUNCIO: Record<string, string> = {
  gold_special: 'Clássico',
  gold_pro: 'Premium',
  gold_premium: 'Premium',
  free: 'Grátis',
};

const r2 = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

/** Monta a linha do anuncio com o que ja foi buscado. PURA. */
export function montarDetalhe(e: {
  item: Pick<MlItemAttributes, 'price' | 'permalink' | 'listing_type_id' | 'available_quantity' | 'health' | 'status' | 'shipping'> | null;
  precoAgora: number | null;
  tarifa: number | null;
  frete: number | null;
  visitas7: number | null;
  vendas7: number | null;
}): DetalheDoAnuncio {
  const it = e.item;
  const preco = it?.price != null ? Number(it.price) : null;
  const agora = e.precoAgora ?? preco;
  const freteGratis = it?.shipping?.free_shipping ?? null;
  // Envio por conta do comprador: o vendedor nao paga frete (igual a tela do ML).
  const frete = freteGratis === false ? 0 : e.frete;
  const voceRecebe = agora != null && e.tarifa != null && frete != null ? agora - e.tarifa - frete : null;
  const tipo = it?.listing_type_id ?? null;
  return {
    permalink: it?.permalink ?? null,
    tipo,
    tipoRotulo: tipo ? ROTULO_DO_TIPO_DE_ANUNCIO[tipo] ?? tipo : null,
    preco: r2(preco),
    precoPromocao: agora != null && preco != null && Math.abs(agora - preco) >= 0.01 ? r2(agora) : null,
    tarifa: r2(e.tarifa),
    frete: r2(frete),
    freteGratis,
    voceRecebe: r2(voceRecebe),
    estoque: it?.available_quantity ?? null,
    visitas7: e.visitas7,
    vendas7: e.vendas7,
    conversao7: e.visitas7 && e.vendas7 != null ? Math.round((e.vendas7 / e.visitas7) * 1000) / 10 : null,
    qualidade: it?.health != null ? Math.round(Number(it.health) * 100) : null,
    status: it?.status ?? null,
  };
}

async function emLotes<T>(lista: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (i < lista.length) await fn(lista[i++]!);
  }));
}

/**
 * Busca os dados de cada anuncio no ML. Nunca lanca: o que falhar fica null (o diagnostico de custos sai
 * mesmo sem esses dados). `vendas7` vem da varredura de vendas que o diagnostico ja fez.
 */
export async function buscarDetalhes(ids: string[], vendas7: Map<string, number>): Promise<Map<string, DetalheDoAnuncio>> {
  const out = new Map<string, DetalheDoAnuncio>();
  if (!ids.length) return out;
  let itens: MlItemAttributes[] = [];
  try {
    itens = await getItemsAttributes(ids);
  } catch (err: any) {
    logger.warn('[CUSTOS] Falha ao ler os anuncios no ML:', err?.message || err);
  }
  const porId = new Map(itens.map((i) => [i.id, i]));

  // Visitas: a aba Desempenho ja tem (cache); so busca as que faltam.
  const visitas = new Map<string, number>();
  for (const v of getConversion()?.items ?? []) visitas.set(v.itemId, v.visitas7);
  const faltam = ids.filter((id) => !visitas.has(id));
  if (faltam.length) {
    const w = await getVisitsWindows(faltam).catch(() => new Map<string, { v30: number; v7: number }>());
    for (const [id, x] of w) visitas.set(id, x.v7);
  }

  await emLotes(ids, 4, async (id) => {
    const item = porId.get(id) ?? null;
    let precoAgora: number | null = null, tarifa: number | null = null, frete: number | null = null;
    try {
      precoAgora = parsePrecoDeVenda(await getSalePriceRaw(id))?.preco ?? null;
    } catch { /* sem promocao lida: usa o preco do anuncio */ }
    const preco = precoAgora ?? (item?.price != null ? Number(item.price) : null);
    if (item && preco != null && item.listing_type_id) {
      tarifa = await getSaleFee(id.slice(0, 3), preco, item.listing_type_id, item.category_id).catch(() => null);
      if (item.shipping?.free_shipping) frete = await getFreteGratis(item, preco).catch(() => null);
    }
    out.set(id, montarDetalhe({ item, precoAgora, tarifa, frete, visitas7: visitas.get(id) ?? null, vendas7: vendas7.get(id) ?? null }));
  });
  return out;
}
