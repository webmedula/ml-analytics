import { describe, expect, it } from 'vitest';
import { contaDaVenda, montarLinha, normalizarPromocao, ordenarLinhas, situacaoDoStatus, chaveDaPromocao, PromocoesResult } from './promocoes';
import { filtrarPromocoes, linhaEmTexto } from './promocoesConsulta';

const item = { id: 'MLB4109133481', title: 'Sensor Tpms', permalink: 'x', price: 78.9 };

describe('normalizarPromocao', () => {
  it('le um candidato co-participado (formato da doc: price, original_price, meli/seller_percentage)', () => {
    const p = normalizarPromocao(
      { id: 'P-MLB1', type: 'SMART', status: 'candidate', price: 700, original_price: 1000, meli_percentage: 5, seller_percentage: 25, start_date: 'a', end_date: 'b', ref_id: 'OFFER-1' },
      1000,
    );
    expect(p).toMatchObject({ tipo: 'SMART', situacao: 'proposta', precoProposto: 700, precoOriginal: 1000, mlPercentual: 5, fim: 'b', ofertaId: 'OFFER-1' });
  });

  it('candidato de campanha sem price usa o preco sugerido e o preco atual como original', () => {
    const p = normalizarPromocao({ type: 'DEAL', status: 'candidate', suggested_discounted_price: 35.39, min_discounted_price: 30, max_discounted_price: 36 }, 78.9);
    expect(p.precoProposto).toBe(35.39);
    expect(p.precoOriginal).toBe(78.9);
    expect(p.mlPercentual).toBeNull();
  });

  it('registro estranho nao quebra', () => {
    expect(normalizarPromocao({}, null)).toMatchObject({ tipo: 'DESCONHECIDO', situacao: 'outra', precoProposto: null });
  });

  it('status do ML vira situacao', () => {
    expect(situacaoDoStatus('candidate')).toBe('proposta');
    expect(situacaoDoStatus('started')).toBe('participando');
    expect(situacaoDoStatus('pending')).toBe('participando');
    expect(situacaoDoStatus('finished')).toBe('encerrada');
  });
});

describe('contaDaVenda', () => {
  it('soma a parte do ML, desconta tarifa e frete, compara com hoje', () => {
    const c = contaDaVenda({ precoAtual: 1000, precoProposto: 700, precoOriginal: 1000, mlPercentual: 5, tarifaAtual: 120, tarifaProposta: 84, fretePorUnidade: 20 });
    expect(c.mlBanca).toBe(50);
    expect(c.voceRecebe).toBe(646); // 700 + 50 - 84 - 20
    expect(c.voceRecebeHoje).toBe(860); // 1000 - 120 - 20
    expect(c.diferencaPorVenda).toBe(-214);
  });

  it('sem tarifa nao inventa numero', () => {
    const c = contaDaVenda({ precoAtual: 10, precoProposto: 8, precoOriginal: 10, mlPercentual: null, tarifaAtual: null, tarifaProposta: null, fretePorUnidade: null });
    expect(c.voceRecebe).toBeNull();
    expect(c.diferencaPorVenda).toBeNull();
  });
});

function resultado(linhas: ReturnType<typeof montarLinha>[]): PromocoesResult {
  return { atualizadoEm: '2026-11-03T12:00:00Z', apiDisponivel: true, avisoDaApi: null, anunciosAnalisados: 1, anunciosComErro: 0, truncado: false, itens: ordenarLinhas(linhas), vistas: {} };
}

describe('filtrarPromocoes', () => {
  const agora = Date.parse('2026-11-03T12:00:00Z');
  const velha = montarLinha(item, normalizarPromocao({ type: 'DEAL', status: 'candidate', price: 43.02, name: '11.11' }, 78.9), { atual: 10, proposta: 6 }, 2, '2026-10-01T00:00:00Z');
  const nova = montarLinha(item, normalizarPromocao({ type: 'LIGHTNING', status: 'candidate', price: 43.9 }, 78.9), { atual: 10, proposta: 6 }, 2, '2026-11-03T08:00:00Z');
  const ml = montarLinha(item, normalizarPromocao({ type: 'SMART', status: 'started', price: 43.51, original_price: 78.9, meli_percentage: 3 }, 78.9), { atual: 10, proposta: 6 }, 2, '2026-10-01T00:00:00Z');

  it('ordena pelas que menos tiram de cada venda', () => {
    const r = filtrarPromocoes({}, resultado([velha, nova]), agora) as any;
    expect(r.itens[0].tipo).toBe('LIGHTNING');
  });

  it('apenas_novas usa a primeira vez vista', () => {
    const r = filtrarPromocoes({ apenas_novas: true }, resultado([velha, nova, ml]), agora) as any;
    expect(r.total).toBe(1);
    expect(r.resumoEmTexto).toContain('Oferta relampago');
  });

  it('participando fica fora do padrao e entra quando pedido', () => {
    expect((filtrarPromocoes({}, resultado([velha, ml]), agora) as any).total).toBe(1);
    expect((filtrarPromocoes({ situacao: 'participando' }, resultado([velha, ml]), agora) as any).itens[0].mlBanca).toBeGreaterThan(0);
  });

  it('sem nada novo, resumoEmTexto e null (o aviso diario nao manda mensagem vazia)', () => {
    expect((filtrarPromocoes({ apenas_novas: true }, resultado([velha]), agora) as any).resumoEmTexto).toBeNull();
  });

  it('API recusada vira mensagem, nao erro', () => {
    const r = filtrarPromocoes({}, { ...resultado([]), apiDisponivel: false, avisoDaApi: '403' }, agora);
    expect(r).toMatchObject({ disponivel: false, mensagem: '403' });
  });

  it('texto legivel', () => {
    expect(linhaEmTexto(nova)).toMatch(/R\$ 78,90 → R\$ 43,90 \(-44.36%\)/);
  });

  it('chave estavel por anuncio, tipo e campanha', () => {
    expect(chaveDaPromocao('MLB1', { tipo: 'DEAL', promocaoId: 'P-1', ofertaId: null })).toBe('MLB1|DEAL|P-1');
  });
});
