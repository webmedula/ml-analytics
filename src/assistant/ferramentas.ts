import { getConversion } from '../core/conversion';
import { getListingRatings } from '../core/listingRatings';
import { getCatalogCompetition } from '../core/catalogCompetition';
import { calcularReposicao } from '../core/replenishmentScan';
import { getMargem, refreshMargem } from '../core/margemScan';
import { margemDaVenda, ACAO_POR_ESTADO } from '../core/margem';
import { serieDoAnuncio, vendasPorDia, variacao } from '../core/history';
import { consultar, descreverEsquema } from '../db/banco';

/**
 * FERRAMENTAS DO ASSISTENTE.
 *
 * A IA nao ve os dados: ela escolhe qual funcao chamar e recebe o resultado pronto. Todo numero
 * que chega ao usuario saiu daqui, calculado pelo mesmo codigo que alimenta o painel.
 *
 * E de proposito. Mandar um resumo dos dados e pedir pra IA responder livremente parece mais
 * simples, mas com 193 anuncios o resumo nao cabe inteiro — e o que nao cabe o modelo tende a
 * completar sozinho. Numero inventado num painel de decisao e pior que nenhuma resposta.
 */

export interface DefinicaoDeFerramenta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const n2 = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

export const FERRAMENTAS: DefinicaoDeFerramenta[] = [
  {
    name: 'resumo_da_operacao',
    description:
      'Visao geral dos ultimos 30 dias: faturamento bruto e liquido, comissao, frete, unidades, ' +
      'quantos anuncios venderam e qual parte do faturamento tem custo cadastrado (e portanto margem calculavel). ' +
      'Use como primeira chamada quando a pergunta for ampla ("como estamos?", "resumo").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'top_anuncios',
    description:
      'Ranking de anuncios. ordenar_por: liquido (faturamento apos comissao e frete), unidades (mais vendidos), ' +
      'margem (lucro em reais, apos o custo do produto), margem_percentual, conversao. ' +
      'ordem "menor" inverte o ranking — use pra achar os PIORES (ex.: margem negativa). ' +
      'Margem so existe pra anuncios com custo cadastrado no Tiny.',
    input_schema: {
      type: 'object',
      properties: {
        ordenar_por: { type: 'string', enum: ['liquido', 'unidades', 'margem', 'margem_percentual', 'conversao'] },
        ordem: { type: 'string', enum: ['maior', 'menor'] },
        limite: { type: 'integer', description: 'quantos anuncios (1 a 20, padrao 8)' },
      },
      required: ['ordenar_por'],
    },
  },
  {
    name: 'detalhe_do_anuncio',
    description:
      'Tudo que o sistema sabe de UM anuncio: vendas, visitas, conversao, comissao, frete, custo, margem, ' +
      'estoque, nota e situacao no Buy Box. Aceita o codigo MLB, o SKU ou um pedaco do titulo.',
    input_schema: {
      type: 'object',
      properties: { busca: { type: 'string', description: 'MLB..., SKU, ou parte do titulo' } },
      required: ['busca'],
    },
  },
  {
    name: 'reposicao_de_estoque',
    description:
      'O que precisa ser comprado: quanto, e em quantos dias rompe se nada for feito. ' +
      'urgencia filtra por rompido / critico / atencao / ok / parado.',
    input_schema: {
      type: 'object',
      properties: {
        urgencia: { type: 'string', enum: ['rompido', 'critico', 'atencao', 'ok', 'parado'] },
        limite: { type: 'integer' },
      },
    },
  },
  {
    name: 'notas_dos_anuncios',
    description:
      'Anuncios com nota baixa e se recriar o anuncio zeraria a pontuacao ou nao (opiniao presa ao catalogo ' +
      'nao zera). Use quando a pergunta for sobre avaliacao, nota, reputacao do anuncio.',
    input_schema: { type: 'object', properties: { limite: { type: 'integer' } } },
  },
  {
    name: 'buy_box',
    description:
      'Concorrencia de catalogo: onde o anuncio esta perdendo o Buy Box, por qual preco daria pra ganhar ' +
      'e quem esta ganhando. So vale pra anuncios de catalogo.',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer' }, apenas_perdendo: { type: 'boolean' } },
    },
  },
  {
    name: 'lacunas_de_custo',
    description:
      'Onde a margem nao pode ser calculada e por que: anuncio sem SKU, SKU que nao existe no Tiny, ou produto ' +
      'sem custo cadastrado. Ordenado por faturamento preso em cada lacuna. Use quando perguntarem por que ' +
      'a margem de algo esta faltando, ou o que preencher primeiro.',
    input_schema: { type: 'object', properties: { limite: { type: 'integer' } } },
  },
  {
    name: 'esquema_do_banco',
    description:
      'Mostra as tabelas e colunas da base local, com quantas linhas cada uma tem. Chame ANTES de ' +
      'escrever qualquer SQL — sem ver o esquema voce inventa nome de coluna e a consulta falha.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_sql',
    description:
      'Roda um SELECT na base local e devolve as linhas. Use para qualquer pergunta que as outras ' +
      'ferramentas nao respondem: comparar periodos, agrupar por SKU ou familia, ver sazonalidade, ' +
      'cruzar custo com venda. A tabela `vendas` tem uma linha por (pedido, anuncio) com data, e ' +
      'acumula historico alem da janela de 30 dias. Somente SELECT; um comando por consulta. ' +
      'Deixe o SQLite fazer a conta (SUM, AVG, GROUP BY) em vez de somar voce mesmo.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT ... (ou WITH ... SELECT)' },
        limite: { type: 'integer', description: 'maximo de linhas devolvidas (padrao 50)' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'historico_do_anuncio',
    description:
      'Serie diaria de um anuncio e a tendencia (esta subindo ou caindo). Precisa de dias acumulados: o ' +
      'sistema guarda um retrato por dia, entao logo apos a instalacao ainda ha pouca serie.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, dias: { type: 'integer' } },
      required: ['itemId'],
    },
  },
];

const limitar = (v: unknown, padrao: number, teto = 20): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(teto, Math.max(1, Math.trunc(n))) : padrao;
};

/** Junta margem + conversao num registro so, que e o que quase toda pergunta precisa. */
async function linhas() {
  const m = getMargem() ?? (await refreshMargem());
  const conv = getConversion();
  const porItem = new Map((conv?.items ?? []).map((c) => [c.itemId, c]));

  return m.anuncios.map((a) => {
    const c = porItem.get(a.itemId);
    const { margem, percentual } = margemDaVenda(a.liquido, a.custo, a.unidades);
    return {
      itemId: a.itemId,
      titulo: a.titulo,
      sku: a.sku,
      unidades: a.unidades,
      liquido: n2(a.liquido),
      custoUnitario: a.custo,
      margem,
      margemPercentual: percentual,
      semMargemPorque: margem == null ? ACAO_POR_ESTADO[a.estado] : null,
      visitas30: c?.visitas30 ?? null,
      conversao30: c?.conversao30 ?? null,
      estoque: c?.disponivel ?? null,
    };
  });
}

export async function executarFerramenta(nome: string, entrada: any): Promise<unknown> {
  switch (nome) {
    case 'resumo_da_operacao': {
      const conv = getConversion();
      const m = getMargem() ?? (await refreshMargem());
      const todas = await linhas();
      const comMargem = todas.filter((l) => l.margem != null);

      return {
        periodo: 'ultimos 30 dias',
        atualizadoEm: m.atualizadoEm,
        faturamentoBruto: n2(conv?.bruto30 ?? null),
        comissaoDoMl: n2(conv?.comissao30 ?? null),
        fretePagoPeloVendedor: n2(conv?.frete30 ?? null),
        liquidoAposComissaoEFrete: n2(todas.reduce((t, l) => t + (l.liquido ?? 0), 0)),
        // Enquanto houver envio por consultar, o frete esta subestimado e o liquido, otimista.
        freteIncompleto: conv?.fretesPendentes ? `${conv.fretesPendentes} envio(s) ainda nao consultados — o frete real e maior` : null,
        unidadesVendidas: todas.reduce((t, l) => t + l.unidades, 0),
        anunciosQueVenderam: todas.filter((l) => l.unidades > 0).length,
        anunciosAtivos: todas.length,
        lucroApurado: n2(comMargem.reduce((t, l) => t + (l.margem ?? 0), 0)),
        avisoSobreOLucro:
          `O lucro acima cobre apenas ${m.resumo.coberturaPorLiquido}% do faturamento — o resto esta em anuncios ` +
          'sem custo cadastrado. Nao e o lucro total da operacao.',
        coberturaDeCusto: { porAnuncio: `${m.resumo.cobertura}%`, porFaturamento: `${m.resumo.coberturaPorLiquido}%` },
      };
    }

    case 'top_anuncios': {
      const limite = limitar(entrada?.limite, 8);
      const campo = String(entrada?.ordenar_por || 'liquido');
      const desc = String(entrada?.ordem || 'maior') !== 'menor';
      const todas = await linhas();

      const chave = (l: any): number | null =>
        campo === 'unidades' ? l.unidades
        : campo === 'margem' ? l.margem
        : campo === 'margem_percentual' ? l.margemPercentual
        : campo === 'conversao' ? l.conversao30
        : l.liquido;

      // Quem nao tem o numero fica FORA do ranking, em vez de virar zero e aparecer como o pior de
      // todos: "sem custo cadastrado" nao e "margem zero".
      const validas = todas.filter((l) => chave(l) != null);
      validas.sort((a, b) => (desc ? (chave(b)! - chave(a)!) : (chave(a)! - chave(b)!)));

      return {
        criterio: `${campo}, do ${desc ? 'maior' : 'menor'} pro ${desc ? 'menor' : 'maior'}`,
        anunciosConsiderados: validas.length,
        anunciosForaDoRanking: todas.length - validas.length,
        observacao: campo.startsWith('margem')
          ? 'So entram anuncios com custo cadastrado no Tiny. Use lacunas_de_custo pra ver quem ficou de fora.'
          : undefined,
        itens: validas.slice(0, limite),
      };
    }

    case 'detalhe_do_anuncio': {
      const busca = String(entrada?.busca || '').trim().toUpperCase();
      if (!busca) return { erro: 'Informe MLB, SKU ou parte do titulo.' };
      const todas = await linhas();

      const achados = todas.filter(
        (l) =>
          l.itemId.toUpperCase() === busca ||
          (l.sku || '').toUpperCase() === busca ||
          l.titulo.toUpperCase().includes(busca) ||
          (l.sku || '').toUpperCase().includes(busca),
      );
      if (achados.length === 0) return { encontrado: false, mensagem: `Nada corresponde a "${entrada?.busca}".` };
      if (achados.length > 1 && achados.length <= 8) {
        return { varios: true, mensagem: 'Mais de um anuncio corresponde. Peca o codigo MLB exato.', opcoes: achados.map((a) => ({ itemId: a.itemId, titulo: a.titulo, liquido: a.liquido })) };
      }

      const a = achados[0];
      const nota = getListingRatings()?.items.find((r) => r.itemId === a.itemId);
      const bb = getCatalogCompetition()?.items.find((c) => c.itemId === a.itemId);
      const rep = calcularReposicao()?.items.find((r) => r.itemId === a.itemId);

      return {
        ...a,
        nota: nota ? { nota: nota.nota, avaliacoes: nota.totalAvaliacoes, recriarZera: nota.classificacao, porque: nota.evidencia } : null,
        buyBox: bb ? { situacao: bb.situacao, precoAtual: bb.precoAtual, precoParaGanhar: bb.precoParaGanhar, vencedor: bb.vencedorNickname } : null,
        reposicao: rep ? { estoque: rep.estoque, ...rep.sugestao } : null,
      };
    }

    case 'reposicao_de_estoque': {
      const r = calcularReposicao();
      if (!r) return { disponivel: false, mensagem: 'A varredura de conversao ainda nao rodou.' };
      const limite = limitar(entrada?.limite, 10);
      const urg = entrada?.urgencia ? String(entrada.urgencia) : null;
      const itens = r.items.filter((i) => (urg ? i.sugestao.urgencia === urg : i.sugestao.comprar > 0));
      return {
        resumo: r.resumo,
        parametros: r.parametros,
        investimentoEstimado: r.investimentoEstimado,
        totalNoFiltro: itens.length,
        itens: itens.slice(0, limite).map((i) => ({
          itemId: i.itemId, titulo: i.title, estoque: i.estoque,
          comprar: i.sugestao.comprar, diasAteRuptura: i.sugestao.diasAteRuptura,
          urgencia: i.sugestao.urgencia, porque: i.sugestao.explicacao,
          velocidadeIncerta: i.velocidadeAproximada,
        })),
      };
    }

    case 'notas_dos_anuncios': {
      const r = getListingRatings();
      if (!r) return { disponivel: false, mensagem: 'A varredura de notas ainda nao rodou.' };
      const limite = limitar(entrada?.limite, 10);
      const baixas = r.items
        .filter((i) => i.nota != null)
        .sort((a, b) => (a.nota ?? 5) - (b.nota ?? 5))
        .slice(0, limite);
      return {
        itens: baixas.map((i) => ({
          itemId: i.itemId, titulo: i.title, nota: i.nota, avaliacoes: i.totalAvaliacoes,
          recriarZera: i.classificacao, porque: i.evidencia,
        })),
        legenda: 'recriarZera: "recriavel" = criar outro anuncio zera a nota; "preso_ao_catalogo" = as opinioes ficam no produto do catalogo e recriar NAO zera.',
      };
    }

    case 'buy_box': {
      const r = getCatalogCompetition();
      if (!r) return { disponivel: false, mensagem: 'A varredura de catalogo ainda nao rodou.' };
      const limite = limitar(entrada?.limite, 10);
      const itens = entrada?.apenas_perdendo === false ? r.items : r.items.filter((i) => i.situacao !== 'ganhando');
      return {
        totalNoFiltro: itens.length,
        itens: itens.slice(0, limite).map((i) => ({
          itemId: i.itemId, titulo: i.title, situacao: i.situacao,
          precoAtual: i.precoAtual, precoParaGanhar: i.precoParaGanhar,
          diferenca: i.gap, vencedor: i.vencedorNickname, motivos: i.motivosPerdendo,
        })),
      };
    }

    case 'lacunas_de_custo': {
      const m = getMargem() ?? (await refreshMargem());
      const limite = limitar(entrada?.limite, 10);
      const semMargem = m.anuncios.filter((a) => a.estado !== 'com_custo');
      return {
        resumo: m.resumo,
        legendaDosEstados: ACAO_POR_ESTADO,
        totalSemMargem: semMargem.length,
        itens: semMargem.slice(0, limite).map((a) => ({
          itemId: a.itemId, titulo: a.titulo, sku: a.sku, estado: a.estado,
          liquidoPreso: a.liquido, acao: ACAO_POR_ESTADO[a.estado],
        })),
      };
    }

    case 'historico_do_anuncio': {
      const itemId = String(entrada?.itemId || '');
      const dias = limitar(entrada?.dias, 30, 400);
      const serie = serieDoAnuncio(itemId, dias);
      if (serie.length < 2) {
        return { disponivel: false, mensagem: `So ha ${serie.length} dia(s) de historico para ${itemId}. A serie diaria comeca a acumular a partir da instalacao.` };
      }
      const porDia = vendasPorDia(serie);
      const meio = Math.floor(porDia.length / 2);
      const soma = (l: typeof porDia, campo: 'unidades' | 'liquido') => l.reduce((t, d) => t + d[campo], 0);
      return {
        itemId,
        diasComRegistro: serie.length,
        porDia,
        tendencia: porDia.length >= 4
          ? {
              unidades: variacao(soma(porDia.slice(meio), 'unidades'), soma(porDia.slice(0, meio), 'unidades')),
              liquido: variacao(soma(porDia.slice(meio), 'liquido'), soma(porDia.slice(0, meio), 'liquido')),
            }
          : null,
      };
    }

    case 'esquema_do_banco':
      return {
        esquema: descreverEsquema(),
        dica: 'vendas.data e texto YYYY-MM-DD: da pra comparar com >= e <= direto, e agrupar por substr(data,1,7) pra mes.',
      };

    case 'consultar_sql': {
      const sql = String(entrada?.sql || '');
      // Teto menor que o da API: o resultado vai pro contexto do modelo, e centenas de linhas
      // gastariam a resposta inteira antes de ele chegar a conclusao.
      const limite = limitar(entrada?.limite, 50, 200);
      try {
        return consultar(sql, limite);
      } catch (err: any) {
        // O erro volta como dado pro modelo poder corrigir o SQL e tentar de novo.
        return { erro: err?.message || String(err), sqlRecebido: sql };
      }
    }

    default:
      return { erro: `Ferramenta desconhecida: ${nome}` };
  }
}
