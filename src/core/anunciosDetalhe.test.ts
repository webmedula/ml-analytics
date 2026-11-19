import { describe, expect, it } from 'vitest';
import { montarDetalhe } from './anunciosDetalhe';
import { custoManualDe, lerReais } from './custosManuais';

describe('dados do anúncio como na Gestão de anúncios do ML', () => {
  it('"Você recebe" = preço em promoção − tarifa − frete (MLB3616985151 na tela do ML: R$ 171,50)', () => {
    const d = montarDetalhe({
      item: { price: 229.99, permalink: 'https://x', listing_type_id: 'gold_special', available_quantity: 124, health: 0.76, status: 'active', shipping: { free_shipping: true } },
      precoAgora: 223.09, tarifa: 26.04, frete: 25.55, visitas7: 1874, vendas7: 234,
    });
    expect(d).toMatchObject({ preco: 229.99, precoPromocao: 223.09, tipoRotulo: 'Clássico', voceRecebe: 171.5, estoque: 124, qualidade: 76, conversao7: 12.5 });
  });

  it('envio por conta do comprador: sem frete; sem tarifa lida, "você recebe" fica em branco', () => {
    const base = { item: { price: 55, listing_type_id: 'gold_pro', shipping: { free_shipping: false } }, precoAgora: 45.99, frete: null, visitas7: 342, vendas7: 29 };
    expect(montarDetalhe({ ...base, tarifa: 5.52 })).toMatchObject({ frete: 0, voceRecebe: 40.47, tipoRotulo: 'Premium' });
    expect(montarDetalhe({ ...base, tarifa: null }).voceRecebe).toBeNull();
    expect(montarDetalhe({ item: null, precoAgora: null, tarifa: null, frete: null, visitas7: null, vendas7: null })).toMatchObject({ preco: null, voceRecebe: null, conversao7: null });
  });
});

describe('custo manual', () => {
  const m = {
    'sku:RL-1': { tipo: 'sku' as const, chave: 'RL-1', custo: 30, obs: null, em: '' },
    'anuncio:MLB9': { tipo: 'anuncio' as const, chave: 'MLB9', custo: 55, obs: null, em: '' },
  };
  it('o do anúncio vale mais que o do SKU; SKU normalizado', () => {
    expect(custoManualDe(m, 'MLB1', ' rl-1 ')?.custo).toBe(30);
    expect(custoManualDe(m, 'mlb9', 'RL-1')?.custo).toBe(55);
    expect(custoManualDe(m, 'MLB2', null)).toBeNull();
  });
  it('lê valores em reais como a pessoa digita', () => {
    expect(lerReais('1.234,56')).toBe(1234.56);
    expect(lerReais('75,5')).toBe(75.5);
    expect(lerReais('R$ 75.50')).toBe(75.5);
    expect(lerReais(12)).toBe(12);
    expect(lerReais('')).toBeNaN();
  });
});
