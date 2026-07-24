import { FastifyInstance } from 'fastify';
import { getCatalogCompetition, refreshCatalogCompetition } from '../core/catalogCompetition';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { debugItemRaw } from '../ml/mlClient';

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
