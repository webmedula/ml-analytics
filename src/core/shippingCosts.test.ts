import { describe, expect, it } from 'vitest';
import { ratearFrete } from './shippingCosts';

describe('ratearFrete', () => {
  it('divide na proporcao do valor de cada linha, nao meio a meio', () => {
    // R$ 20 de frete num pedido de R$ 80 + R$ 20: quem vale 80% carrega 80% do custo.
    expect(ratearFrete(20, [80, 20])).toEqual([16, 4]);
  });

  it('linha unica carrega o frete inteiro', () => {
    expect(ratearFrete(18.5, [68])).toEqual([18.5]);
  });

  it('sem frete, ninguem paga nada', () => {
    expect(ratearFrete(0, [50, 50])).toEqual([0, 0]);
  });

  it('o rateio conserva o total (a menos do arredondamento de centavos)', () => {
    const partes = ratearFrete(33.33, [10, 20, 30, 40]);
    const soma = partes.reduce((s, v) => s + v, 0);
    expect(Math.abs(soma - 33.33)).toBeLessThanOrEqual(0.02);
  });

  it('linhas sem valor dividem igualmente, em vez de estourar na divisao por zero', () => {
    expect(ratearFrete(10, [0, 0])).toEqual([5, 5]);
  });

  it('pedido sem linhas nao gera rateio', () => {
    expect(ratearFrete(10, [])).toEqual([]);
  });
});
