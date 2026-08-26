import { describe, expect, it } from 'vitest';
import { montarIndice, normalizarParaComparacao, separarKit, similaridade, sugerirCorrespondencia } from './skuMatch';

// Codigos reais da conta, com os defeitos reais observados no CSV de lacunas.
const skusDoTiny = ['MCS-ABR7.6X550', 'MCS5590', 'MCS9102', 'MCS9155', 'MCS5620', 'MCS9029', 'AR24V'];
const custos = { 'MCS-ABR7.6X550': 0.42, 'MCS5590': 9.9, 'MCS9102': 11.27, 'MCS9155': 4.0, 'MCS5620': 31.44 };
const indice = montarIndice(skusDoTiny, custos);

describe('normalizarParaComparacao', () => {
  it('apaga a pontuacao que separa codigos iguais', () => {
    expect(normalizarParaComparacao('MCS-ABR7.6X550')).toBe('MCSABR76X550');
    expect(normalizarParaComparacao('mcs abr 7.6 x 550')).toBe('MCSABR76X550');
    expect(normalizarParaComparacao(null)).toBe('');
  });
});

describe('separarKit', () => {
  it('reconhece kit e ignora codigo simples', () => {
    expect(separarKit('MCS9102+MCS9155')).toEqual(['MCS9102', 'MCS9155']);
    expect(separarKit('MCS9102 / MCS9155')).toEqual(['MCS9102', 'MCS9155']);
    expect(separarKit('MCS9102')).toBeNull();
  });
});

describe('sugerirCorrespondencia', () => {
  it('casa o mesmo codigo escrito com hifen diferente', () => {
    const s = sugerirCorrespondencia('MCSABR-7.6X550', indice)!;
    expect(s.skuSugerido).toBe('MCS-ABR7.6X550');
    expect(s.confianca).toBe('alta');
    expect(s.custo).toBe(0.42);
  });

  it('soma o custo de um kit quando todo componente tem custo', () => {
    const s = sugerirCorrespondencia('MCS9102+MCS9155', indice)!;
    expect(s.componentes).toEqual(['MCS9102', 'MCS9155']);
    expect(s.custo).toBe(15.27);
    expect(s.confianca).toBe('alta');
  });

  it('kit com componente sem custo NAO devolve soma pela metade', () => {
    // MCS9029 existe no Tiny mas nao tem custo cadastrado.
    const s = sugerirCorrespondencia('MCS9102+MCS9029', indice)!;
    expect(s.custo).toBeNull();
    expect(s.motivo).toMatch(/nem todo componente/i);
  });

  it('acha o codigo embutido quando colaram o titulo no campo SKU', () => {
    const s = sugerirCorrespondencia('Farol Auxiliar Milha Redondo 9 Led 27w 9v-60v Universal - MCS5590', indice)!;
    expect(s.skuSugerido).toBe('MCS5590');
    expect(s.confianca).toBe('media');
  });

  it('prefere o codigo mais longo, senao aponta o produto errado da familia', () => {
    const comCurto = montarIndice(['MCS55', 'MCS5590'], {});
    const s = sugerirCorrespondencia('Farol Universal - MCS5590', comCurto)!;
    expect(s.skuSugerido).toBe('MCS5590');
  });

  it('codigo desconhecido nao inventa correspondencia', () => {
    expect(sugerirCorrespondencia('13598773', indice)).toBeNull();
    expect(sugerirCorrespondencia('TAPETE60X60', indice)).toBeNull();
  });

  it('parecido vira sugestao FRACA e avisa pra conferir', () => {
    const s = sugerirCorrespondencia('MCS91020', indice);
    if (s) {
      expect(s.confianca).toBe('baixa');
      expect(s.motivo).toMatch(/CONFERIR/);
    }
  });

  it('sugestao sem custo no Tiny vem com custo null, nao zero', () => {
    const s = sugerirCorrespondencia('MCS 9029', indice)!;
    expect(s.skuSugerido).toBe('MCS9029');
    expect(s.custo).toBeNull();
  });
});

describe('similaridade', () => {
  it('vai de 1 (igual) a 0 (nada a ver)', () => {
    expect(similaridade('ABC', 'ABC')).toBe(1);
    expect(similaridade('ABC', '')).toBe(0);
    expect(similaridade('MCS9102', 'MCS9103')).toBeGreaterThan(0.8);
    expect(similaridade('MCS9102', 'AR24V')).toBeLessThan(0.3);
  });
});
