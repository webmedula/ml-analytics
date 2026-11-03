import { FastifyInstance } from 'fastify';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemPromotionsRaw, getSalePriceRaw, getSellerPromotionsRaw } from '../ml/mlClient';
import { getPromocoes, refreshPromocoes } from '../core/promocoes';
import { logger } from '../logger';

/**
 * v35: propostas de promocao do ML. Leitura pura.
 * /api/* exige x-api-key; /debug/* aceita ?key= (hook em server.ts).
 */
export async function promocoesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/promocoes', async (req, reply) => {
    const refresh = (req.query as { refresh?: string } | undefined)?.refresh === '1';
    const atual = getPromocoes();
    if (atual && !refresh) {
      const { vistas: _v, ...resto } = atual;
      return resto;
    }
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { vistas: _v, ...resto } = await refreshPromocoes();
    return resto;
  });

  app.post('/api/promocoes/refresh', async (_req, reply) => {
    refreshPromocoes().catch((err) => logger.warn('[PROMOCOES] Falha no refresh manual:', err?.message || err));
    reply.code(202);
    return { mensagem: 'Varredura de promocoes iniciada.' };
  });

  /** JSON cru do ML — pra conferir nomes de campo contra a tela do vendedor. */
  app.get('/debug/promocoes/:itemId', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { itemId } = req.params as { itemId: string };
    const [item, vendedor, preco] = await Promise.allSettled([getItemPromotionsRaw(itemId), getSellerPromotionsRaw(), getSalePriceRaw(itemId)]);
    const lado = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? r.value : { erro: r.reason?.message || String(r.reason), status: r.reason?.status ?? null };
    return { itemId, precoDeVenda: lado(preco), promocoesDoAnuncio: lado(item), campanhasDoVendedor: lado(vendedor) };
  });
}
