import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';

const { abrirBanco, fecharBanco, gravarFotosDePromocoes, ultimasFotosDoAnuncio, bancoDisponivel, consultar } = await import('./banco');
const { obterAcompanhamento, promocoesVencendo } = await import('../core/promocoesAcompanhamentoConsulta');
import type { FotoPromocao } from '../core/promocoesAcompanhamento';

const AGORA = Date.parse('2026-11-05T15:00:00Z');
const h = (horas: number) => new Date(AGORA + horas * 3600000).toISOString();
let tmp = '';

function foto(over: Partial<FotoPromocao> = {}): FotoPromocao {
  return {
    itemId: 'MLB1', tiradaEm: h(0), titulo: 'Lanterna', permalink: null, statusAnuncio: 'active', precoAtual: 100, precoCheio: 120,
    ativa: null, programadas: [], propostasAbertas: 0, propostas: [], buybox: null, varreduraOk: true, ...over,
  };
}
const ativa = (fim: string | null) => ({ tipo: 'DEAL', id: 'P1', nome: 'Oferta X', fim });

beforeEach(() => {
  fecharBanco();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-test-'));
  (config as any).dataDir = tmp;
});
afterEach(() => {
  fecharBanco();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('promocoes_fotos (v46)', () => {
  it('migra um banco da v45 sem perder dados e e idempotente', () => {
    // Banco como estava na v45: esquema completo, com dados, sem a tabela nova.
    const velho = abrirBanco();
    velho.exec("INSERT INTO vendas (order_id, item_id, bruto) VALUES ('P1','MLB1',99); DROP TABLE promocoes_fotos;");
    fecharBanco();
    abrirBanco();
    fecharBanco();
    abrirBanco(); // segunda abertura: CREATE IF NOT EXISTS nao quebra
    expect(consultar('SELECT bruto FROM vendas').linhas).toEqual([{ bruto: 99 }]);
    expect(consultar("SELECT name FROM sqlite_master WHERE name='promocoes_fotos'").linhas).toHaveLength(1);
  });

  it('grava e le de volta, com Buy Box e a data do dado do Buy Box', () => {
    gravarFotosDePromocoes(
      [foto({
        ativa: ativa(h(30)), propostasAbertas: 1,
        propostas: [{ tipo: 'LIGHTNING', promocaoId: 'L1', nome: 'Rel', precoProposto: 90, fim: null, prazoParaAderir: null }],
        buybox: { situacao: 'perdendo', statusMl: 'competing', precoParaGanhar: 80, atualizadoEm: '2026-11-05T10:00:00Z' },
      })],
      180, AGORA,
    );
    const [f] = ultimasFotosDoAnuncio('MLB1', 5);
    expect(f.ativa?.nome).toBe('Oferta X');
    expect(f.propostas[0].promocaoId).toBe('L1');
    expect(f.buybox).toEqual({ situacao: 'perdendo', statusMl: 'competing', precoParaGanhar: 80, atualizadoEm: '2026-11-05T10:00:00Z' });
  });

  it('retencao apaga so o que passou do prazo', () => {
    gravarFotosDePromocoes([foto({ tiradaEm: new Date(AGORA - 200 * 86400000).toISOString() })], 180, AGORA - 200 * 86400000);
    const r = gravarFotosDePromocoes([foto()], 180, AGORA);
    expect(r.apagadas).toBe(1);
    expect(ultimasFotosDoAnuncio('MLB1', 10)).toHaveLength(1);
  });

  it('acompanhamento de ponta a ponta: ficou sem promocao permanece na 3a e 4a varredura; foto invalida e ignorada', () => {
    gravarFotosDePromocoes([foto({ tiradaEm: h(-18), ativa: ativa(h(-12)) })], 180, AGORA);
    gravarFotosDePromocoes([foto({ tiradaEm: h(-12) })], 180, AGORA);
    gravarFotosDePromocoes([foto({ tiradaEm: h(-6), varreduraOk: false })], 180, AGORA); // erro: nao conta
    expect(obterAcompanhamento({ agora: AGORA }).ficouSemPromocao).toHaveLength(0); // ultima varredura invalida
    gravarFotosDePromocoes([foto({ tiradaEm: h(0) })], 180, AGORA);
    const a = obterAcompanhamento({ agora: AGORA });
    expect(a.historicoDisponivel).toBe(true);
    expect(a.ficouSemPromocao).toHaveLength(1);
    expect(a.ficouSemPromocao[0].desde).toBe(h(-12));
    gravarFotosDePromocoes([foto({ tiradaEm: h(6) })], 180, AGORA + 6 * 3600000);
    expect(obterAcompanhamento({ agora: AGORA + 6 * 3600000 }).ficouSemPromocao).toHaveLength(1);
  });

  it('ferramenta: texto pronto, limite por lista, null quando nao ha nada', () => {
    gravarFotosDePromocoes([foto({ ativa: ativa(h(2)) })], 180, AGORA);
    const r: any = promocoesVencendo({ dias: 3, limite: 5 }, AGORA);
    expect(r.disponivel).toBe(true);
    expect(r.totais.anunciosVencendo).toBe(1);
    expect(r.resumoEmTexto).toContain('termina hoje');
    // outro anuncio, que nunca teve promocao, na varredura seguinte: o MLB1 saiu do ar da varredura
    gravarFotosDePromocoes([foto({ itemId: 'MLB2', tiradaEm: h(1) })], 180, AGORA);
    expect((promocoesVencendo({}, AGORA) as any).resumoEmTexto).toBeNull();
  });

  it('migra banco da v46 (sem programadas_json): coluna nova uma vez so, fotos antigas leem a programada unica', () => {
    const velho = abrirBanco();
    velho.exec(`
      DROP TABLE promocoes_fotos;
      CREATE TABLE promocoes_fotos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tirada_em TEXT NOT NULL, item_id TEXT NOT NULL, titulo TEXT, permalink TEXT,
        status_anuncio TEXT, preco_atual REAL, preco_cheio REAL, promo_ativa_tipo TEXT, promo_ativa_id TEXT, promo_ativa_nome TEXT,
        promo_ativa_fim TEXT, promo_programada_tipo TEXT, promo_programada_inicio TEXT, promo_programada_fim TEXT,
        propostas_abertas INTEGER, propostas_json TEXT, buybox_situacao TEXT, buybox_status_ml TEXT, buybox_preco_para_ganhar REAL,
        buybox_atualizado_em TEXT, varredura_ok INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO promocoes_fotos (tirada_em, item_id, promo_ativa_tipo, promo_ativa_fim, promo_programada_tipo, promo_programada_inicio, promo_programada_fim, propostas_abertas, propostas_json, varredura_ok)
      VALUES ('2026-11-05T12:00:00Z', 'MLB1', 'SELLER_CAMPAIGN', '2026-11-09T02:59:00Z', 'DEAL', '2026-10-19T03:00:00Z', '2026-11-09T02:59:00Z', 0, '[]', 1);
    `);
    fecharBanco();
    abrirBanco();
    fecharBanco();
    abrirBanco(); // idempotente: a coluna nao e adicionada de novo
    const colunas = consultar("SELECT name FROM pragma_table_info('promocoes_fotos') WHERE name='programadas_json'");
    expect(colunas.linhas).toHaveLength(1);
    const [f] = ultimasFotosDoAnuncio('MLB1', 1);
    expect(f.programadas).toEqual([{ tipo: 'DEAL', id: null, inicio: '2026-10-19T03:00:00Z', fim: '2026-11-09T02:59:00Z', precoProposto: null, semEfeito: false }]);
  });

  it('grava e le a lista de programadas', () => {
    const progs = [
      { tipo: 'DEAL', id: 'P1', inicio: h(1), fim: h(50), precoProposto: 90, semEfeito: false },
      { tipo: 'SMART', id: null, inicio: h(2), fim: null, precoProposto: 130, semEfeito: true },
    ];
    gravarFotosDePromocoes([foto({ programadas: progs })], 180, AGORA);
    expect(ultimasFotosDoAnuncio('MLB1', 1)[0].programadas).toEqual(progs);
  });

  it('banco indisponivel nao quebra: historicoDisponivel=false e listas vazias', () => {
    fecharBanco();
    const arquivo = path.join(tmp, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    (config as any).dataDir = path.join(arquivo, 'sub'); // mkdir dentro de um arquivo: falha
    expect(bancoDisponivel()).toBe(false);
    const a = obterAcompanhamento({ agora: AGORA });
    expect(a.historicoDisponivel).toBe(false);
    expect(a.terminaEmBreve).toEqual([]);
    // sem banco e sem cache de promocoes: nada a dizer
    expect((promocoesVencendo({}, AGORA) as any).disponivel).toBe(false);
  });

  it('banco indisponivel nao esconde o prazo para aderir, que vem do cache; so o resto fica sem calcular', async () => {
    const promo = await import('../core/promocoes');
    const linha: any = {
      itemId: 'MLB7', titulo: 'Prazo', permalink: null, tipo: 'DEAL', rotulo: 'Campanha do ML', nome: 'BF', promocaoId: 'BF', ofertaId: null,
      situacao: 'proposta', semEfeito: false, precoProposto: 80, precoAtual: 100, precoCheio: 120, mlPercentual: 4, voceRecebe: 50,
      diferencaPorVenda: 1.2, inicio: null, fim: null, prazoParaAderir: h(30), statusAnuncio: 'active',
    };
    const cachePath = path.join(tmp, 'promocoes-cache.json');
    (config as any).promocoesCachePath = cachePath;
    fs.writeFileSync(cachePath, JSON.stringify({ atualizadoEm: h(0), apiDisponivel: true, avisoDaApi: null, anunciosAnalisados: 1, anunciosComErro: 0, truncado: false, itens: [linha], vistas: {} }));
    // o cache em memoria do modulo pode ter sido preenchido por outro teste
    (promo as any).getPromocoes();
    const arquivo = path.join(tmp, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    (config as any).dataDir = path.join(arquivo, 'sub');
    fecharBanco();
    const a = obterAcompanhamento({ agora: AGORA });
    expect(a.historicoDisponivel).toBe(false);
    expect(a.prazoDisponivel).toBe(true);
    expect(a.prazoAderir).toHaveLength(1);
    expect(a.terminaEmBreve).toEqual([]);
    const t: any = promocoesVencendo({}, AGORA);
    expect(t.disponivel).toBe(true);
    expect(t.historicoDisponivel).toBe(false);
    expect(t.aviso).toContain('so o prazo para aderir');
    expect(t.resumoEmTexto).toContain('📅 Prazo para aderir acabando');
    expect(t.resumoEmTexto).not.toContain('⏳');
  });
});
