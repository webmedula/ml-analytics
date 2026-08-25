import { describe, expect, it } from 'vitest';
import { extrairProdutos, normalizarProduto } from './tinyClient';

describe('extrairProdutos', () => {
  it('aceita as formas que o Tiny ja usou pra devolver lista', () => {
    const esperado = [{ sku: 'A' }];
    expect(extrairProdutos(esperado)).toEqual(esperado);
    expect(extrairProdutos({ itens: esperado })).toEqual(esperado);
    expect(extrairProdutos({ produtos: esperado })).toEqual(esperado);
    expect(extrairProdutos({ data: esperado })).toEqual(esperado);
    expect(extrairProdutos({ retorno: { itens: esperado } })).toEqual(esperado);
  });

  it('formato desconhecido devolve vazio em vez de estourar', () => {
    expect(extrairProdutos({ algo: 'inesperado' })).toEqual([]);
    expect(extrairProdutos(null)).toEqual([]);
  });
});

describe('normalizarProduto', () => {
  it('le o custo de qualquer um dos nomes que o Tiny usa', () => {
    expect(normalizarProduto({ sku: 'A', precoCusto: 12.5 }).custo).toBe(12.5);
    expect(normalizarProduto({ sku: 'A', preco_custo: 12.5 }).custo).toBe(12.5);
    expect(normalizarProduto({ sku: 'A', precoCustoMedio: 9.9 }).custo).toBe(9.9);
    expect(normalizarProduto({ sku: 'A', custo: 7 }).custo).toBe(7);
  });

  it('aceita custo vindo como texto com virgula', () => {
    expect(normalizarProduto({ sku: 'A', precoCusto: '15,90' }).custo).toBe(15.9);
  });

  it('custo zero ou ausente vira null — zero fingindo ser custo estragaria a margem', () => {
    expect(normalizarProduto({ sku: 'A', precoCusto: 0 }).custo).toBeNull();
    expect(normalizarProduto({ sku: 'A' }).custo).toBeNull();
    expect(normalizarProduto({ sku: 'A', precoCusto: 'abc' }).custo).toBeNull();
  });

  it('prefere precoCusto sobre o custo medio quando os dois existem', () => {
    expect(normalizarProduto({ sku: 'A', precoCusto: 10, precoCustoMedio: 8 }).custo).toBe(10);
  });

  it('desembrulha o produto quando vem aninhado', () => {
    expect(normalizarProduto({ produto: { sku: 'ASW-005', precoCusto: 3.2 } }).sku).toBe('ASW-005');
  });

  it('cai no codigo quando nao ha sku, e limpa espacos', () => {
    expect(normalizarProduto({ codigo: '  FORMAGELO ' }).sku).toBe('FORMAGELO');
    expect(normalizarProduto({ precoCusto: 5 }).sku).toBeNull();
  });
});
