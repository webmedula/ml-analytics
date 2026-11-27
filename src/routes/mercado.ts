import { FastifyInstance } from 'fastify';
import { consultaRadar, sondarMercado, tirarFoto } from '../core/mercado';

/**
 * v57: mercado do ML. /debug/* aceita ?key= (hook em server.ts).
 * - /debug/mercado?categoria=MLB...&termo=...: resposta crua de cada rota do ML (conferir formato e bloqueios).
 * - /debug/mercado/radar: o radar como o Gerente recebe; ?foto=1 tira uma foto nova antes.
 */
export async function mercadoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/mercado', async (req) => {
    const q = (req.query || {}) as { categoria?: string; termo?: string };
    return sondarMercado(q.categoria, q.termo || undefined);
  });

  app.get('/debug/mercado/radar', async (req) => {
    if ((req.query as { foto?: string } | undefined)?.foto === '1') await tirarFoto();
    return consultaRadar();
  });
}
