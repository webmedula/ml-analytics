import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { logger } from './logger';
import { healthRoutes } from './routes/health';
import { mlOauthRoutes } from './routes/mlOauth';
import { catalogRoutes } from './routes/catalog';
import { tinyOauthRoutes } from './routes/tinyOauth';

export function buildServer() {
  const app = Fastify({ logger: false });

  // Trata corpo JSON vazio como ausente (POST sem body pra disparar acao) em vez de erro.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  /**
   * Protege /api/* E /debug/* (rotas de /oauth/* e /health ficam livres, porque o ML e o Tiny
   * precisam alcancar o callback).
   *
   * O /debug/ ficou de fora ate agora e isso era um furo de verdade: o dominio e publico, e essas
   * rotas devolvem pedidos, comissao, custo e margem. Quem soubesse o endereco lia o resultado
   * financeiro da operacao sem nenhuma credencial.
   *
   * Como /debug/ existe pra ser aberto no navegador, aceita a chave tambem por `?key=` — cabecalho
   * nao da pra digitar na barra de endereco. Query string vaza mais facil (historico, log de
   * proxy), entao vale so pras rotas de diagnostico; /api/ continua exigindo o cabecalho.
   */
  app.addHook('onRequest', async (req, reply) => {
    const ehApi = req.url.startsWith('/api/');
    const ehDebug = req.url.startsWith('/debug/');
    if (!ehApi && !ehDebug) return;
    if (!config.serviceApiKey) return;

    const doCabecalho = req.headers['x-api-key'];
    if (doCabecalho === config.serviceApiKey) return;

    if (ehDebug) {
      const daQuery = (req.query as { key?: string } | undefined)?.key;
      if (daQuery === config.serviceApiKey) return;
      reply.code(401).send({ mensagem: 'Rota de diagnostico protegida. Acrescente ?key=SUA_SERVICE_API_KEY na URL.' });
      return;
    }

    reply.code(401).send({ mensagem: 'x-api-key invalida ou ausente' });
  });

  app.register(healthRoutes);
  app.register(mlOauthRoutes);
  app.register(catalogRoutes);
  app.register(tinyOauthRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error('Erro nao tratado:', err.message, err.stack);
    const status = (err as any).status || 500;
    reply.code(status).send({ mensagem: err.message || 'Erro interno' });
  });

  return app;
}
