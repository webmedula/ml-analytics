import { describe, expect, it } from 'vitest';
import { margemDaComissao, taxaConversao } from './conversion';

describe('taxaConversao — vendas / visitas em %', () => {
  it('calcula a conversao em porcentagem (1 casa)', () => {
    expect(taxaConversao(5, 100)).toBe(5);      // 5%
    expect(taxaConversao(3, 120)).toBe(2.5);    // 2.5%
    expect(taxaConversao(1, 3)).toBe(33.3);     // arredonda 1 casa
  });

  it('sem visitas => null (nao da pra calcular)', () => {
    expect(taxaConversao(0, 0)).toBeNull();
    expect(taxaConversao(2, 0)).toBeNull();
  });

  it('zero vendas com visitas => 0%', () => {
    expect(taxaConversao(0, 50)).toBe(0);
  });
});

describe('margemDaComissao', () => {
  it('diz quanto sobra de cada real vendido', () => {
    expect(margemDaComissao(100, 87)).toBe(87);
    expect(margemDaComissao(250, 200)).toBe(80);
  });

  it('arredonda para uma casa', () => {
    expect(margemDaComissao(3, 2)).toBe(66.7);
  });

  it('sem faturamento nao ha margem a calcular', () => {
    expect(margemDaComissao(0, 0)).toBeNull();
    expect(margemDaComissao(-1, 0)).toBeNull();
  });
});
