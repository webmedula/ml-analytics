import { config } from '../config';
import { getConversion } from './conversion';
import { serieDoAnuncio, velocidadeDeVenda, vendasPorDia } from './history';
import { calcularCompra, desvioPadrao, ordenarPorUrgencia, SugestaoCompra } from './replenishment';

/**
 * Junta o que ja foi coletado (conversao + serie diaria) e produz a lista de compra.
 * Nao chama o Mercado Livre: le do cache e do historico.
 */

export interface LinhaReposicao {
  itemId: string;
  title?: string;
  permalink?: string;
  estoque: number;
  unidades30: number;
  liquido30: number;
  /** dias de historico usados; 0 = ainda sem serie, caiu no plano B */
  diasDeHistorico: number;
  /** true quando a velocidade veio da media de 30 dias, sem correcao de ruptura/promocao */
  velocidadeAproximada: boolean;
  sugestao: SugestaoCompra;
}

export interface ResultadoReposicao {
  items: LinhaReposicao[];
  parametros: { prazoEntregaDias: number; cicloCompraDias: number; z: number };
  /** quantos anuncios ja tem serie diaria suficiente pra corrigir ruptura e promocao */
  comHistorico: number;
  totalAnalisados: number;
  resumo: Record<SugestaoCompra['urgencia'], number>;
  investimentoEstimado: number | null;
  atualizadoEm: string;
}

export function calcularReposicao(): ResultadoReposicao | null {
  const conv = getConversion();
  if (!conv) return null;

  const parametros = {
    prazoEntregaDias: config.prazoEntregaDias,
    cicloCompraDias: config.cicloCompraDias,
    z: config.nivelServicoZ,
  };

  const linhas: LinhaReposicao[] = conv.items.map((i) => {
    const serie = serieDoAnuncio(i.itemId, 90);
    const dias = vendasPorDia(serie);

    // Com serie, corrige ruptura e promocao. Sem serie, cai na media de 30 dias — que serve pra
    // comecar, mas subestima quem ficou sem estoque e superestima quem esteve em promocao.
    const temSerie = dias.length >= 7;
    const velocidade = temSerie
      ? velocidadeDeVenda(dias, { ignorarDiasSemEstoque: true, ignorarDiasEmPromocao: true })
      : {
          unidadesPorDia: Math.round(((i.vendas30 || 0) / 30) * 1000) / 1000,
          diasConsiderados: 30,
          diasDescartadosSemEstoque: 0,
          diasDescartadosPromocao: 0,
          diasDescartadosPorLacuna: 0,
          confiavel: (i.vendas30 || 0) > 0,
        };

    const desvio = temSerie ? desvioPadrao(dias.map((d) => d.unidades)) : 0;
    const estoque = i.disponivel ?? 0;

    return {
      itemId: i.itemId,
      title: i.title,
      permalink: i.permalink,
      estoque,
      unidades30: i.vendas30,
      liquido30: i.liquido30,
      diasDeHistorico: dias.length,
      velocidadeAproximada: !temSerie,
      sugestao: calcularCompra(velocidade, estoque, desvio, parametros),
    };
  });

  const ordenadas = ordenarPorUrgencia(linhas);
  const resumo = { rompido: 0, critico: 0, atencao: 0, ok: 0, parado: 0 } as Record<SugestaoCompra['urgencia'], number>;
  for (const l of ordenadas) resumo[l.sugestao.urgencia]++;

  // Estimativa de investimento: quanto custaria comprar tudo que esta sendo sugerido, ao preco de
  // VENDA (nao temos o custo). Serve de ordem de grandeza, e o painel diz isso.
  let investimento = 0;
  let temPreco = false;
  for (const l of ordenadas) {
    if (l.sugestao.comprar > 0 && l.unidades30 > 0) {
      const precoMedio = l.liquido30 / l.unidades30;
      if (Number.isFinite(precoMedio) && precoMedio > 0) {
        investimento += precoMedio * l.sugestao.comprar;
        temPreco = true;
      }
    }
  }

  return {
    items: ordenadas,
    parametros,
    comHistorico: ordenadas.filter((l) => !l.velocidadeAproximada).length,
    totalAnalisados: ordenadas.length,
    resumo,
    investimentoEstimado: temPreco ? Math.round(investimento * 100) / 100 : null,
    atualizadoEm: conv.updatedAt,
  };
}
