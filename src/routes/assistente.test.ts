import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { assistenteRoutes } from './assistente';
import { FERRAMENTAS } from '../assistant/ferramentas';

/** v34: contrato com o mcs-gerente. Se isto mudar, o bot perde as ferramentas do analytics. */
describe('rotas do assistente (contrato com o mcs-gerente)', () => {
  async function app() {
    const a = Fastify();
    await a.register(assistenteRoutes);
    return a;
  }

  it('lista as mesmas ferramentas que o bot usava', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/assistente/ferramentas' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ferramentas.map((f: any) => f.name)).toEqual(FERRAMENTAS.map((f) => f.name));
  });

  it('ferramenta desconhecida volta como dado, nao como erro HTTP', async () => {
    const res = await (await app()).inject({
      method: 'POST', url: '/api/assistente/ferramenta/nao_existe', payload: { entrada: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().saida.erro).toContain('nao_existe');
  });

  it('aceita chamada sem corpo', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/assistente/ferramenta/nao_existe' });
    expect(res.statusCode).toBe(200);
  });
});
