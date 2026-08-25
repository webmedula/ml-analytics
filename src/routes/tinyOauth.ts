import { FastifyInstance } from 'fastify';
import { logger } from '../logger';
import {
  buildTinyAuthorizationUrl,
  exchangeTinyCodeForToken,
  getTinyAuthStatus,
  isValidTinyState,
  tinyConfigurado,
} from '../tiny/tinyOauthClient';
import { diagnosticarTiny } from '../tiny/tinyClient';

export async function tinyOauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/tiny/login', async (_req, reply) => {
    if (!tinyConfigurado()) {
      reply.code(409).type('text/html').send(
        '<h1>Tiny nao configurado</h1><p>Defina TINY_CLIENT_ID e TINY_CLIENT_SECRET no ambiente.</p>',
      );
      return;
    }
    reply.redirect(buildTinyAuthorizationUrl());
  });

  app.get('/oauth/tiny/callback', async (req, reply) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

    if (error) {
      reply.code(400).type('text/html').send(`<h1>Falha na autorizacao do Tiny</h1><p>${error}: ${error_description || ''}</p>`);
      return;
    }
    if (!code || !isValidTinyState(state)) {
      reply.code(400).type('text/html').send('<h1>Requisicao invalida</h1><p>Codigo ou state ausente/invalido. Tente de novo em /oauth/tiny/login.</p>');
      return;
    }

    try {
      await exchangeTinyCodeForToken(code);
      reply.redirect('/?tiny_oauth=success');
    } catch (err: any) {
      logger.error('[TINY OAUTH] Falha ao trocar codigo por token:', err?.message);
      reply.code(500).type('text/html').send(`<h1>Falha ao concluir login no Tiny</h1><p>${err?.message}</p>`);
    }
  });

  app.get('/api/tiny/status', async () => getTinyAuthStatus());

  /** Confirma que existe custo cadastrado antes de construir a margem em cima dele. */
  app.get('/debug/tiny', async (_req, reply) => {
    if (!tinyConfigurado()) {
      reply.code(409);
      return { mensagem: 'Tiny nao configurado: faltam TINY_CLIENT_ID e TINY_CLIENT_SECRET.' };
    }
    try {
      return await diagnosticarTiny();
    } catch (err: any) {
      reply.code(err?.status === 401 ? 409 : 500);
      return {
        mensagem: err?.message || 'Erro ao consultar o Tiny',
        status: err?.status ?? null,
        corpo: err?.corpo ?? null,
        dica: 'Se for 401, conecte em /oauth/tiny/login. Se for 404, a URL base da API pode estar diferente — ajuste TINY_API_BASE_URL.',
      };
    }
  });
}
