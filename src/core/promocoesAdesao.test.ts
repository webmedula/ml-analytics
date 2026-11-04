import { describe, expect, it } from 'vitest';
import { acharPromocao, AdesaoBloqueada, lerPromocao, montarPedido } from './promocoesAdesao';

// Resposta REAL do ML para MLB5332741758 em 2026-11-04 (debug enviado pelo usuario).
const REAL = [
  { id: 'P-MLB18055120', type: 'SMART_LIGHTNING', ref_id: 'CANDIDATE-MLB5332741758-77698728745', status: 'candidate', price: 172.69, meli_percentage: 3.1, seller_percentage: 27.8, original_price: 249.99, name: 'OFERTAS RELÂMPAGOS IMPERDÍVEIS', stock: { min: 1, max: 1 } },
  { id: 'P-MLB18193008', type: 'SMART', ref_id: 'OFFER-MLB5332741758-14261652810', status: 'started', price: 172.69, meli_percentage: 3.2, seller_percentage: 27.8, original_price: 249.99, name: 'Meli Essencial Promo Nov' },
  { id: 'P-MLB17911004', type: 'DEAL', status: 'pending', price: 172.69, original_price: 249.99, start_date: '2026-11-12T00:00:00-03:00', finish_date: '2026-12-01T00:00:00-03:00', name: 'Black Friday 2026' },
  { type: 'PRICE_DISCOUNT', status: 'candidate', price: 0, original_price: 249.99, name: '', min_discounted_price: 69.42, max_discounted_price: 237.49, suggested_discounted_price: 237.49 },
  { id: 'P-MLB17909028', type: 'DEAL', status: 'candidate', price: 0, original_price: 249.99, start_date: '2026-10-19T00:00:00-03:00', finish_date: '2026-11-12T00:00:00-03:00', name: '11.11 da Black', min_discounted_price: 50, max_discounted_price: 242.49, suggested_discounted_price: 217.49 },
  { id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', sub_type: 'FLEXIBLE_PERCENTAGE', status: 'candidate', price: 0, original_price: 249.99, start_date: '2026-10-09T00:00:00', finish_date: '2026-11-08T23:59:59', name: 'OUTUBRO 2026', min_discounted_price: 69.42, max_discounted_price: 237.49, suggested_discounted_price: 237.49 },
];
// sale_price do mesmo anuncio: metadata.campaign_id P-MLB18193008, promotion_id OFFER-...-14261652810, amount 172.69
const ATIVA = { promocaoId: 'P-MLB18193008', ofertaId: 'OFFER-MLB5332741758-14261652810' };
const L = REAL.map((r) => lerPromocao(r, ATIVA, 249.99, 172.69));

describe('lerPromocao (mesma regra da aba)', () => {
  it('so a nova proposta fica aberta: ativa e programada nao', () => {
    expect(L.map((p) => [p.tipo, p.situacao, p.aberta, p.suportada])).toEqual([
      ['SMART_LIGHTNING', 'proposta', true, true],
      ['SMART', 'ativa', false, true],
      ['DEAL', 'programada', false, true],
      ['PRICE_DISCOUNT', 'proposta', true, false],
      ['DEAL', 'proposta', true, true],
      ['SELLER_CAMPAIGN', 'proposta', true, true],
    ]);
  });
});

describe('montarPedido', () => {
  it('relampago co-participada aceita a oferta pelo ref_id', () => {
    expect(montarPedido(L[0], {}).corpo).toEqual({ promotion_type: 'SMART_LIGHTNING', promotion_id: 'P-MLB18055120', offer_id: 'CANDIDATE-MLB5332741758-77698728745' });
  });

  it('11.11 propoe o preco de hoje (como a aba), dentro da faixa', () => {
    expect(montarPedido(L[4], {})).toEqual({ corpo: { promotion_type: 'DEAL', promotion_id: 'P-MLB17909028', deal_price: 172.69 }, precoFinal: 172.69 });
    expect(() => montarPedido(L[4], { preco: 250 })).toThrow(/maximo/);
    expect(() => montarPedido(L[4], { preco: 40 })).toThrow(/minimo/);
  });

  it('campanha propria (OUTUBRO 2026) entra com preco', () => {
    expect(montarPedido(L[5], {}).corpo).toEqual({ promotion_type: 'SELLER_CAMPAIGN', promotion_id: 'C-MLB5941729', deal_price: 237.49 });
    expect(montarPedido(L[5], { preco: 200 }).precoFinal).toBe(200);
  });

  it('recusa a ativa, a programada e o que nao sabe fazer', () => {
    expect(() => montarPedido(L[1], {})).toThrow(/ATIVA/);
    expect(() => montarPedido(L[2], {})).toThrow(/PROGRAMADA/);
    expect(() => montarPedido(L[3], {})).toThrow(AdesaoBloqueada);
  });

  it('relampago comum pede preco e estoque nos limites', () => {
    const lgh = lerPromocao({ id: 'LGH-MLB1000', type: 'LIGHTNING', status: 'candidate', price: 76.53, original_price: 78.9, min_discounted_price: 15.79, max_discounted_price: 71.01, suggested_discounted_price: 67.07, stock: { min: 5, max: 3357 } }, null, 78.9, 78.9);
    expect(montarPedido(lgh, { preco: 60, estoque: 10 }).corpo).toEqual({ promotion_type: 'LIGHTNING', promotion_id: 'LGH-MLB1000', deal_price: 60, stock: 10 });
    expect(montarPedido(lgh, {}).corpo.stock).toBe(5);
    expect(() => montarPedido(lgh, { estoque: 2 })).toThrow(/ao menos 5/);
  });
});

describe('acharPromocao', () => {
  it('pelo id, ou pelo tipo quando ha uma so', () => {
    expect(acharPromocao(L, 'C-MLB5941729')?.nome).toBe('OUTUBRO 2026');
    expect(acharPromocao(L, null, 'smart_lightning')?.promocaoId).toBe('P-MLB18055120');
    expect(acharPromocao(L, 'nao-existe')).toBeNull();
  });
});
