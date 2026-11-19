import { describe, expect, it } from 'vitest';
import { comLucro, lucroDaPromocao, lucroDaVenda, montarFichas } from './lucro';
import type { ImpostosDoBackup } from './diagnosticoCustos';
import { filtrarPromocoes } from './promocoesConsulta';
import type { PromocoesResult } from './promocoes';

const impostos: ImpostosDoBackup = {
  disponivel: true,
  dados: {
    de: '2026-08', ate: '2026-10', meses: [], notasLidas: 10,
    regime: { crt: '3', nome: 'normal', observacao: null },
    vendas: {
      total: { valorDaVenda: 10000, impostos: 1000, percentual: 10, percentualTotTrib: null },
      porSku: [{ sku: 'RL-1', descricao: '', quantidade: 10, valorDaVenda: 1000, impostos: 200, percentual: 20, percentualTotTrib: null }],
    },
    importacoes: { porSku: [], observacao: '' },
  },
};

describe('fichas de lucro', () => {
  const fichas = montarFichas(
    [{ itemId: 'MLB1', sku: 'rl-1' }, { itemId: 'MLB2', sku: 'FA-2' }, { itemId: 'MLB3', sku: null }],
    { 'RL-1': 30, 'OK-3': 5 },
    impostos,
    new Date('2026-11-15T00:00:00Z'),
  );

  it('uma ficha por SKU: custo do Tiny e % de imposto do produto (ou o geral)', () => {
    expect(fichas.porItem).toEqual({ MLB1: 'RL-1', MLB2: 'FA-2' });
    expect(fichas.porSku['RL-1']).toEqual({ sku: 'RL-1', custoUnitario: 30, impostoPct: 20, impostoOrigem: 'produto', custoOrigem: 'tiny' });
    expect(fichas.porSku['FA-2']).toEqual({ sku: 'FA-2', custoUnitario: null, impostoPct: 10, impostoOrigem: 'geral', custoOrigem: null });
    expect(fichas.porSku['OK-3']!.custoUnitario).toBe(5);
    expect(fichas.imposto).toMatchObject({ disponivel: true, percentualGeral: 10 });
  });

  it('lucro de uma venda: recebe − custo − imposto; sem custo é null, nunca zero', () => {
    expect(lucroDaVenda(80, 100, fichas.porSku['RL-1'])).toEqual({ custo: 30, imposto: 20, lucroAntesDoImposto: 50, lucro: 30, margemPct: 30 });
    expect(lucroDaVenda(80, 100, fichas.porSku['RL-1'], 2)).toMatchObject({ custo: 60, lucro: 0 });
    expect(lucroDaVenda(80, 100, fichas.porSku['FA-2'])).toMatchObject({ custo: null, lucro: null, lucroAntesDoImposto: null });
    expect(lucroDaVenda(80, 100, { sku: 'X', custoUnitario: 30, impostoPct: null, impostoOrigem: null })).toMatchObject({ lucroAntesDoImposto: 50, lucro: null });
  });

  it('promoção: lucro na proposta, lucro hoje e prejuízo', () => {
    const l = { itemId: 'MLB1', precoProposto: 60, precoAtual: 100, voceRecebe: 40, voceRecebeHoje: 80 };
    expect(lucroDaPromocao(l, fichas)).toEqual({ custoUnitario: 30, impostoPct: 20, lucroPorVenda: -2, lucroAntesDoImposto: 10, lucroHoje: 30, diferencaDeLucro: -32, daPrejuizo: true });
    expect(lucroDaPromocao({ ...l, itemId: 'MLB2' }, fichas).daPrejuizo).toBeNull();
    expect(lucroDaPromocao(l, null)).toMatchObject({ lucroPorVenda: null, daPrejuizo: null });
    expect(comLucro([l], fichas)[0]).toMatchObject({ itemId: 'MLB1', lucroPorVenda: -2 });
  });

  it('o Gerente vê o lucro e pode pedir só as que dão prejuízo', () => {
    const linha = (itemId: string, precoProposto: number, voceRecebe: number) => ({
      itemId, titulo: itemId, permalink: null, precoAtual: 100, precoCheio: 100, descontoPercentual: null, vistaPrimeiroEm: '2026-11-14T00:00:00Z',
      promocaoId: 'P', tipo: 'DEAL', rotulo: 'Oferta do dia', nome: null, status: 'candidate', situacao: 'proposta' as const,
      precoProposto, precoMinimo: null, precoMaximo: null, precoOriginal: 100, mlPercentual: null, vendedorPercentual: null,
      inicio: null, fim: null, prazoParaAderir: null, ofertaId: null, mlBanca: 0, voceRecebe, voceRecebeHoje: 80, diferencaPorVenda: voceRecebe - 80, estimativa: '',
    });
    const r = { atualizadoEm: '', apiDisponivel: true, avisoDaApi: null, anunciosAnalisados: 2, anunciosComErro: 0, truncado: false, vistas: {}, itens: [linha('MLB1', 60, 40), linha('MLB1', 95, 75)] } as unknown as PromocoesResult;
    const todas: any = filtrarPromocoes({}, r, Date.now(), fichas);
    expect(todas.itens.map((i: any) => i.lucroPorVenda)).toEqual([-2, 26]);
    expect(todas.lucro.comPrejuizo).toBe(1);
    expect(todas.resumoEmTexto).toContain('PREJUÍZO');
    const so: any = filtrarPromocoes({ apenas_prejuizo: true }, r, Date.now(), fichas);
    expect(so.total).toBe(1);
  });

  it('custo digitado no painel vale mais que o Tiny (por SKU e por anúncio)', () => {
    const manuais = {
      'sku:FA-2': { tipo: 'sku' as const, chave: 'FA-2', custo: 44, obs: null, em: '' },
      'sku:RL-1': { tipo: 'sku' as const, chave: 'RL-1', custo: 31, obs: null, em: '' },
      'anuncio:MLB3': { tipo: 'anuncio' as const, chave: 'MLB3', custo: 12, obs: null, em: '' },
    };
    const f = montarFichas([{ itemId: 'MLB1', sku: 'rl-1' }, { itemId: 'MLB2', sku: 'FA-2' }, { itemId: 'MLB3', sku: null }], { 'RL-1': 30 }, impostos, new Date(), manuais);
    expect(f.porSku['RL-1']).toMatchObject({ custoUnitario: 31, custoOrigem: 'manual' });
    expect(f.porSku['FA-2']).toMatchObject({ custoUnitario: 44, custoOrigem: 'manual', impostoPct: 10 });
    // anúncio sem SKU com custo próprio: ganha ficha pelo id do anúncio, com o imposto geral
    expect(f.porItem.MLB3).toBe('MLB3');
    expect(f.porSku.MLB3).toEqual({ sku: 'MLB3', custoUnitario: 12, impostoPct: 10, impostoOrigem: 'geral', custoOrigem: 'manual' });
  });
});
