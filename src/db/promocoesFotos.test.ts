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
    ativa: null, programada: null, propostasAbertas: 0, propostas: [], buybox: null, varreduraOk: true, ...over,
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
    expect(r.totais.terminaEmBreve).toBe(1);
    expect(r.resumoEmTexto).toContain('termina hoje');
    // outro anuncio, que nunca teve promocao, na varredura seguinte: o MLB1 saiu do ar da varredura
    gravarFotosDePromocoes([foto({ itemId: 'MLB2', tiradaEm: h(1) })], 180, AGORA);
    expect((promocoesVencendo({}, AGORA) as any).resumoEmTexto).toBeNull();
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
    expect((promocoesVencendo({}, AGORA) as any).disponivel).toBe(false);
  });
});
