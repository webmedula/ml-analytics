import { describe, expect, it } from 'vitest';
import {
  acompanharPromocoes,
  diasAte,
  FotoPromocao,
  montarAcompanhamento,
  montarFotos,
  paraIso,
  resumoEmTexto,
} from './promocoesAcompanhamento';

const OPTS = { diasAviso: 3, semPromoDias: 14 };
const AGORA = Date.parse('2026-11-05T15:00:00Z'); // 05/11 12:00 em Brasilia
const h = (horas: number) => new Date(AGORA + horas * 3600000).toISOString();
const dia = (d: number) => h(d * 24);

function foto(over: Partial<FotoPromocao> = {}): FotoPromocao {
  return {
    itemId: 'MLB1', tiradaEm: h(0), titulo: 'Lanterna', permalink: 'https://ml/MLB1', statusAnuncio: 'active',
    precoAtual: 100, precoCheio: 120, ativa: null, programada: null, propostasAbertas: 0, propostas: [],
    buybox: null, varreduraOk: true, ...over,
  };
}
const ativa = (fim: string | null) => ({ tipo: 'DEAL', id: 'P1', nome: 'Oferta X', fim });

describe('TERMINA_EM_BREVE', () => {
  it('termina em 2 dias avisa; em 5 dias nao', () => {
    const o = acompanharPromocoes(foto({ ativa: ativa(dia(2)) }), [], AGORA, OPTS);
    expect(o?.situacao).toBe('TERMINA_EM_BREVE');
    expect(o?.diasRestantes).toBe(2);
    expect(o?.prazo).toBe('faltam 2 dias');
    expect(acompanharPromocoes(foto({ ativa: ativa(dia(5)) }), [], AGORA, OPTS)).toBeNull();
  });

  it('faltando 0 dia mostra "termina hoje"; 1 dia, "falta 1 dia"; ja vencida nao avisa', () => {
    expect(acompanharPromocoes(foto({ ativa: ativa(h(5)) }), [], AGORA, OPTS)?.prazo).toBe('termina hoje');
    expect(acompanharPromocoes(foto({ ativa: ativa(dia(1)) }), [], AGORA, OPTS)?.prazo).toBe('falta 1 dia');
    expect(acompanharPromocoes(foto({ ativa: ativa(h(-1)) }), [], AGORA, OPTS)).toBeNull();
  });

  it('fuso: fim 23:59 de Brasilia conta como o dia certo', () => {
    const agora = Date.parse('2026-11-07T04:00:00Z'); // 07/11 01:00 em Brasilia
    const fim = '2026-11-07T23:59:59-03:00'; // = 08/11 02:59 UTC: em UTC pareceria "amanha"
    expect(diasAte(Date.parse(fim), agora)).toBe(0);
    const o = acompanharPromocoes(foto({ ativa: ativa(paraIso(fim)) }), [], agora, OPTS);
    expect(o?.prazo).toBe('termina hoje');
    // data sem fuso e lida como Brasilia, nao como o fuso do servidor
    expect(paraIso('2026-11-07T23:59:59')).toBe('2026-11-08T02:59:59.000Z');
    expect(paraIso('lixo')).toBeNull();
  });

  it('programada que comeca ate 2h depois do fim (ou antes) = coberta e fora do texto do Gerente', () => {
    const f = foto({ ativa: ativa(dia(2)), programada: { tipo: 'LIGHTNING', inicio: new Date(Date.parse(dia(2)) + 3600000).toISOString(), fim: dia(6) } });
    const o = acompanharPromocoes(f, [], AGORA, OPTS)!;
    expect(o.coberta).toBe(true);
    const a = montarAcompanhamento([f], new Map(), AGORA, OPTS);
    expect(a.terminaEmBreve).toHaveLength(1);
    expect(resumoEmTexto(a, 10)).toBeNull();
    const antes = foto({ ativa: ativa(dia(2)), programada: { tipo: 'X', inicio: dia(1), fim: dia(6) } });
    expect(acompanharPromocoes(antes, [], AGORA, OPTS)?.coberta).toBe(true);
  });

  it('folga maior que 2h nao e coberta e mostra a folga', () => {
    const f = foto({ ativa: ativa(dia(2)), programada: { tipo: 'X', inicio: new Date(Date.parse(dia(2)) + 3 * 3600000).toISOString(), fim: dia(6) } });
    const o = acompanharPromocoes(f, [], AGORA, OPTS)!;
    expect(o.coberta).toBe(false);
    expect(o.folgaMinutos).toBe(180);
    expect(o.folga).toBe('3h');
    const exato = foto({ ativa: ativa(dia(2)), programada: { tipo: 'X', inicio: new Date(Date.parse(dia(2)) + 2 * 3600000).toISOString(), fim: dia(6) } });
    expect(acompanharPromocoes(exato, [], AGORA, OPTS)?.coberta).toBe(true);
    expect(resumoEmTexto(montarAcompanhamento([f], new Map(), AGORA, OPTS), 10)).toContain('folga de 3h');
  });
});

describe('SEM_DATA_DE_FIM', () => {
  it('ativa sem fim vira "sem data", nunca uma data estimada, e fica fora do texto', () => {
    const f = foto({ ativa: ativa(null) });
    const o = acompanharPromocoes(f, [], AGORA, OPTS)!;
    expect(o.situacao).toBe('SEM_DATA_DE_FIM');
    expect(o.fim).toBeNull();
    const a = montarAcompanhamento([f], new Map(), AGORA, OPTS);
    expect(a.semDataDeFim).toHaveLength(1);
    expect(resumoEmTexto(a, 10)).toBeNull();
  });
});

describe('FICOU_SEM_PROMOCAO', () => {
  const comPromo = (t: string) => foto({ tiradaEm: t, ativa: ativa(dia(1)) });
  const sem = (t: string) => foto({ tiradaEm: t });

  it('tinha promocao e agora nao tem: entra; nunca teve: nao aparece', () => {
    const o = acompanharPromocoes(sem(h(0)), [comPromo(h(-6))], AGORA, OPTS);
    expect(o?.situacao).toBe('FICOU_SEM_PROMOCAO');
    expect(o?.desde).toBe(h(0));
    expect(o?.promocao?.nome).toBe('Oferta X');
    expect(acompanharPromocoes(sem(h(0)), [sem(h(-6)), sem(h(-12))], AGORA, OPTS)).toBeNull();
  });

  it('continua na lista na 3a e 4a varredura sem promocao (nao depende so das duas ultimas)', () => {
    const t = [h(-18), h(-12), h(-6), h(0)]; // varredura 1 com promo; 2, 3 e 4 sem
    const f1 = comPromo(t[0]);
    const f2 = sem(t[1]);
    const f3 = sem(t[2]);
    const f4 = sem(t[3]);
    const v2 = acompanharPromocoes(f2, [f1], AGORA, OPTS);
    const v3 = acompanharPromocoes(f3, [f2, f1], AGORA, OPTS);
    const v4 = acompanharPromocoes(f4, [f3, f2, f1], AGORA, OPTS);
    for (const v of [v2, v3, v4]) expect(v?.situacao).toBe('FICOU_SEM_PROMOCAO');
    // "desde" e a primeira foto sem promocao, nao a atual
    expect(v3?.desde).toBe(t[1]);
    expect(v4?.desde).toBe(t[1]);
  });

  it('programada tambem conta como "tinha promocao"; atual com programada nao entra', () => {
    const prog = foto({ tiradaEm: h(-6), programada: { tipo: 'X', inicio: h(5), fim: dia(3) } });
    expect(acompanharPromocoes(sem(h(0)), [prog], AGORA, OPTS)?.situacao).toBe('FICOU_SEM_PROMOCAO');
    expect(acompanharPromocoes(foto({ programada: { tipo: 'X', inicio: h(5), fim: dia(3) } }), [comPromo(h(-6))], AGORA, OPTS)).toBeNull();
  });

  it('anuncio pausado ou finalizado nao entra', () => {
    for (const status of ['paused', 'closed']) {
      expect(acompanharPromocoes(foto({ statusAnuncio: status }), [comPromo(h(-6))], AGORA, OPTS)).toBeNull();
    }
  });

  it('sai da lista ao voltar a ter promocao e depois de PROMOCOES_SEM_PROMO_DIAS', () => {
    // voltou: a atual tem promocao -> nao e FICOU_SEM (e a regra de vencimento decide o resto)
    const voltou = acompanharPromocoes(comPromo(h(0)), [sem(h(-6)), comPromo(h(-12))], AGORA, OPTS);
    expect(voltou?.situacao).not.toBe('FICOU_SEM_PROMOCAO');
    // a ultima foto com promocao tem 13 dias: ainda na lista; 15 dias: fora
    expect(acompanharPromocoes(sem(h(0)), [sem(h(-6)), comPromo(dia(-13))], AGORA, OPTS)?.situacao).toBe('FICOU_SEM_PROMOCAO');
    expect(acompanharPromocoes(sem(h(0)), [sem(h(-6)), comPromo(dia(-15))], AGORA, OPTS)).toBeNull();
  });
});

describe('dado incompleto', () => {
  it('foto atual invalida (truncada ou com erro) nao conclui nada', () => {
    const hist = [foto({ tiradaEm: h(-6), ativa: ativa(dia(1)) })];
    expect(acompanharPromocoes(foto({ varreduraOk: false }), hist, AGORA, OPTS)).toBeNull();
    expect(acompanharPromocoes(foto({ varreduraOk: false, ativa: ativa(dia(1)) }), [], AGORA, OPTS)).toBeNull();
  });

  const anuncios = [{ id: 'MLB1', title: 'A' }, { id: 'MLB2', title: 'B' }];
  const base = { tiradaEm: h(0), itens: [], anuncios, buybox: () => null };

  it('montarFotos: anuncio com erro e varredura truncada saem com varreduraOk=false', () => {
    const f = montarFotos({ ...base, idsOk: new Set(['MLB1']), truncado: false });
    expect(f.map((x) => x.varreduraOk)).toEqual([true, false]);
    const t = montarFotos({ ...base, idsOk: new Set(['MLB1', 'MLB2']), truncado: true });
    expect(t.every((x) => !x.varreduraOk)).toBe(true);
  });

  it('montarFotos: propostas abertas nao contam as semEfeito; copia o Buy Box com a data do dado', () => {
    const linha = (o: any) => ({ itemId: 'MLB1', tipo: 'DEAL', rotulo: 'Oferta', nome: null, promocaoId: 'P', ofertaId: null, inicio: null, fim: null, prazoParaAderir: null, precoProposto: 90, precoAtual: 100, precoCheio: 120, ...o });
    const itens: any[] = [
      linha({ situacao: 'proposta', semEfeito: false }),
      linha({ situacao: 'proposta', semEfeito: true, promocaoId: 'Q' }),
      linha({ situacao: 'ativa', fim: '2026-11-08T23:59:59-03:00', promocaoId: 'A' }),
    ];
    const [f] = montarFotos({
      ...base, itens, anuncios: [anuncios[0]], idsOk: new Set(['MLB1']), truncado: false,
      buybox: () => ({ situacao: 'perdendo', statusMl: 'competing', precoParaGanhar: 80, atualizadoEm: '2026-11-05T10:00:00Z' }),
    });
    expect(f.propostasAbertas).toBe(1);
    expect(f.propostas).toHaveLength(1);
    expect(f.ativa?.fim).toBe('2026-11-09T02:59:59.000Z');
    expect(f.buybox?.atualizadoEm).toBe('2026-11-05T10:00:00Z');
  });
});

describe('resumoEmTexto', () => {
  it('vazio (null) quando nao ha nada a avisar', () => {
    expect(resumoEmTexto(montarAcompanhamento([foto()], new Map(), AGORA, OPTS), 10)).toBeNull();
    expect(resumoEmTexto(montarAcompanhamento([], new Map(), AGORA, OPTS), 10)).toBeNull();
  });

  it('traz as duas listas, conta propostas e respeita o limite POR LISTA', () => {
    const fotos = [1, 2, 3].map((i) => foto({ itemId: `MLB${i}`, ativa: ativa(h(i)), propostasAbertas: i === 1 ? 2 : 0 }));
    fotos.push(foto({ itemId: 'MLB9', titulo: 'Sem promo' }));
    const hist = new Map([['MLB9', [foto({ itemId: 'MLB9', tiradaEm: h(-6), ativa: ativa(dia(1)) })]]]);
    const t = resumoEmTexto(montarAcompanhamento(fotos, hist, AGORA, OPTS), 2)!;
    expect(t).toContain('Termina em até 3 dias (3)');
    expect(t).toContain('termina hoje');
    expect(t).toContain('2 propostas abertas para substituir');
    expect(t).toContain('… e mais 1');
    expect(t).toContain('Ficou sem promoção (1)');
    expect(t).toContain('Sem promoção desde');
  });
});
