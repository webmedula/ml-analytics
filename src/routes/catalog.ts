import { FastifyInstance } from 'fastify';
import { getCatalogCompetition, refreshCatalogCompetition } from '../core/catalogCompetition';
import { getConversion, refreshConversion } from '../core/conversion';
import { getListingRatings, refreshListingRatings } from '../core/listingRatings';
import { datasDisponiveis, serieDoAnuncio, variacao, vendasPorDia } from '../core/history';
import { calcularReposicao } from '../core/replenishmentScan';
import { chaveSku, emparelhar, obterCustos } from '../core/custos';
import { lacunasParaCsv } from '../core/margem';
import { getMargem, refreshMargem } from '../core/margemScan';
import { lerPaginacao, procurarSkuNoTiny } from '../tiny/tinyClient';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import {
  debugItemRaw,
  diagnosticarSaleFee,
  getItemsSkus,
  getSellerItemIds,
  getUltimoPedidoBruto,
  getUnansweredQuestions,
  MlQuestion,
  sondarPublicidade,
} from '../ml/mlClient';

// Cache leve das perguntas (mudam com frequencia, mas nao a cada request): 5 min.
let perguntasCache: { total: number; questions: MlQuestion[] } | null = null;
let perguntasCacheAt = 0;
const PERGUNTAS_TTL_MS = 5 * 60 * 1000;

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // Responde na hora com o ultimo resultado da varredura de Buy Box. ?refresh=1 forca uma nova
  // varredura e espera por ela (pode demorar: 1 chamada ao ML por anuncio de catalogo).
  app.get('/api/catalog/competition', async (req, reply) => {
    const { refresh } = req.query as { refresh?: string };

    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }

    try {
      if (refresh === '1') return await refreshCatalogCompetition();
      const cached = getCatalogCompetition();
      if (cached) return cached;
      return await refreshCatalogCompetition();
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao analisar concorrencia de catalogo' };
    }
  });

  app.post('/api/catalog/refresh', async (_req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    refreshCatalogCompetition().catch(() => undefined);
    reply.code(202);
    return { ok: true, mensagem: 'Varredura de catalogo iniciada' };
  });

  // Conversao (visitas x vendas), janelas de 30 e 7 dias. Serve o cache; ?refresh=1 força a varredura.
  app.get('/api/conversion', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    const { refresh } = req.query as { refresh?: string };
    try {
      if (refresh === '1') return await refreshConversion();
      const cached = getConversion();
      if (cached) return cached;
      return await refreshConversion();
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao analisar conversao' };
    }
  });

  // Perguntas SEM resposta (exige permissao de Perguntas no app do ML). Cache de 5 min; ?refresh=1 força.
  app.get('/api/questions/pending', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    const { refresh } = req.query as { refresh?: string };
    try {
      const agora = Date.now();
      if (refresh === '1' || !perguntasCache || agora - perguntasCacheAt > PERGUNTAS_TTL_MS) {
        const questions = await getUnansweredQuestions();
        perguntasCache = { total: questions.length, questions };
        perguntasCacheAt = agora;
      }
      return { ...perguntasCache, atualizadoEm: new Date(perguntasCacheAt).toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao buscar perguntas' };
    }
  });

  // Diagnostico de NOTAS: para cada anuncio ativo, nota + total de opinioes e a classificacao de
  // "recriar zera ou nao". Somente leitura. Serve o cache; ?refresh=1 força a varredura.
  app.get('/api/ratings', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    const { refresh } = req.query as { refresh?: string };
    try {
      if (refresh === '1') return await refreshListingRatings();
      const cached = getListingRatings();
      if (cached) return cached;
      return await refreshListingRatings();
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao diagnosticar notas dos anuncios' };
    }
  });

  app.post('/api/ratings/refresh', async (_req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    refreshListingRatings().catch(() => undefined);
    reply.code(202);
    return { ok: true, mensagem: 'Varredura de notas iniciada' };
  });

  /** Lista de compra: o que repor, quanto e por que. Le do cache + serie diaria; nao chama o ML. */
  app.get('/api/replenishment', async (_req, reply) => {
    const r = calcularReposicao();
    if (!r) {
      reply.code(409);
      return { mensagem: 'Sem dados de conversao ainda. A varredura roda em background apos conectar.' };
    }
    return r;
  });

  /** Serie diaria de um anuncio: e o que alimenta o mini-grafico e a comparacao de periodos. */
  app.get('/api/history/:itemId', async (req) => {
    const { itemId } = req.params as { itemId: string };
    const { dias } = req.query as { dias?: string };
    const janela = Math.min(400, Math.max(2, Number(dias) || 30));
    const serie = serieDoAnuncio(itemId, janela);
    const porDia = vendasPorDia(serie);

    // Compara a metade recente contra a anterior: e a leitura de "esta subindo ou caindo".
    const meio = Math.floor(porDia.length / 2);
    const antiga = porDia.slice(0, meio);
    const recente = porDia.slice(meio);
    const soma = (l: typeof porDia, campo: 'unidades' | 'liquido') => l.reduce((t, d) => t + d[campo], 0);

    return {
      itemId,
      diasComRegistro: serie.length,
      serie,
      porDia,
      tendencia: porDia.length >= 4
        ? {
            unidades: variacao(soma(recente, 'unidades'), soma(antiga, 'unidades')),
            liquido: variacao(soma(recente, 'liquido'), soma(antiga, 'liquido')),
            comparando: `${recente.length} dia(s) recentes contra ${antiga.length} anteriores`,
          }
        : null,
    };
  });

  /** Quantos dias de serie ja foram acumulados — o painel usa pra explicar o que ainda nao da. */
  app.get('/api/history', async () => {
    const datas = datasDisponiveis();
    return { dias: datas.length, maisRecente: datas[0] ?? null, maisAntigo: datas[datas.length - 1] ?? null };
  });

  /** Pedido mais recente, cru. Serve pra conferir o significado de sale_fee contra um dado real
   * antes de confiar no calculo de liquido. Fora de /api pra abrir direto no navegador. */
  app.get('/debug/order', async (_req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    try {
      const pedido = await getUltimoPedidoBruto();
      if (!pedido) return { mensagem: 'Nenhum pedido encontrado.' };
      return {
        dica: 'Confira order_items[].sale_fee: some com unit_price e quantity e compare com o valor real recebido.',
        id: pedido.id,
        date_created: pedido.date_created,
        status: pedido.status,
        total_amount: pedido.total_amount,
        order_items: pedido.order_items,
        payments: pedido.payments,
        shipping: pedido.shipping,
      };
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao ler o pedido' };
    }
  });

  /** Margem + lacunas de cadastro, por anuncio. Serve o cache; ?refresh=1 força a varredura. */
  app.get('/api/margem', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' };
    }
    const { refresh } = req.query as { refresh?: string };
    try {
      if (refresh === '1') return await refreshMargem();
      return getMargem() ?? (await refreshMargem());
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao calcular margem' };
    }
  });

  /**
   * A lista de lacunas em CSV. Cadastro se corrige em planilha, com filtro e varias abas abertas —
   * nao rolando um dashboard. Protegida como as demais rotas de diagnostico (use ?key=).
   */
  app.get('/debug/lacunas.csv', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { estado } = req.query as { estado?: string };
    try {
      const r = getMargem() ?? (await refreshMargem());
      const lista = estado ? r.anuncios.filter((a) => a.estado === estado) : r.anuncios;
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="lacunas-cadastro.csv"');
      return lacunasParaCsv(lista);
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao gerar o CSV' };
    }
  });

  /**
   * SONDA DE MARGEM: cruza os anuncios ativos do ML com o custo do Tiny e diz, em numero, quantos
   * anuncios teriam margem calculavel. E o que decide se vale construir a coluna de margem — e, se
   * nao valer, aponta exatamente onde esta o buraco: SKU faltando no anuncio, SKU divergente entre
   * os sistemas, ou custo nao cadastrado. Somente leitura nos dois lados.
   */
  app.get('/debug/margem', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { itens } = req.query as { itens?: string };
    const max = Math.min(500, Math.max(5, Number(itens) || 60));

    try {
      const ids = await getSellerItemIds(max, false);
      const skus = await getItemsSkus(ids);
      const custos = await obterCustos();

      const lista = [...skus.entries()].map(([itemId, s]) => ({ itemId, ...s }));
      const resumo = emparelhar(lista.map((l) => l.sku), custos.custos, custos.semCusto);

      const estado = (sku: string | null): string => {
        const chave = chaveSku(sku);
        if (!chave) return 'sem SKU no anuncio';
        if (custos.custos[chave] != null) return 'com custo';
        if (custos.semCusto.includes(chave)) return 'sem custo no Tiny';
        return 'SKU nao existe no Tiny';
      };

      // Antes de acusar divergencia de cadastro, confirmar que a varredura leu o catalogo inteiro
      // e perguntar ao Tiny pelos codigos que "nao existem". Errar isso manda o usuario procurar
      // problema no lugar errado.
      const paginacao = await lerPaginacao().catch(() => null);
      const ausentes = lista
        .filter((l) => {
          const chave = chaveSku(l.sku);
          return chave && custos.custos[chave] == null && !custos.semCusto.includes(chave);
        })
        .slice(0, 3);
      const conferencia = [];
      for (const a of ausentes) conferencia.push(await procurarSkuNoTiny(a.sku!));

      const total = lista.length || 1;
      const pct = Math.round((resumo.comCusto / total) * 100);
      let veredicto: string;
      if (resumo.comCusto === 0) {
        veredicto =
          'Nenhum anuncio da amostra fecha custo. Antes de construir margem, resolver o elo que estiver zerado ' +
          'abaixo: sem SKU = preencher no anuncio; SKU nao existe = os codigos divergem entre ML e Tiny; sem custo = cadastro.';
      } else if (pct < 50) {
        veredicto = `${resumo.comCusto} de ${lista.length} anuncios (${pct}%) tem custo. Da pra construir a margem, mas ela vai aparecer em menos da metade dos anuncios — o painel precisa dizer quando o numero nao existe, em vez de mostrar margem cheia.`;
      } else {
        veredicto = `${resumo.comCusto} de ${lista.length} anuncios (${pct}%) tem custo. Cobertura boa pra usar margem como metrica principal.`;
      }

      const totalNoTiny = Number(paginacao?.total ?? paginacao?.totalRegistros ?? NaN);
      const varreduraCompleta = Number.isFinite(totalNoTiny) ? custos.produtosLidos >= totalNoTiny : null;
      const achadosNaConferencia = conferencia.filter((c) => c.encontrado).length;

      let alerta: string | null = null;
      if (varreduraCompleta === false) {
        alerta =
          `A varredura leu ${custos.produtosLidos} de ${totalNoTiny} produtos do Tiny. Os "SKU nao existe" ` +
          'provavelmente sao produtos que eu nao alcancei, nao divergencia de cadastro. Corrigir a leitura antes de mexer em cadastro.';
      } else if (achadosNaConferencia > 0) {
        alerta =
          `${achadosNaConferencia} dos SKUs marcados como ausentes FORAM encontrados perguntando direto ao Tiny. ` +
          'A varredura esta deixando produto pra tras (filtro ou paginacao) — o problema e meu, nao do seu cadastro.';
      }

      return {
        veredicto,
        alerta,
        anunciosNaAmostra: lista.length,
        ...resumo,
        custoDoTiny: {
          produtosLidos: custos.produtosLidos,
          totalNoTiny: Number.isFinite(totalNoTiny) ? totalNoTiny : null,
          varreduraCompleta,
          paginacao,
          skusComCusto: Object.keys(custos.custos).length,
          skusSemCusto: custos.semCusto.length,
          atualizadoEm: custos.atualizadoEm,
        },
        conferenciaDeAusentes: conferencia,
        exemplos: lista.slice(0, 15).map((l) => ({
          itemId: l.itemId,
          titulo: (l.title || '').slice(0, 60),
          sku: l.sku,
          origemDoSku: l.origem,
          estado: estado(l.sku),
          custo: chaveSku(l.sku) ? custos.custos[chaveSku(l.sku)!] ?? null : null,
        })),
      };
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro na sonda de margem' };
    }
  });

  /** Descobre quais rotas de publicidade respondem NESTA conta, antes de construir em cima delas. */
  app.get('/debug/ads', async (_req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    try {
      return await sondarPublicidade();
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro na sonda de publicidade' };
    }
  });

  /** Decide, com os pedidos reais da conta, se sale_fee e por unidade ou pela linha inteira. */
  app.get('/debug/sale-fee', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { dias } = req.query as { dias?: string };
    try {
      return await diagnosticarSaleFee(Math.min(365, Math.max(1, Number(dias) || 90)));
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro no diagnostico de comissao' };
    }
  });

  // DIAGNOSTICO TEMPORARIO (fora de /api, abre direto no navegador): mostra o JSON cru do ML pra
  // um anuncio, pra descobrir onde mora a identidade do vendedor vencedor. Remover depois de ajustar.
  app.get('/debug/catalog/:itemId', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    try {
      return await debugItemRaw((req.params as { itemId: string }).itemId);
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro no diagnostico' };
    }
  });
}
