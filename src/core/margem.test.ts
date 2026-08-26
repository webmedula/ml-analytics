import { describe, expect, it } from 'vitest';
import { classificarCusto, lacunasParaCsv, margemDaVenda, resumirLacunas, LacunaDoAnuncio } from './margem';

const custos = { 'MCS1010': 8.75 };
const semCusto = new Set(['MCS9102']);

describe('classificarCusto', () => {
  it('separa os quatro estados', () => {
    expect(classificarCusto('mcs1010', custos, semCusto)).toEqual({ estado: 'com_custo', custo: 8.75 });
    expect(classificarCusto('MCS9102', custos, semCusto).estado).toBe('sem_custo_no_tiny');
    expect(classificarCusto('SI-0011', custos, semCusto).estado).toBe('fora_do_tiny');
    expect(classificarCusto(null, custos, semCusto).estado).toBe('sem_sku');
    expect(classificarCusto('  ', custos, semCusto).estado).toBe('sem_sku');
  });

  it('custo zero no cache nao vira "com custo"', () => {
    expect(classificarCusto('X', { X: 0 }, new Set(['X'])).estado).toBe('sem_custo_no_tiny');
  });
});

describe('margemDaVenda', () => {
  it('desconta a mercadoria do liquido', () => {
    // 3 unidades vendidas, liquido 100, custo 20 cada => 100 - 60 = 40
    expect(margemDaVenda(100, 20, 3)).toEqual({ margem: 40, percentual: 40 });
  });

  it('sem custo devolve null, NUNCA zero — zero leria como "nao sobrou nada"', () => {
    expect(margemDaVenda(100, null, 3)).toEqual({ margem: null, percentual: null });
    expect(margemDaVenda(100, 0, 3)).toEqual({ margem: null, percentual: null });
  });

  it('margem negativa aparece como negativa, e nao some', () => {
    expect(margemDaVenda(50, 30, 3).margem).toBe(-40);
  });

  it('sem unidades nao inventa margem', () => {
    expect(margemDaVenda(100, 20, 0).margem).toBeNull();
  });
});

describe('resumirLacunas', () => {
  const lista: LacunaDoAnuncio[] = [
    { itemId: 'A', titulo: 'a', sku: 'MCS1010', origemDoSku: 'x', estado: 'com_custo', custo: 8.75, liquido: 100, unidades: 5 },
    { itemId: 'B', titulo: 'b', sku: null, origemDoSku: null, estado: 'sem_sku', custo: null, liquido: 900, unidades: 30 },
    { itemId: 'C', titulo: 'c', sku: 'Z', origemDoSku: 'x', estado: 'fora_do_tiny', custo: null, liquido: 0, unidades: 0 },
  ];

  it('conta anuncios e dinheiro separadamente', () => {
    const r = resumirLacunas(lista);
    expect(r.total).toBe(3);
    expect(r.porEstado.com_custo).toBe(1);
    expect(r.liquidoPorEstado.sem_sku).toBe(900);
  });

  it('cobertura por anuncio e por dinheiro divergem — e e por isso que as duas existem', () => {
    const r = resumirLacunas(lista);
    expect(r.cobertura).toBeCloseTo(33.3, 1);   // 1 de 3 anuncios
    expect(r.coberturaPorLiquido).toBeCloseTo(10, 1); // mas so 100 de 1000 reais
  });

  it('lista vazia nao divide por zero', () => {
    const r = resumirLacunas([]);
    expect(r.cobertura).toBe(0);
    expect(r.coberturaPorLiquido).toBe(0);
  });
});

describe('lacunasParaCsv', () => {
  it('escapa titulo com ponto-e-virgula e aspas em vez de quebrar a coluna', () => {
    const csv = lacunasParaCsv([
      { itemId: 'A', titulo: 'Kit 3 "tamanhos"; 300un', sku: null, origemDoSku: null, estado: 'sem_sku', custo: null, liquido: 0, unidades: 0 },
    ]);
    const linha = csv.split('\r\n')[1];
    expect(linha).toContain('"Kit 3 ""tamanhos""; 300un"');
    expect(csv.split('\r\n')[0].split(';')).toHaveLength(9);
  });

  it('leva BOM pro Excel em portugues abrir com acento', () => {
    expect(lacunasParaCsv([]).charCodeAt(0)).toBe(0xfeff);
  });
});
