import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { estadoDoBanco } from '../db/banco';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'tiny-analytics',
      version: config.appVersion,
      mlAuthenticated: getMlAuthStatus().authenticated,
      // Node e banco no /health porque e a unica rota aberta: quando o deploy nao sobe, e daqui
      // que sai o diagnostico, sem precisar de chave nem de acesso ao log do servidor.
      node: process.version,
      banco: estadoDoBanco(),
    };
  });
}
