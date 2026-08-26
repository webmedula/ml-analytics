import { abrirBanco } from './banco';
import { config } from '../config';
import { logger } from '../logger';
import { getConversion } from '../core/conversion';
import { getListingRatings } from '../core/listingRatings';
import { obterCustos, chaveSku } from '../core/custos';
import { getMargem, refreshMargem } from '../core/margemScan';
import { getSalesByItem, LinhaDePedido } from '../ml/mlClient';
import { resolverFretes, ratearFrete } from '../core/shippingCosts';

/**
 * INGESTAO: leva pro banco o que as varreduras ja descobriram.
 *
 * Regra que vale pra tudo aqui: `vendas` so ACUMULA. Anuncio e custo podem ser sobrescritos (sao
 * retratos do agora), mas uma linha de pedido gravada nunca e apagada por uma varredura seguinte —
 * ela ja saiu da janela que a API do ML deixa consultar, e seria perda definitiva.
 */

const hoje = (): string => new Date().toISOString().slice(0, 10);
const dataDe = (iso?: string): string | null => (iso ? iso.slice(0, 10) : null);

export interface ResultadoDaSincronizacao {
  vendasNovas: number;
  vendasAtualizadas: number;
  vendasTotais: number;
  anuncios: number;
  custos: number;
  snapshots: number;
  duracaoMs: number;
}

/** Grava as linhas de pedido. Devolve quantas eram novas — o resto ja estava guardado. */
export function gravarVendas(linhas: LinhaDePedido[], fretes: Map<string, number>): { novas: number; atualizadas: number } {
  const banco = abrirBanco();
  const agora = new Date().toISOString();

  // Rateia o frete de cada envio entre as linhas daquele envio, na proporcao do valor.
  const porEnvio = new Map<string, LinhaDePedido[]>();
  for (const l of linhas) {
    if (!l.shipmentId) continue;
    const lista = porEnvio.get(l.shipmentId) ?? [];
    lista.push(l);
    porEnvio.set(l.shipmentId, lista);
  }
  const freteDaLinha = new Map<LinhaDePedido, number>();
  for (const [envio, doEnvio] of porEnvio) {
    const total = fretes.get(envio);
    if (total == null) continue;
    const rateado = ratearFrete(total, doEnvio.map((l) => l.valor));
    doEnvio.forEach((l, i) => freteDaLinha.set(l, rateado[i]));
  }

  const existe = banco.prepare('SELECT 1 FROM vendas WHERE order_id = ? AND item_id = ?');
  const inserir = banco.prepare(`
    INSERT INTO vendas (order_id, item_id, data_criacao, data, status, sku, titulo, quantidade,
                        preco_unitario, sale_fee, bruto, comissao, shipment_id, frete, registrado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(order_id, item_id) DO UPDATE SET
      status  = excluded.status,
      -- frete chega depois do resto (uma chamada por envio): so sobrescreve quando ha valor novo,
      -- senao uma varredura sem frete apagaria o que a anterior conseguiu.
      frete   = COALESCE(excluded.frete, vendas.frete),
      sku     = COALESCE(excluded.sku, vendas.sku)
  `);

  let novas = 0;
  let atualizadas = 0;

  for (const l of linhas) {
    if (!l.orderId) continue;
    const jaTinha = existe.all(l.orderId, l.itemId).length > 0;
    const qtd = l.quantidade ?? 0;

    inserir.run(
      l.orderId,
      l.itemId,
      l.dataCriacao ?? null,
      dataDe(l.dataCriacao),
      l.status ?? null,
      l.sku ?? null,
      l.titulo ?? null,
      qtd,
      l.precoUnitario ?? null,
      l.saleFee ?? null,
      l.valor,
      l.saleFee != null ? Math.round(l.saleFee * qtd * 100) / 100 : null,
      l.shipmentId,
      freteDaLinha.get(l) ?? null,
      agora,
    );

    if (jaTinha) atualizadas++;
    else novas++;
  }

  return { novas, atualizadas };
}

/** Retrato atual dos anuncios: junta margem, conversao e notas numa linha por anuncio. */
function gravarAnuncios(): number {
  const banco = abrirBanco();
  const m = getMargem();
  if (!m) return 0;

  const conv = new Map((getConversion()?.items ?? []).map((c) => [c.itemId, c]));
  const notas = new Map((getListingRatings()?.items ?? []).map((r) => [r.itemId, r]));
  const agora = new Date().toISOString();
  const dia = hoje();

  const anuncio = banco.prepare(`
    INSERT INTO anuncios (item_id, titulo, sku, origem_do_sku, permalink, status, catalogo,
                          catalog_product_id, preco, estoque, visitas_30, visitas_7, nota,
                          avaliacoes, classificacao_nota, custo, estado_do_custo, atualizado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET
      titulo=excluded.titulo, sku=excluded.sku, origem_do_sku=excluded.origem_do_sku,
      permalink=excluded.permalink, status=excluded.status, catalogo=excluded.catalogo,
      catalog_product_id=excluded.catalog_product_id, preco=excluded.preco, estoque=excluded.estoque,
      visitas_30=excluded.visitas_30, visitas_7=excluded.visitas_7, nota=excluded.nota,
      avaliacoes=excluded.avaliacoes, classificacao_nota=excluded.classificacao_nota,
      custo=excluded.custo, estado_do_custo=excluded.estado_do_custo, atualizado_em=excluded.atualizado_em
  `);

  const snapshot = banco.prepare(`
    INSERT INTO snapshots_diarios (data, item_id, preco, estoque, visitas_30, nota)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(data, item_id) DO UPDATE SET
      preco=excluded.preco, estoque=excluded.estoque, visitas_30=excluded.visitas_30, nota=excluded.nota
  `);

  for (const a of m.anuncios) {
    const c = conv.get(a.itemId);
    const n = notas.get(a.itemId);

    anuncio.run(
      a.itemId, a.titulo, a.sku, a.origemDoSku,
      n?.permalink ?? c?.permalink ?? null,
      null,
      n?.catalogListing ? 1 : 0,
      n?.catalogProductId ?? null,
      null,
      c?.disponivel ?? null,
      c?.visitas30 ?? null,
      c?.visitas7 ?? null,
      n?.nota ?? null,
      n?.totalAvaliacoes ?? null,
      n?.classificacao ?? null,
      a.custo,
      a.estado,
      agora,
    );

    snapshot.run(dia, a.itemId, null, c?.disponivel ?? null, c?.visitas30 ?? null, n?.nota ?? null);
  }

  return m.anuncios.length;
}

function gravarCustos(custos: Record<string, number>): number {
  const banco = abrirBanco();
  const agora = new Date().toISOString();
  const stmt = banco.prepare(`
    INSERT INTO custos (sku, custo, atualizado_em) VALUES (?,?,?)
    ON CONFLICT(sku) DO UPDATE SET custo=excluded.custo, atualizado_em=excluded.atualizado_em
  `);
  let n = 0;
  for (const [sku, custo] of Object.entries(custos)) {
    const chave = chaveSku(sku);
    if (!chave) continue;
    stmt.run(chave, custo, agora);
    n++;
  }
  return n;
}

/**
 * Sincroniza tudo. `dias` controla quanto do passado buscar no ML nesta rodada — a primeira
 * execucao pode pedir mais pra puxar o historico que ainda cabe na janela da API.
 */
export async function sincronizar(dias = 30): Promise<ResultadoDaSincronizacao> {
  const inicio = Date.now();
  const banco = abrirBanco();

  const { linhas } = await getSalesByItem(dias);

  // Frete: o cache ja evita repetir consulta de envio antigo (custo de envio despachado nao muda).
  const idsDeEnvio = [...new Set(linhas.map((l) => l.shipmentId).filter((s): s is string => Boolean(s)))];
  const { custos: fretes } = await resolverFretes(idsDeEnvio);

  const { novas, atualizadas } = gravarVendas(linhas, fretes);

  if (!getMargem()) await refreshMargem();
  const anuncios = gravarAnuncios();
  const custosDoTiny = await obterCustos().catch(() => null);
  const custos = custosDoTiny ? gravarCustos(custosDoTiny.custos) : 0;

  const totais = banco.prepare('SELECT COUNT(*) AS n FROM vendas').all() as Array<{ n: number }>;
  const duracaoMs = Date.now() - inicio;

  banco.prepare(`
    INSERT INTO sincronizacoes (quando, vendas_novas, vendas_totais, anuncios, custos, duracao_ms, erro)
    VALUES (?,?,?,?,?,?,NULL)
  `).run(new Date().toISOString(), novas, totais[0]?.n ?? 0, anuncios, custos, duracaoMs);

  logger.info(`[BANCO] Sincronizado: ${novas} venda(s) nova(s), ${atualizadas} atualizada(s), ${anuncios} anuncio(s), ${custos} custo(s) em ${duracaoMs}ms.`);

  return {
    vendasNovas: novas,
    vendasAtualizadas: atualizadas,
    vendasTotais: totais[0]?.n ?? 0,
    anuncios,
    custos,
    snapshots: anuncios,
    duracaoMs,
  };
}

/** Sincroniza de tempos em tempos, pra base crescer sozinha sem ninguem lembrar de apertar botao. */
export function startSincronizacaoLoop(): void {
  const intervaloMs = Math.max(1, config.sincronizacaoIntervaloHoras) * 3600_000;
  const rodar = () => {
    sincronizar().catch((err) => logger.warn('[BANCO] Falha na sincronizacao:', err?.message || err));
  };
  // A primeira roda depois de um tempo: no boot as varreduras ainda nao terminaram, e sincronizar
  // antes delas gravaria anuncio sem visita e sem nota.
  setTimeout(rodar, 5 * 60_000);
  setInterval(rodar, intervaloMs);
}
