import { describe, expect, it } from 'vitest';
import { taxaConversao } from './conversion';

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
