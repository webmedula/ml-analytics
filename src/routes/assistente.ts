import { FastifyInstance } from 'fastify';
import { executarFerramenta, FERRAMENTAS } from '../assistant/ferramentas';
import { logger } from '../logger';

/**
 * FERRAMENTAS DO ASSISTENTE EXPOSTAS PARA O mcs-gerente (v34).
 *
 * O bot do Telegram passou a morar num servico proprio (mcs-gerente), que conversa com os tres
 * sistemas da MCS por API. As ferramentas continuam AQUI, rodando o mesmo codigo que alimenta o
 * painel — o Gerente so pergunta quais existem e pede pra executar.
 *
 * Por que o Gerente busca a lista em vez de ter uma copia: ferramenta nova criada aqui aparece
 * pro bot sozinha, sem precisar atualizar dois servicos ao mesmo tempo.
 *
 * Tudo aqui e LEITURA (as ferramentas nunca alteram anuncio, preco nem estoque; consultar_sql so
 * aceita SELECT). O POST existe porque a entrada pode ser um SQL longo, que nao cabe bem em URL.
 * Protegido pelo x-api-key de /api/* (hook em server.ts).
 */
export async function assistenteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assistente/ferramentas', async () => {
    return { ferramentas: FERRAMENTAS };
  });

  app.post('/api/assistente/ferramenta/:nome', async (req) => {
    const { nome } = req.params as { nome: string };
    const entrada = (req.body as { entrada?: unknown } | undefined)?.entrada ?? {};
    try {
      return { saida: await executarFerramenta(nome, entrada) };
    } catch (err: any) {
      // Erro volta como dado (200), igual acontecia dentro do bot: o modelo explica a falha ao
      // usuario em vez de a conversa inteira cair.
      logger.warn(`[ASSISTENTE] Ferramenta ${nome} falhou:`, err?.message || err);
      return { saida: { erro: err?.message || String(err) } };
    }
  });
}
