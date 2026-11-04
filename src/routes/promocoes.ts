import { FastifyInstance } from 'fastify';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemPromotionsRaw, getSalePriceRaw, getSellerPromotionsRaw, sondarCustosDaVenda } from '../ml/mlClient';
import { getPromocoes, refreshPromocoes } from '../core/promocoes';
import { logger } from '../logger';
import { config } from '../config';
import { AdesaoBloqueada, aderir, lerHistoricoAdesoes, listarPromocoes, simularAdesao } from '../core/promocoesAdesao';

/**
 * v35: propostas de promocao do ML. v39: adesao pelo painel (simular / aderir).
 * O Gerente so consegue chamar /api/assistente/ferramenta/* (trava em mcs-gerente/src/sistemas.ts),
 * entao estas rotas de escrita ficam fora do alcance dele.
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
    // v39: tarifa e frete gratis no preco de hoje e no cheio, pra conferir o "voce recebe" com a tela do ML.
    const precos = [preco.status === 'fulfilled' ? Number(preco.value?.amount) : NaN, preco.status === 'fulfilled' ? Number(preco.value?.regular_amount) : NaN].filter((n) => Number.isFinite(n) && n > 0);
    const custos = await sondarCustosDaVenda(itemId, [...new Set(precos)]).catch((e: any) => ({ erro: e?.message || String(e) }));
    return { itemId, precoDeVenda: lado(preco), custosDaVenda: custos, promocoesDoAnuncio: lado(item), campanhasDoVendedor: lado(vendedor) };
  });

  // ---------------------------------------------------------------- adesao (v39)
  const semMl = (reply: any): boolean => {
    if (getMlAuthStatus().authenticated) return false;
    reply.code(409).send({ mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' });
    return true;
  };

  /** Promocoes do anuncio relidas agora no ML, com o que pode ser aderido. */
  app.get('/api/promocoes/anuncio/:itemId', async (req, reply) => {
    if (semMl(reply)) return;
    const { itemId } = req.params as { itemId: string };
    try {
      return { itemId: itemId.toUpperCase(), escritaHabilitada: config.promocoesEnabled, promocoes: await listarPromocoes(itemId.toUpperCase()) };
    } catch (err: any) {
      reply.code(err?.status === 404 ? 404 : 500);
      return { mensagem: err?.message || 'Erro ao ler as promocoes do anuncio' };
    }
  });

  /** Simula: rele no ML, monta o pedido e devolve a conta + token. Nao escreve nada. */
  app.post('/api/promocoes/simular', async (req, reply) => {
    if (semMl(reply)) return;
    const b = (req.body as any) || {};
    try {
      return await simularAdesao(b.itemId, { promocaoId: b.promocaoId, tipo: b.tipo, preco: b.preco, estoque: b.estoque });
    } catch (err: any) {
      reply.code(err instanceof AdesaoBloqueada ? 400 : err?.status === 404 ? 404 : 500);
      return { mensagem: err?.message || 'Erro ao simular a adesao' };
    }
  });

  /** Adere de verdade: token da simulacao + confirmacao "ADERIR" + PROMOCOES_ENABLED=true. */
  app.post('/api/promocoes/aderir', async (req, reply) => {
    if (semMl(reply)) return;
    const { token, confirmacao } = (req.body as { token?: string; confirmacao?: string }) || {};
    if (!token) {
      reply.code(400);
      return { mensagem: 'Informe o token da simulacao.' };
    }
    if (confirmacao !== 'ADERIR') {
      reply.code(400);
      return { mensagem: 'Confirmacao ausente. Envie confirmacao: "ADERIR".' };
    }
    try {
      const r = await aderir(token);
      reply.code(r.status === 'sucesso' ? 200 : 502);
      return r.status === 'sucesso' ? r : { ...r, mensagem: r.erro };
    } catch (err: any) {
      reply.code(err instanceof AdesaoBloqueada ? 409 : 500);
      return { mensagem: err?.message || 'Erro ao aderir' };
    }
  });

  app.get('/api/promocoes/adesoes', async () => ({ escritaHabilitada: config.promocoesEnabled, items: lerHistoricoAdesoes() }));
}
