import { describe, expect, it } from 'vitest';
import { situacaoDaPromocao, contaDaVenda, montarLinha, normalizarPromocao, ordenarLinhas, situacaoDoStatus, chaveDaPromocao, PromocoesResult } from './promocoes';
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

  it('candidato de campanha sem price usa o teto da faixa (como a tela do ML) e o preco atual como original', () => {
    const p = normalizarPromocao({ type: 'DEAL', status: 'candidate', suggested_discounted_price: 35.39, min_discounted_price: 30, max_discounted_price: 36 }, 78.9);
    expect(p.precoProposto).toBe(36);
    expect(p.precoOriginal).toBe(78.9);
    expect(p.mlPercentual).toBeNull();
  });

  it('registro estranho nao quebra', () => {
    expect(normalizarPromocao({}, null)).toMatchObject({ tipo: 'DESCONHECIDO', situacao: 'outra', precoProposto: null });
  });

  it('status do ML vira situacao', () => {
    expect(situacaoDoStatus('candidate')).toBe('proposta');
    expect(situacaoDoStatus('started')).toBe('ativa');
    expect(situacaoDoStatus('pending')).toBe('ativa');
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
  const ml = montarLinha(item, normalizarPromocao({ type: 'MARKETPLACE_CAMPAIGN', status: 'started', price: 43.51, original_price: 78.9, meli_percentage: 3 }, 78.9), { atual: 10, proposta: 6 }, 2, '2026-10-01T00:00:00Z');

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
    expect(linhaEmTexto(nova)).toMatch(/R\$ 78,90 → R\$ 43,90 \(-44,4% do cheio\)/);
  });

  it('chave estavel por anuncio, tipo e campanha', () => {
    expect(chaveDaPromocao('MLB1', { tipo: 'DEAL', promocaoId: 'P-1', ofertaId: null })).toBe('MLB1|DEAL|P-1');
  });
});

// Resposta REAL do ML para MLB4109133481 em 2026-11-03 (via /debug/promocoes), resumida.
const REAL = [
  { id: 'LGH-MLB1000', type: 'LIGHTNING', ref_id: 'CANDIDATE-MLB4109133481-77687047774', status: 'candidate', price: 76.53, original_price: 78.9, min_discounted_price: 15.79, max_discounted_price: 71.01, suggested_discounted_price: 67.07 },
  { id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', sub_type: 'FLEXIBLE_PERCENTAGE', status: 'started', price: 36.99, original_price: 78.9, name: 'OUTUBRO 2026' },
  { id: 'P-MLB18099366', type: 'PRICE_MATCHING', status: 'started', price: 35.88, meli_percentage: 2.7, seller_percentage: 51.8, original_price: 78.9 },
  { id: 'P-MLB18055120', type: 'SMART_LIGHTNING', status: 'pending', price: 35, meli_percentage: 3.3, seller_percentage: 52.3, original_price: 78.9 },
  { type: 'PRICE_DISCOUNT', status: 'candidate', price: 0, original_price: 78.9, name: '', suggested_discounted_price: 70.22 },
  { id: 'P-MLB17909028', type: 'DEAL', status: 'candidate', price: 0, original_price: 78.9, name: '11.11 da Black', max_discounted_price: 35.88, suggested_discounted_price: 27.99 },
];

describe('resposta real do ML (MLB4109133481)', () => {
  const ativa = 'C-MLB5941729';
  const n = REAL.map((r) => normalizarPromocao(r, 78.9, ativa));

  it('a campanha propria que define o preco e a unica "ativa"', () => {
    expect(n.filter((p) => p.situacao === 'ativa').map((p) => p.promocaoId)).toEqual(['C-MLB5941729']);
  });

  it('oferta pronta started que nao define o preco e proposta; pending e programada', () => {
    expect(n[2].situacao).toBe('proposta');
    expect(n[3].situacao).toBe('programada');
    expect(n[3].rotulo).toContain('relampago');
  });

  it('candidato usa o teto da faixa, nao o price nem o sugerido', () => {
    expect(n[0].precoProposto).toBe(71.01);
    expect(n[5].precoProposto).toBe(35.88);
  });

  it('oferta criada usa o proprio price e o ML banca a parte dele', () => {
    expect(n[3].precoProposto).toBe(35);
    const l = montarLinha(item, n[3], { atual: 6, proposta: 5 }, 0, 'x', 36.99);
    expect(l.mlBanca).toBe(2.6); // 3,3% de 78,90; a tela do ML mostrou R$ 2,64
    expect(l.precoAtual).toBe(36.99);
    expect(l.precoCheio).toBe(78.9);
  });

  it('sem sale_price, cai no status cru', () => {
    expect(normalizarPromocao(REAL[1], 78.9).situacao).toBe('ativa');
    expect(normalizarPromocao(REAL[2], 78.9).situacao).toBe('proposta');
  });
});

describe('parsePrecoDeVenda', () => {
  it('le amount, regular_amount e a promocao ativa', async () => {
    const { parsePrecoDeVenda } = await import('../ml/mlClient');
    expect(parsePrecoDeVenda({ amount: 36.99, regular_amount: 78.9, metadata: { promotion_id: 'C-MLB5941729', promotion_type: 'seller_campaign' } }))
      .toEqual({ preco: 36.99, precoCheio: 78.9, promocaoAtivaId: 'C-MLB5941729', ofertaAtivaId: 'C-MLB5941729', promocaoAtivaTipo: 'SELLER_CAMPAIGN' });
    // formato real (MLB3752079801, 2026-11-04)
    expect(parsePrecoDeVenda({ amount: 1733, regular_amount: 2899, metadata: { campaign_id: 'P-MLB18193008', promotion_id: 'OFFER-MLB3752079801-14229011941', promotion_type: 'marketplace_campaign' } }))
      .toMatchObject({ preco: 1733, promocaoAtivaId: 'P-MLB18193008', ofertaAtivaId: 'OFFER-MLB3752079801-14229011941' });
    expect(parsePrecoDeVenda(null)).toBeNull();
  });
});

describe('ativa / programada / proposta (tela do ML, MLB3752079801 em 2026-11-04)', () => {
  const agora = Date.parse('2026-11-04T21:00:00Z');
  it('pending e programada (com ou sem horario na resposta)', () => {
    expect(situacaoDaPromocao('SMART_LIGHTNING', 'pending', 'P-1', 'P-9', '2026-11-06T03:00:00Z', agora)).toBe('programada');
    expect(situacaoDaPromocao('SMART_LIGHTNING', 'pending', 'P-1', 'P-9', null, agora)).toBe('programada');
  });
  it('a que define o preco e ativa; campanha que comeca depois e programada', () => {
    expect(situacaoDaPromocao('SMART', 'started', 'P-9', 'P-9', '2026-11-01T03:00:00Z', agora)).toBe('ativa');
    expect(situacaoDaPromocao('DEAL', 'started', 'P-2', 'P-9', '2026-11-12T03:00:00Z', agora)).toBe('programada');
    expect(situacaoDaPromocao('DEAL', 'candidate', 'P-3', 'P-9', null, agora)).toBe('proposta');
  });
  it('campanha propria sem adesao continua na lista como proposta', () => {
    const p = normalizarPromocao({ id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', status: 'candidate', price: 2754.05, original_price: 2899, name: 'OUTUBRO 2026' }, 2899, 'P-9');
    expect(p.situacao).toBe('proposta');
  });
});

// Resposta REAL do ML para MLB3752079801 em 2026-11-04 e o que a tela do ML mostrava no mesmo dia.
const REAL2 = [
  { id: 'LGH-MLB1000', type: 'LIGHTNING', ref_id: 'CANDIDATE-MLB3752079801-77725829657', status: 'candidate', price: 2812.03, original_price: 2899, min_discounted_price: 579.8, max_discounted_price: 2609.1, suggested_discounted_price: 2464.14 },
  { id: 'DOD-MLB1000', type: 'DOD', status: 'candidate', price: 2812.03, original_price: 2899, min_discounted_price: 579.8, max_discounted_price: 2609.1, suggested_discounted_price: 2464.14 },
  { id: 'P-MLB18193008', type: 'SMART', ref_id: 'OFFER-MLB3752079801-14229011941', status: 'started', price: 1733, meli_percentage: 2.1, original_price: 2899, name: 'Meli Essencial Promo Nov' },
  { id: 'P-MLB18055120', type: 'SMART_LIGHTNING', ref_id: 'OFFER-MLB3752079801-14276328303', status: 'pending', price: 1733, meli_percentage: 2.7, original_price: 2899 },
  { id: 'P-MLB17909028', type: 'DEAL', status: 'candidate', price: 0, original_price: 2899, name: '11.11 da Black', min_discounted_price: 579.8, max_discounted_price: 2812.03, suggested_discounted_price: 2522.13 },
  { id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', status: 'candidate', price: 0, original_price: 2899, name: 'OUTUBRO 2026', min_discounted_price: 698.02, max_discounted_price: 2754.05, suggested_discounted_price: 2754.05 },
];

describe('MLB3752079801: bate com a tela do ML', () => {
  const ativa = { promocaoId: 'P-MLB18193008', ofertaId: 'OFFER-MLB3752079801-14229011941' };
  const n = REAL2.map((r) => normalizarPromocao(r, 2899, ativa, 1733));
  it('Meli Essencial ATIVA, relampago de 6/nov PROGRAMADA, o resto nova proposta', () => {
    expect(n.map((p) => p.situacao)).toEqual(['proposta', 'proposta', 'ativa', 'programada', 'proposta', 'proposta']);
  });
  it('a ativa tambem e achada so pelo id da oferta', () => {
    expect(normalizarPromocao(REAL2[2], 2899, { ofertaId: 'OFFER-MLB3752079801-14229011941' }, 1733).situacao).toBe('ativa');
  });
  it('candidatas do ML nao propoem preco acima do de hoje; campanha propria usa o sugerido (R$ 2.754,05 como na tela)', () => {
    expect(n[0].precoProposto).toBe(1733);
    expect(n[4].precoProposto).toBe(1733);
    expect(n[5].precoProposto).toBe(2754.05);
  });
});

describe('contaDaVenda com o frete gratis do ML (v40)', () => {
  // MLB5332741758 em 2026-11-04: tarifa e frete de /listing_prices e /shipping_options/free.
  it('bate com o "voce recebe" da tela do ML', () => {
    const bf = contaDaVenda({ precoAtual: 172.69, precoProposto: 172.69, precoOriginal: 249.99, mlPercentual: null, tarifaAtual: 20.72, tarifaProposta: 20.72, fretePorUnidade: 18, freteAtual: 21.75, freteProposto: 21.75 });
    expect(bf.voceRecebe).toBe(130.22);
    const outubro = contaDaVenda({ precoAtual: 172.69, precoProposto: 237.49, precoOriginal: 249.99, mlPercentual: null, tarifaAtual: 20.72, tarifaProposta: 28.5, fretePorUnidade: 18, freteAtual: 21.75, freteProposto: 25.45 });
    expect(outubro.voceRecebe).toBe(183.54);
    expect(outubro.voceRecebeHoje).toBe(130.22);
  });
  it('sem o frete do ML, cai na media de 30 dias', () => {
    const c = contaDaVenda({ precoAtual: 100, precoProposto: 90, precoOriginal: 100, mlPercentual: null, tarifaAtual: 12, tarifaProposta: 10.8, fretePorUnidade: 20 });
    expect(c.voceRecebe).toBe(59.2);
    expect(c.estimativa).toMatch(/frete medio/);
  });
});

// MLB3827163247 em 2026-11-05: tela do ML mostra 11.11 e Black Friday a 203,69 e OUTUBRO 2026 a 284,99.
describe('preco proposto como a tela do ML (MLB3827163247)', () => {
  it('campanha do ML: teto da faixa, sem passar do preco de hoje', () => {
    const deal = { id: 'P-MLB17909028', type: 'DEAL', status: 'candidate', price: 0, original_price: 299.99, min_discounted_price: 60, max_discounted_price: 203.69, suggested_discounted_price: 173.69 };
    expect(normalizarPromocao(deal, 299.99, null, 203.69).precoProposto).toBe(203.69);
    expect(normalizarPromocao(deal, 299.99, null, 190).precoProposto).toBe(190);
  });
  it('campanha propria: teto da faixa (o % da campanha)', () => {
    const sc = { id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', status: 'candidate', price: 0, original_price: 299.99, min_discounted_price: 84, max_discounted_price: 284.99, suggested_discounted_price: 209.99 };
    expect(normalizarPromocao(sc, 299.99, null, 203.69).precoProposto).toBe(284.99);
  });
});

