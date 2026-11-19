import { describe, expect, it } from 'vitest';
import { margemPorUnidade, montarDiagnostico, type ImpostosDoBackup, type RespostaImpostosBackup } from './diagnosticoCustos';
import { comCustoManual, resumirLacunas, type LacunaDoAnuncio } from './margem';
import type { ProdutoNormalizado } from '../tiny/tinyClient';

const anuncio = (o: Partial<LacunaDoAnuncio> & { itemId: string }): LacunaDoAnuncio => ({
  titulo: o.itemId, sku: null, origemDoSku: null, estado: 'com_custo', custo: null, liquido: 0, unidades: 0, bruto: 0, ...o,
});

const anuncios: LacunaDoAnuncio[] = [
  anuncio({ itemId: 'MLB1', titulo: 'Lâmpada A', sku: 'rl-1', estado: 'com_custo', custo: 10, liquido: 800, unidades: 40, bruto: 1000 }),
  anuncio({ itemId: 'MLB2', titulo: 'Lâmpada A kit', sku: 'RL-1 ', estado: 'com_custo', custo: 10, liquido: 200, unidades: 10, bruto: 250 }),
  anuncio({ itemId: 'MLB3', titulo: 'Farol', sku: 'FA-2', estado: 'sem_custo_no_tiny', custo: null, liquido: 500, unidades: 5, bruto: 600 }),
  anuncio({ itemId: 'MLB4', titulo: 'Sem sku', sku: null, estado: 'sem_sku', liquido: 100, unidades: 2, bruto: 120 }),
  anuncio({ itemId: 'MLB5', titulo: 'Kit', sku: 'KIT-9', estado: 'sem_custo_no_tiny', liquido: 50, unidades: 1, bruto: 60 }),
];
const margem = { janelaDias: 30, anuncios, resumo: resumirLacunas(anuncios) };

const produtos: ProdutoNormalizado[] = [
  { sku: 'RL-1', descricao: 'Lâmpada A', custo: 10, custoPreco: 10, custoMedio: 13, tipo: 'S' },
  { sku: 'FA-2', descricao: 'Farol', custo: null, custoPreco: null, custoMedio: null, tipo: 'S' },
  { sku: 'KIT-9', descricao: 'Kit', custo: null, tipo: 'K' },
  { sku: 'OK-3', descricao: 'Ok', custo: 5, custoPreco: 5, custoMedio: 5.2, tipo: 'S' },
];

const backup = (o: Partial<RespostaImpostosBackup> = {}): ImpostosDoBackup => ({
  disponivel: true,
  dados: {
    de: '2026-08', ate: '2026-10', meses: ['2026-08', '2026-09', '2026-10'], notasLidas: 900,
    regime: { crt: '3', nome: 'Regime normal (Lucro Presumido ou Real)', observacao: null },
    vendas: {
      total: { valorDaVenda: 10000, impostos: 1500, percentual: 15, percentualTotTrib: 20 },
      porSku: [{ sku: 'RL-1', descricao: 'Lâmpada A', quantidade: 100, valorDaVenda: 2000, impostos: 400, percentual: 20, percentualTotTrib: 25 }],
    },
    importacoes: {
      porSku: [
        { sku: 'RL-1', descricao: 'Lâmpada A', quantidade: 1000, custoTotal: 8000, custoPorUnidade: 8, ultimaEntrada: '2026-09-20' },
        { sku: 'FA-2', descricao: 'Farol', quantidade: 10, custoTotal: 450, custoPorUnidade: 45, ultimaEntrada: '2026-10-01' },
        { sku: 'OK-3', descricao: 'Ok', quantidade: 10, custoTotal: 51, custoPorUnidade: 5.1, ultimaEntrada: '2026-10-01' },
      ],
      observacao: 'obs',
    },
    ...o,
  },
});

describe('montarDiagnostico', () => {
  it('junta faturamento por SKU, confere Tiny e nota de importação e calcula margem com imposto real', () => {
    const d = montarDiagnostico(margem, produtos, backup(), { divergenciaPct: 15, agora: new Date('2026-11-14T12:00:00Z') });

    expect(d.cobertura.coberturaPorFaturamento).toBe(residual());
    expect(d.tiny).toEqual({ produtosLidos: 4, comPrecoCusto: 2, comCustoMedio: 2, semCusto: 2, kits: 1 });
    expect(d.divergenciasTiny).toEqual([{ sku: 'RL-1', descricao: 'Lâmpada A', custoPreco: 10, custoMedio: 13, diferencaPct: 30, liquido: 1000 }]);
    expect(d.kitsSemCusto).toEqual([{ sku: 'KIT-9', descricao: 'Kit', liquido: 50 }]);

    expect(d.importacao.conferidos).toBe(2);
    expect(d.importacao.divergentes).toEqual([{ sku: 'RL-1', descricao: 'Lâmpada A', custoTiny: 10, custoNota: 8, diferencaPct: -20, ultimaEntrada: '2026-09-20', liquido: 1000 }]);
    expect(d.importacao.semCustoNoTinyComNota).toEqual([{ sku: 'FA-2', descricao: 'Farol', custoNota: 45, ultimaEntrada: '2026-10-01' }]);

    // v54: uma linha por anúncio; o SKU vem junto e diz quantos anúncios vendem o mesmo produto
    expect(d.top.map((t) => t.itemId)).toEqual(['MLB1', 'MLB3', 'MLB2', 'MLB4', 'MLB5']);
    const a = d.top[0]!;
    // MLB1 (RL-1): imposto do próprio produto (20%) porque vendeu R$ 2.000 nas notas
    expect(a).toMatchObject({ itemId: 'MLB1', sku: 'RL-1', anunciosDoSku: 2, unidades: 40, bruto: 1000, liquido: 800, custoOrigem: 'tiny', custoMercadoria: 400, impostoPct: 20, impostoOrigem: 'produto', impostoEstimado: 200, margemAntesDoImposto: 400, margem: 200, margemPct: 20, custoNotaImportacao: 8, diferencaImportacaoPct: -20, ml: null });
    expect(d.top.find((t) => t.itemId === 'MLB2')).toMatchObject({ sku: 'RL-1', anunciosDoSku: 2, liquido: 200, custoMercadoria: 100 });
    // FA-2 sem custo: margem fica null ("não sei"), nunca zero
    const f = d.top.find((t) => t.sku === 'FA-2')!;
    expect(f).toMatchObject({ custoMercadoria: null, margem: null, margemAntesDoImposto: null, impostoPct: 15, impostoOrigem: 'geral' });
    // anúncio sem SKU também aparece (antes sumia), com o imposto geral
    expect(d.top.find((t) => t.itemId === 'MLB4')).toMatchObject({ sku: null, anunciosDoSku: 1, impostoPct: 15 });

    expect(d.impostos).toMatchObject({ disponivel: true, percentualGeral: 15, produtosComImposto: 1, periodo: '2026-08 a 2026-10' });
    expect(d.achados.join(' ')).toMatch(/15% do valor vendido/);
    expect(d.achados.join(' ')).toMatch(/nota de importação/);
  });

  it('sem backup: diagnóstico sai sem imposto e diz por quê', () => {
    const d = montarDiagnostico(margem, produtos, { disponivel: false, calculando: true, motivo: 'o backup está somando as notas fiscais' }, { divergenciaPct: 15 });
    expect(d.impostos).toMatchObject({ disponivel: false, calculando: true });
    expect(d.top[0]).toMatchObject({ impostoPct: null, margem: null, margemAntesDoImposto: 400 });
    expect(d.achados.join(' ')).toMatch(/somando as notas/);
    expect(d.importacao.conferidos).toBe(0);
  });

  it('no Simples não inventa imposto', () => {
    const d = montarDiagnostico(margem, produtos, backup({ regime: { crt: '1', nome: 'Simples Nacional', observacao: 'DAS' } }), { divergenciaPct: 15 });
    expect(d.impostos.percentualGeral).toBeNull();
    expect(d.top[0]!.impostoPct).toBeNull();
    expect(d.achados.join(' ')).toMatch(/DAS/);
  });
});

describe('custo manual e dados do ML no diagnóstico', () => {
  it('custo digitado vale no lugar do Tiny e aparece marcado', () => {
    const manuais = { 'sku:FA-2': { tipo: 'sku' as const, chave: 'FA-2', custo: 50, obs: 'nota de out', em: '2026-11-19T00:00:00Z' } };
    const comManual = anuncios.map((x) => comCustoManual(x, manuais));
    const m = { janelaDias: 30, anuncios: comManual, resumo: resumirLacunas(comManual) };
    const d = montarDiagnostico(m, produtos, backup(), { divergenciaPct: 15, manuais });
    expect(d.top.find((t) => t.sku === 'FA-2')).toMatchObject({ custoUnitario: 50, custoOrigem: 'manual', custoMercadoria: 250, margemAntesDoImposto: 250 });
    expect(d.manuais).toHaveLength(1);
    expect(d.cobertura.coberturaPorFaturamento).toBeGreaterThan(residual());
    expect(d.achados.join(' ')).toMatch(/digitado/);
    // apagar o manual volta ao Tiny
    const volta = comCustoManual(comManual.find((x) => x.itemId === 'MLB3')!, {});
    expect(volta).toMatchObject({ estado: 'sem_custo_no_tiny', custo: null, custoOrigem: null });
  });
});

describe('margem por venda (v55)', () => {
  it('com os dados do ML: você recebe hoje − custo − imposto sobre o preço de hoje (MCS9515 do print)', () => {
    const ml = { voceRecebe: 312.63, preco: 799, precoPromocao: 386 };
    expect(margemPorUnidade(75, null, ml, 20027.15, 21926.05, 57)).toEqual({ margemUnitaria: 237.63, margemUnitariaPct: 61.6, margemUnitariaBase: 'hoje', margemUnitariaComImposto: false });
    expect(margemPorUnidade(75, 10, ml, 0, 0, 0)).toMatchObject({ margemUnitaria: 199.03, margemUnitariaComImposto: true });
  });
  it('sem os dados do ML usa a média dos 30 dias; sem custo fica null', () => {
    expect(margemPorUnidade(10, 20, null, 800, 1000, 40)).toMatchObject({ margemUnitaria: 5, margemUnitariaPct: 20, margemUnitariaBase: 'media30' });
    expect(margemPorUnidade(null, 20, { voceRecebe: 50, preco: 80, precoPromocao: null }, 0, 0, 0)).toMatchObject({ margemUnitaria: null, margemUnitariaBase: 'hoje' });
  });
  it('vai para a linha do anúncio', () => {
    const d = montarDiagnostico(margem, produtos, backup(), { divergenciaPct: 15 });
    // MLB1: (800/40) − 10 − 20% de (1000/40) = 20 − 10 − 5 = 5 por venda
    expect(d.top[0]).toMatchObject({ itemId: 'MLB1', margemUnitaria: 5, margemUnitariaPct: 20, margemUnitariaBase: 'media30' });
  });
});

/** Cobertura por faturamento calculada à parte: 1000 de 1650 tem custo. */
function residual(): number {
  return Math.round((1000 / 1650) * 1000) / 10;
}
