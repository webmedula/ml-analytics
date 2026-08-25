import { FastifyInstance } from 'fastify';
import { getCatalogCompetition, refreshCatalogCompetition } from '../core/catalogCompetition';
import { getConversion, refreshConversion } from '../core/conversion';
import { getListingRatings, refreshListingRatings } from '../core/listingRatings';
import { datasDisponiveis, serieDoAnuncio, variacao, vendasPorDia } from '../core/history';
import { calcularReposicao } from '../core/replenishmentScan';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { debugItemRaw, diagnosticarSaleFee, getUltimoPedidoBruto, getUnansweredQuestions, MlQuestion } from '../ml/mlClient';

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
