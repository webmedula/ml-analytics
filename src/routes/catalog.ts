import { FastifyInstance } from 'fastify';
import { getCatalogCompetition, refreshCatalogCompetition } from '../core/catalogCompetition';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { debugItemRaw, getUnansweredQuestions, MlQuestion } from '../ml/mlClient';

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
