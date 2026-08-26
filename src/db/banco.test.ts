import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';

// O banco abre em config.dataDir. Aponta pra uma pasta temporaria ANTES de importar o modulo,
// pra nenhum teste escrever na base real.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
(config as any).dataDir = tmp;

const { abrirBanco, consultar, ConsultaInvalida, descreverEsquema, fecharBanco, validarConsulta } = await import('./banco');
const { gravarVendas } = await import('./ingestao');

describe('validarConsulta', () => {
  it('aceita SELECT e WITH', () => {
    expect(validarConsulta('SELECT 1')).toBe('SELECT 1');
    expect(validarConsulta('  with x as (select 1) select * from x  ')).toMatch(/^with/i);
    // ponto-e-virgula no fim e habito de quem escreve SQL; nao deve reprovar
    expect(validarConsulta('SELECT 1;')).toBe('SELECT 1');
  });

  it('recusa qualquer coisa que altere dados', () => {
    for (const sql of ['DELETE FROM vendas', 'DROP TABLE vendas', 'UPDATE vendas SET bruto=0', 'PRAGMA table_info(vendas)']) {
      expect(() => validarConsulta(sql)).toThrow(ConsultaInvalida);
    }
  });

  it('recusa o DELETE escondido depois de um SELECT — o ataque obvio', () => {
    expect(() => validarConsulta('SELECT 1; DELETE FROM vendas')).toThrow(ConsultaInvalida);
  });

  it('recusa ATTACH, que sairia do arquivo do banco', () => {
    expect(() => validarConsulta("SELECT * FROM x; ATTACH DATABASE '/etc/passwd' AS y")).toThrow(ConsultaInvalida);
  });

  it('consulta vazia nao passa', () => {
    expect(() => validarConsulta('   ')).toThrow(ConsultaInvalida);
  });
});

describe('banco com dados reais', () => {
  beforeAll(() => {
    abrirBanco();
  });
  afterAll(() => {
    fecharBanco();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const linhas = [
    { orderId: 'P1', itemId: 'MLB1', dataCriacao: '2026-08-01T10:00:00Z', status: 'paid', sku: 'MCS9029', titulo: 'Lanterna', quantidade: 2, precoUnitario: 50, saleFee: 6, valor: 100, shipmentId: 'E1', dentro7: false },
    { orderId: 'P2', itemId: 'MLB2', dataCriacao: '2026-08-02T10:00:00Z', status: 'paid', sku: 'MCS9030', titulo: 'Farol', quantidade: 1, precoUnitario: 300, saleFee: 30, valor: 300, shipmentId: 'E1', dentro7: false },
  ];

  it('grava as linhas e calcula bruto e comissao', () => {
    const r = gravarVendas(linhas as any, new Map([['E1', 20]]));
    expect(r.novas).toBe(2);

    const { linhas: out } = consultar('SELECT order_id, bruto, comissao, data FROM vendas ORDER BY order_id');
    expect(out[0]).toMatchObject({ order_id: 'P1', bruto: 100, comissao: 12, data: '2026-08-01' });
    // sale_fee e POR UNIDADE: 6 x 2 unidades = 12. Tratar como valor da linha daria 6 e o
    // liquido ficaria otimista em toda venda de quantidade maior que 1.
    expect(out[1]).toMatchObject({ order_id: 'P2', comissao: 30 });
  });

  it('rateia o frete do envio proporcional ao valor da linha, nao meio a meio', () => {
    const { linhas: out } = consultar('SELECT order_id, frete FROM vendas ORDER BY order_id');
    // R$ 20 de frete num envio de R$ 400: 25% pra linha de 100, 75% pra de 300.
    expect(out[0].frete).toBeCloseTo(5, 2);
    expect(out[1].frete).toBeCloseTo(15, 2);
  });

  it('regravar a mesma venda NAO duplica — e o que permite acumular historico', () => {
    const r = gravarVendas(linhas as any, new Map());
    expect(r.novas).toBe(0);
    expect(r.atualizadas).toBe(2);

    const { linhas: total } = consultar('SELECT COUNT(*) AS n FROM vendas');
    expect(total[0].n).toBe(2);
  });

  it('varredura sem frete nao apaga o frete que a anterior tinha conseguido', () => {
    // Chamada acima passou um Map vazio de proposito. O valor precisa ter sobrevivido.
    const { linhas: out } = consultar("SELECT frete FROM vendas WHERE order_id = 'P1'");
    expect(out[0].frete).toBeCloseTo(5, 2);
  });

  it('agrega por mes e por SKU, que e pra isso que o banco existe', () => {
    const { linhas: porMes } = consultar(
      "SELECT substr(data,1,7) AS mes, SUM(bruto) AS bruto FROM vendas GROUP BY mes",
    );
    expect(porMes[0]).toMatchObject({ mes: '2026-08', bruto: 400 });
  });

  it('o teto corta as linhas e avisa que cortou', () => {
    const r = consultar('SELECT * FROM vendas', 1);
    expect(r.linhas).toHaveLength(1);
    expect(r.total).toBe(2);
    expect(r.truncado).toBe(true);
  });

  it('o esquema descreve as tabelas com a contagem de linhas', () => {
    const esquema = descreverEsquema();
    expect(esquema).toContain('CREATE TABLE');
    expect(esquema).toContain('vendas');
    expect(esquema).toMatch(/-- \d+ linha/);
  });
});
