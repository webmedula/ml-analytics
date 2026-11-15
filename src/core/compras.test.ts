import { describe, expect, it } from 'vitest';
import { mesesDaJanela, montarPlano, parametrosDaQuery, somarDias, type DadosCompras } from './compras';
import { extrairComponentesDoKit, normalizarEstoque } from '../tiny/tinyClient';

const P = { prazoDias: 90, coberturaDias: 90, segurancaDias: 30, excessoDias: 365 };

function dados(parcial: Partial<DadosCompras>): DadosCompras {
  return {
    coletadoEm: '2026-11-15T12:00:00Z',
    hoje: '2026-11-15',
    // 3 meses de 30 dias = 90 dias
    meses: [
      { mes: '2026-08', dias: 30, notasLidas: 10 },
      { mes: '2026-09', dias: 30, notasLidas: 10 },
      { mes: '2026-10', dias: 30, notasLidas: 10 },
    ],
    vendas: {},
    kits: {},
    produtos: {},
    estoques: {},
    estoque: { lidos: 0, semNumero: 0, erros: 0, parouPor: null },
    importacoes: {},
    avisos: [],
    ...parcial,
  };
}

const est = (n: number) => ({ saldo: n, reservado: 0, disponivel: n });

describe('mesesDaJanela', () => {
  it('conta o mes corrente ate ontem e os meses completos anteriores', () => {
    expect(mesesDaJanela('2026-11-15', 3)).toEqual([
      { mes: '2026-08', dias: 31 },
      { mes: '2026-09', dias: 30 },
      { mes: '2026-10', dias: 31 },
      { mes: '2026-11', dias: 14 },
    ]);
  });
  it('no dia 1 o mes corrente fica de fora e vira o ano', () => {
    expect(mesesDaJanela('2026-01-01', 2)).toEqual([
      { mes: '2025-11', dias: 30 },
      { mes: '2025-12', dias: 31 },
    ]);
  });
});

describe('montarPlano', () => {
  it('classifica pelo prazo de importacao e sugere quantidade para prazo + folga + cobertura', () => {
    const d = dados({
      // 90 unidades em 90 dias = 1 por dia
      vendas: { A: { descricao: 'Farol', porMes: { '2026-08': 30, '2026-09': 30, '2026-10': 30 } } },
      produtos: { A: { descricao: 'Farol', custo: 10, tipo: 'S' } },
      estoques: { A: est(60) },
    });
    const l = montarPlano(d, P).linhas[0]!;
    expect(l.situacao).toBe('pedir_ja'); // 60 dias < 90 de prazo
    expect(l.diasDeEstoque).toBe(60);
    expect(l.acabaEm).toBe('2027-01-14');
    expect(l.pedirAte).toBe('2026-11-15'); // ja passou: hoje
    expect(l.quantidadeSugerida).toBe(150); // 1/dia x 210 - 60
    expect(l.investimento).toBe(1500);
  });

  it('pedir em breve, ok, excesso e parado', () => {
    const vend = (q: number) => ({ descricao: '', porMes: { '2026-08': q, '2026-09': q, '2026-10': q } });
    const d = dados({
      vendas: { B: vend(30), C: vend(30), D: vend(3) },
      produtos: { B: { descricao: 'b', custo: 5, tipo: 'S' }, C: { descricao: 'c', custo: 5, tipo: 'S' }, D: { descricao: 'd', custo: 5, tipo: 'S' }, E: { descricao: 'e', custo: 2, tipo: 'S' } },
      estoques: { B: est(100), C: est(200), D: est(500), E: est(40) },
    });
    const p = montarPlano(d, P);
    const s = Object.fromEntries(p.linhas.map((l) => [l.sku, l]));
    expect(s.B!.situacao).toBe('pedir_em_breve'); // 100 dias: entre 90 e 120
    expect(s.C!.situacao).toBe('ok');
    expect(s.C!.quantidadeSugerida).toBe(0);
    expect(s.D!.situacao).toBe('excesso'); // 0,1/dia, 5000 dias
    expect(s.D!.valorParado).toBe(r(500 - 0.1 * 365) * 5);
    expect(s.E!.situacao).toBe('parado'); // tem estoque, nao vendeu
    expect(s.E!.valorParado).toBe(80);
    expect(p.resumo.valorParado).toBe(s.D!.valorParado! + 80);
    // ordem: o mais urgente primeiro
    expect(p.linhas.map((l) => l.sku)).toEqual(['B', 'D', 'E', 'C']);
  });

  it('kit vendido conta nos componentes', () => {
    const d = dados({
      vendas: {
        KIT: { descricao: 'Kit 2 farois', porMes: { '2026-10': 10 } },
        A: { descricao: 'Farol', porMes: { '2026-10': 5 } },
      },
      kits: { KIT: [{ sku: 'a', quantidade: 2 }] },
      produtos: { A: { descricao: 'Farol', custo: 10, tipo: 'S' }, KIT: { descricao: 'Kit', custo: null, tipo: 'K' } },
      estoques: { A: est(0) },
    });
    const p = montarPlano(d, P);
    expect(p.linhas).toHaveLength(1);
    expect(p.linhas[0]!.sku).toBe('A');
    expect(p.linhas[0]!.vendasPorMes).toEqual([0, 0, 25]);
    expect(p.linhas[0]!.viaKit).toBe(20);
    expect(p.linhas[0]!.situacao).toBe('em_falta');
  });

  it('sem estoque lido nao inventa numero e avisa kit sem estrutura', () => {
    const d = dados({
      vendas: { X: { descricao: 'x', porMes: { '2026-10': 9 } }, K2: { descricao: 'k', porMes: { '2026-10': 1 } } },
      kits: { K2: [] },
    });
    const p = montarPlano(d, P);
    const x = p.linhas.find((l) => l.sku === 'X')!;
    expect(x.situacao).toBe('sem_estoque_lido');
    expect(x.diasDeEstoque).toBeNull();
    expect(x.quantidadeSugerida).toBe(0);
    expect(p.avisos.join(' ')).toMatch(/kit/);
  });

  it('tendencia compara o ultimo mes completo com os dois anteriores', () => {
    const d = dados({
      vendas: { A: { descricao: '', porMes: { '2026-08': 10, '2026-09': 10, '2026-10': 20 } } },
      estoques: { A: est(1000) },
    });
    expect(montarPlano(d, P).linhas[0]!.tendencia).toBe('subindo');
  });
});

describe('auxiliares', () => {
  it('somarDias', () => expect(somarDias('2026-12-30', 3)).toBe('2027-01-02'));
  it('parametros da query com limites', () => {
    expect(parametrosDaQuery({ prazo: '120', cobertura: 'abc', seguranca: '-1' })).toMatchObject({ prazoDias: 120, coberturaDias: 90, segurancaDias: 30 });
  });
  it('estoque do Tiny em formatos diferentes', () => {
    expect(normalizarEstoque({ saldo: 10, reservado: 2, disponivel: 8 })).toEqual({ saldo: 10, reservado: 2, disponivel: 8 });
    expect(normalizarEstoque({ depositos: [{ saldo: 3 }, { saldo: 4, desconsiderar: true }] })).toEqual({ saldo: 3, reservado: 0, disponivel: 3 });
    expect(normalizarEstoque({})).toBeNull();
  });
  it('componentes do kit', () => {
    expect(extrairComponentesDoKit({ kit: [{ produto: { sku: 'A1' }, quantidade: 2 }, { produto: {}, quantidade: 1 }] })).toEqual([{ sku: 'A1', quantidade: 2 }]);
    expect(extrairComponentesDoKit({})).toEqual([]);
  });
});

function r(n: number): number {
  return n;
}
