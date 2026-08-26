import { FastifyInstance } from 'fastify';
import { consultar, ConsultaInvalida, descreverEsquema } from '../db/banco';
import { sincronizar } from '../db/ingestao';
import { getMlAuthStatus } from '../ml/mlOauthClient';

/**
 * Acesso ao banco: consulta por SQL (somente leitura), esquema e sincronizacao.
 *
 * Isso e o que tira o teto do sistema. Ate aqui cada pergunta nova exigia funcao nova; com SELECT
 * livre sobre a base, comparar meses, agrupar por familia ou cruzar promocao com margem passa a ser
 * uma consulta — e a CONTA e feita pelo SQLite, nao pelo modelo, que e o que preserva a exatidao.
 */
export async function dadosRoutes(app: FastifyInstance): Promise<void> {
  /** Roda um SELECT. Aceita ?sql= (mais pratico no navegador) ou corpo JSON {sql}. */
  const responderConsulta = async (sql: string | undefined, limite: unknown, reply: any) => {
    if (!sql) {
      return {
        mensagem: 'Informe a consulta em ?sql=... (apenas SELECT).',
        exemplo: "SELECT sku, SUM(bruto) AS bruto FROM vendas WHERE data >= '2026-08-01' GROUP BY sku ORDER BY bruto DESC LIMIT 10",
        esquema: '/api/dados/esquema',
      };
    }
    try {
      const n = Number(limite);
      return consultar(sql, Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 200);
    } catch (err: any) {
      reply.code(err instanceof ConsultaInvalida ? 400 : 500);
      return { mensagem: err?.message || 'Erro na consulta' };
    }
  };

  app.get('/api/dados/consulta', async (req, reply) => {
    const { sql, limite } = req.query as { sql?: string; limite?: string };
    return responderConsulta(sql, limite, reply);
  });

  app.post('/api/dados/consulta', async (req, reply) => {
    const { sql, limite } = (req.body ?? {}) as { sql?: string; limite?: number };
    return responderConsulta(sql, limite, reply);
  });

  /** O esquema com contagem de linhas — o que alguem (ou um modelo) precisa ler pra escrever SQL. */
  app.get('/api/dados/esquema', async () => ({ esquema: descreverEsquema() }));

  /** Dispara a sincronizacao e espera. ?dias= puxa mais passado numa primeira carga. */
  app.post('/api/dados/sincronizar', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { dias } = req.query as { dias?: string };
    try {
      const n = Number(dias);
      return await sincronizar(Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30);
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao sincronizar' };
    }
  });

  // Versoes em /debug (mesma chave, aceita ?key=) pra abrir direto no navegador.
  app.get('/debug/consulta', async (req, reply) => {
    const { sql, limite } = req.query as { sql?: string; limite?: string };
    return responderConsulta(sql, limite, reply);
  });

  app.get('/debug/esquema', async () => ({ esquema: descreverEsquema() }));

  app.get('/debug/sincronizar', async (req, reply) => {
    if (!getMlAuthStatus().authenticated) {
      reply.code(409);
      return { mensagem: 'Mercado Livre nao autorizado.' };
    }
    const { dias } = req.query as { dias?: string };
    try {
      const n = Number(dias);
      return await sincronizar(Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30);
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro ao sincronizar' };
    }
  });
}
