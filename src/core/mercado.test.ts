import { describe, expect, it } from 'vitest';
import { agruparTendencias, compararCategoria, contarCategorias, deveTirarFoto, pareceIdDeCategoria, textoDoRadar, CategoriaNaFoto } from './mercado';

const item = (id: string, posicao: number, nosso = false, titulo = `Produto ${id}`) => ({ id, posicao, tipo: 'PRODUCT', titulo, preco: 10, nosso, link: null });
const cat = (maisVendidos: any[], termos: string[] = []): CategoriaNaFoto => ({
  id: 'MLB1', nome: 'Iluminação', anunciosDaMcs: 5, maisVendidos, tendencias: agruparTendencias(termos.map((keyword) => ({ keyword }))),
});

describe('mercado', () => {
  it('agrupa as 50 tendências na ordem do ML', () => {
    const t = agruparTendencias(Array.from({ length: 50 }, (_, i) => ({ keyword: `t${i}` })));
    expect(t[0].grupo).toBe('crescendo');
    expect(t[9].grupo).toBe('crescendo');
    expect(t[10].grupo).toBe('mais_buscado');
    expect(t[30].grupo).toBe('popular');
  });

  it('reconhece id de categoria', () => {
    expect(pareceIdDeCategoria('MLB1234')).toBe(true);
    expect(pareceIdDeCategoria('luminaria')).toBe(false);
  });

  it('conta categorias por anúncio', () => {
    expect(contarCategorias([{ category_id: 'A' }, { category_id: 'B' }, { category_id: 'B' }, {}], 1)).toEqual([{ id: 'B', anuncios: 2 }]);
  });

  it('compara duas fotos', () => {
    const antes = cat([item('P1', 1), item('P2', 2, true), item('P3', 8), item('P9', 20, true)], ['a']);
    const agora = cat([item('P3', 2), item('P2', 1, true), item('P4', 3)], ['a', 'b']);
    const m = compararCategoria(agora, antes);
    expect(m.nossos).toEqual([{ titulo: 'Produto P2', posicao: 1, antes: 2 }]);
    expect(m.nossosQueSairam).toEqual([{ titulo: 'Produto P9', antes: 20 }]);
    expect(m.entraram.map((e) => e.id)).toEqual(['P4']);
    expect(m.subiram).toEqual([{ titulo: 'Produto P3', posicao: 2, antes: 8 }]);
    expect(m.tendenciasNovas).toEqual(['b']);
    const texto = textoDoRadar({ data: '2026-11-30T09:00:00Z', categorias: [agora] }, { data: '2026-11-23T09:00:00Z', categorias: [antes] }, [m]);
    expect(texto).toContain('Nosso em 1º: Produto P2 (subiu de 2º)');
    expect(texto).toContain('Saiu da lista (era 20º)');
    expect(texto).toContain('Buscas em alta: b');
  });

  it('sem foto anterior não inventa mudança', () => {
    const m = compararCategoria(cat([item('P1', 1, true)]), undefined);
    expect(m.nossos[0].antes).toBeNull();
    expect(m.entraram).toEqual([]);
  });

  it('foto: primeira, depois de 7 dias, e segunda de manhã', () => {
    expect(deveTirarFoto(new Date('2026-11-27T12:00:00Z'), null)).toBe(true);
    // sexta, foto de ontem: nao
    expect(deveTirarFoto(new Date('2026-11-27T12:00:00Z'), '2026-11-26T12:00:00Z')).toBe(false);
    // segunda 30/11 07h Brasilia (10h UTC), ultima foto sexta: sim
    expect(deveTirarFoto(new Date('2026-11-30T10:00:00Z'), '2026-11-27T12:00:00Z')).toBe(true);
    // segunda 05h Brasilia: ainda nao
    expect(deveTirarFoto(new Date('2026-11-30T08:00:00Z'), '2026-11-27T12:00:00Z')).toBe(false);
    // segunda, ja tirou hoje
    expect(deveTirarFoto(new Date('2026-11-30T12:00:00Z'), '2026-11-30T09:30:00Z')).toBe(false);
  });
});
