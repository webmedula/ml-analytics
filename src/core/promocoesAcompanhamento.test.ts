import { describe, expect, it } from 'vitest';
import {
  acompanharPromocoes,
  agruparSemData,
  agruparVencendo,
  avaliarCobertura,
  diasAte,
  FotoPromocao,
  montarAcompanhamento,
  montarFotos,
  paraIso,
  prazosParaAderir,
  propostasDoAnuncio,
  resumoEmTexto,
} from './promocoesAcompanhamento';

const OPTS = { diasAviso: 3, semPromoDias: 14 };
const AGORA = Date.parse('2026-11-05T15:00:00Z'); // 05/11 12:00 em Brasilia
const h = (horas: number) => new Date(AGORA + horas * 3600000).toISOString();
const dia = (d: number) => h(d * 24);

function foto(over: Partial<FotoPromocao> = {}): FotoPromocao {
  return {
    itemId: 'MLB1', tiradaEm: h(0), titulo: 'Lanterna', permalink: 'https://ml/MLB1', statusAnuncio: 'active',
    precoAtual: 100, precoCheio: 120, ativa: null, programadas: [], propostasAbertas: 0, propostas: [],
    buybox: null, varreduraOk: true, ...over,
  };
}
const ativa = (fim: string | null) => ({ tipo: 'DEAL', id: 'P1', nome: 'Oferta X', fim });
const prog = (tipo: string, inicio: string | null, fim: string | null, semEfeito = false) => ({ tipo, id: null, inicio, fim, precoProposto: null, semEfeito });

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

  it('programada que comeca ate 2h depois do fim = coberta e fora do texto do Gerente', () => {
    const f = foto({ ativa: ativa(dia(2)), programadas: [prog('LIGHTNING', new Date(Date.parse(dia(2)) + 3600000).toISOString(), dia(6))] });
    const o = acompanharPromocoes(f, [], AGORA, OPTS)!;
    expect(o.coberta).toBe(true);
    const a = montarAcompanhamento([f], new Map(), AGORA, OPTS);
    expect(a.terminaEmBreve).toHaveLength(1);
    expect(resumoEmTexto(a, 10)).toBeNull();
    // inicio no passado continua aceito, desde que termine depois da ativa
    const antes = foto({ ativa: ativa(dia(2)), programadas: [prog('X', dia(-1), dia(6))] });
    expect(acompanharPromocoes(antes, [], AGORA, OPTS)?.coberta).toBe(true);
  });

  it('folga maior que 2h nao e coberta e mostra a folga', () => {
    const f = foto({ ativa: ativa(dia(2)), programadas: [prog('X', new Date(Date.parse(dia(2)) + 3 * 3600000).toISOString(), dia(6))] });
    const o = acompanharPromocoes(f, [], AGORA, OPTS)!;
    expect(o.coberta).toBe(false);
    expect(o.folgaMinutos).toBe(180);
    expect(o.folga).toBe('3h');
    const exato = foto({ ativa: ativa(dia(2)), programadas: [prog('X', new Date(Date.parse(dia(2)) + 2 * 3600000).toISOString(), dia(6))] });
    expect(acompanharPromocoes(exato, [], AGORA, OPTS)?.coberta).toBe(true);
    expect(montarAcompanhamento([f], new Map(), AGORA, OPTS).terminaEmBreve[0].folga).toBe('3h');
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
    const comProg = foto({ tiradaEm: h(-6), programadas: [prog('X', h(5), dia(3))] });
    expect(acompanharPromocoes(sem(h(0)), [comProg], AGORA, OPTS)?.situacao).toBe('FICOU_SEM_PROMOCAO');
    expect(acompanharPromocoes(foto({ programadas: [prog('X', h(5), dia(3))] }), [comPromo(h(-6))], AGORA, OPTS)).toBeNull();
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


// ------------------------------------------------------------------ v47

const rot = (t: string) => ({ SELLER_CAMPAIGN: 'Campanha propria', DEAL: 'Campanha do ML' } as Record<string, string>)[t] ?? t;

function linha(over: Record<string, unknown> = {}): any {
  return {
    itemId: 'MLB1', titulo: 'Lanterna', permalink: null, tipo: 'DEAL', rotulo: 'Campanha do ML', nome: 'Promo', promocaoId: 'P1', ofertaId: null,
    situacao: 'proposta', semEfeito: false, precoProposto: 90, precoAtual: 100, precoCheio: 120, mlPercentual: null, voceRecebe: 50,
    diferencaPorVenda: -5, inicio: null, fim: null, prazoParaAderir: null, ...over,
  };
}

describe('coberta (v47): so cobre quem termina depois, comeca ate 2h e tem efeito', () => {
  const fimAtiva = Date.parse('2026-11-08T23:59:00-03:00');
  const p = (inicio: string | null, fim: string | null, semEfeito = false) => ({ tipo: 'X', id: null, inicio, fim, precoProposto: null, semEfeito });

  it('programada que comecou 19/10 e termina junto com a ativa NAO cobre', () => {
    const r = avaliarCobertura(fimAtiva, [p('2026-10-19T00:00:00-03:00', '2026-11-08T23:59:00-03:00')]);
    expect(r.coberta).toBe(false);
    // termina ANTES tambem nao cobre
    expect(avaliarCobertura(fimAtiva, [p('2026-10-19T00:00:00-03:00', '2026-11-05T23:59:00-03:00')]).coberta).toBe(false);
  });

  it('programada 12/11 a 01/12 com a ativa acabando 12/11 23:59 e inicio 13/11 00:00 cobre (folga de 1 min)', () => {
    const fim = Date.parse('2026-11-12T23:59:00-03:00');
    const r = avaliarCobertura(fim, [p('2026-11-13T00:00:00-03:00', '2026-12-01T23:59:00-03:00')]);
    expect(r.coberta).toBe(true);
  });

  it('programada semEfeito nao cobre', () => {
    const fim = Date.parse('2026-11-12T23:59:00-03:00');
    expect(avaliarCobertura(fim, [p('2026-11-13T00:00:00-03:00', '2026-12-01T23:59:00-03:00', true)]).coberta).toBe(false);
  });

  it('alguma entre varias cobre; sem fim cobre; folga e a da que termina depois mas comeca tarde', () => {
    const mist = [p('2026-10-19T00:00:00-03:00', '2026-11-08T23:59:00-03:00'), p('2026-11-09T00:00:00-03:00', null)];
    expect(avaliarCobertura(fimAtiva, mist).coberta).toBe(true);
    const tarde = avaliarCobertura(fimAtiva, [p('2026-11-09T05:59:00-03:00', '2026-12-01T00:00:00-03:00')]);
    expect(tarde.coberta).toBe(false);
    expect(tarde.folgaMinutos).toBe(360);
  });
});

describe('grupos de "vence em breve"', () => {
  const oc = (i: number, fim: string, nome = 'OUTUBRO 2026', id: string | null = 'C1', coberta = false) =>
    acompanharPromocoes(
      foto({ itemId: `MLB${i}`, titulo: `Item ${i}`, ativa: { tipo: 'SELLER_CAMPAIGN', id, nome, fim: paraIso(fim) }, programadas: coberta ? [prog('X', dia(2), dia(9))] : [] }),
      [], AGORA, OPTS,
    )!;

  it('19 anuncios com a mesma promocao e o mesmo fim viram 1 grupo com 19', () => {
    const fim = '2026-11-07T23:59:00-03:00';
    const ocs = Array.from({ length: 19 }, (_, i) => oc(i + 1, fim));
    const g = agruparVencendo(ocs, rot);
    expect(g).toHaveLength(1);
    expect(g[0].total).toBe(19);
    expect(g[0].rotuloTipo).toBe('Campanha propria');
    expect(g[0].prazo).toBe('faltam 2 dias');
  });

  it('mesma promocao com fins em dias diferentes = grupos separados; horarios do mesmo dia = um grupo', () => {
    const a = oc(1, '2026-11-07T23:59:00-03:00');
    const b = oc(2, '2026-11-06T23:59:00-03:00');
    const c = oc(3, '2026-11-07T10:00:00-03:00');
    const g = agruparVencendo([a, b, c], rot);
    expect(g.map((x) => x.total).sort()).toEqual([1, 2]);
  });

  it('sem id agrupa por tipo + nome; cobertos vao para o fim do grupo e grupo todo coberto vai para o fim da lista', () => {
    const fim = '2026-11-07T23:59:00-03:00';
    const todos = [oc(1, fim, 'Cob', null, true), oc(2, fim, 'Cob', null, true)];
    const mista = [oc(3, fim, 'Aberta', null, true), oc(4, fim, 'Aberta', null, false)];
    const g = agruparVencendo([...todos, ...mista], rot);
    expect(g[0].nome).toBe('Aberta');
    expect(g[0].anuncios.map((o) => o.coberta)).toEqual([false, true]);
    expect(g[1].nome).toBe('Cob');
    expect(g[1].todosCobertos).toBe(true);
  });

  it('sem data agrupado por promocao, com a contagem', () => {
    const sd = (i: number, nome: string) => acompanharPromocoes(foto({ itemId: `MLB${i}`, ativa: { tipo: 'SMART', id: null, nome, fim: null } }), [], AGORA, OPTS)!;
    const g = agruparSemData([sd(1, 'Impulsione'), sd(2, 'Impulsione'), sd(3, 'Meli Essencial')], rot);
    expect(g.map((x) => [x.nome, x.total])).toEqual([['Impulsione', 2], ['Meli Essencial', 1]]);
  });
});

describe('melhor substituta (vem do cache atual)', () => {
  it('maior "voce recebe", ignorando semEfeito; o resto vem em outras, da melhor para a pior', () => {
    const itens = [
      linha({ promocaoId: 'A', voceRecebe: 40 }),
      linha({ promocaoId: 'B', voceRecebe: 90, semEfeito: true }),
      linha({ promocaoId: 'C', voceRecebe: 70 }),
      linha({ promocaoId: 'D', voceRecebe: null }),
      linha({ itemId: 'MLB2', promocaoId: 'Z', voceRecebe: 999 }),
      linha({ promocaoId: 'E', situacao: 'ativa', voceRecebe: 500 }),
    ];
    const r = propostasDoAnuncio('MLB1', foto(), itens);
    expect(r.map((x) => x.promocaoId)).toEqual(['C', 'A', 'D']);
  });

  it('o cache vale mesmo quando a foto traz outra lista; sem cache cai nas propostas da foto', () => {
    const f = foto({ propostas: [{ tipo: 'DEAL', promocaoId: 'F', nome: 'Foto', precoProposto: 1, fim: null, prazoParaAderir: null }] });
    expect(propostasDoAnuncio('MLB1', f, [])).toEqual([]);
    expect(propostasDoAnuncio('MLB1', f, null).map((x) => x.promocaoId)).toEqual(['F']);
  });

  it('montarAcompanhamento preenche substituta, outras e propostasAbertas pelo cache', () => {
    const f = foto({ ativa: ativa(dia(2)), propostasAbertas: 9 });
    const itens = [linha({ promocaoId: 'A', voceRecebe: 10 }), linha({ promocaoId: 'B', voceRecebe: 20 })];
    const o = montarAcompanhamento([f], new Map(), AGORA, OPTS, { itens, rotuloDoTipo: rot }).terminaEmBreve[0];
    expect(o.substituta?.promocaoId).toBe('B');
    expect(o.outras.map((x) => x.promocaoId)).toEqual(['A']);
    expect(o.propostasAbertas).toBe(2);
  });
});

describe('PRAZO_ADERIR_ACABANDO', () => {
  const prazo = dia(2);
  const l = (over: Record<string, unknown> = {}) => linha({ prazoParaAderir: prazo, ...over });

  it('entra com o ML bancando parte', () => {
    expect(prazosParaAderir([l({ mlPercentual: 5, diferencaPorVenda: -3 })], AGORA, 3)).toHaveLength(1);
  });
  it('entra com "vs. hoje" >= 0', () => {
    expect(prazosParaAderir([l({ diferencaPorVenda: 0 })], AGORA, 3)).toHaveLength(1);
    expect(prazosParaAderir([l({ diferencaPorVenda: 1.2 })], AGORA, 3)).toHaveLength(1);
  });
  it('fica fora com "vs. hoje" < 0 sem ML, semEfeito, sem diferenca, sem prazo, prazo passado ou longe', () => {
    expect(prazosParaAderir([l({ diferencaPorVenda: -1 })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([l({ diferencaPorVenda: null })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([l({ mlPercentual: 5, semEfeito: true })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([l({ mlPercentual: 5, prazoParaAderir: null })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([l({ mlPercentual: 5, prazoParaAderir: h(-1) })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([l({ mlPercentual: 5, prazoParaAderir: dia(5) })], AGORA, 3)).toHaveLength(0);
  });
  it('fica fora se o anuncio ja participa DESSA promocao (ativa ou programada), mas nao de outra', () => {
    const prop = l({ mlPercentual: 5 });
    expect(prazosParaAderir([prop, linha({ situacao: 'ativa', promocaoId: 'P1' })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([prop, linha({ situacao: 'programada', promocaoId: 'P1' })], AGORA, 3)).toHaveLength(0);
    expect(prazosParaAderir([prop, linha({ situacao: 'ativa', promocaoId: 'OUTRA' })], AGORA, 3)).toHaveLength(1);
  });
  it('uma linha por anuncio + proposta, ordenada pelo prazo', () => {
    const r = prazosParaAderir(
      [l({ promocaoId: 'A', mlPercentual: 5, prazoParaAderir: dia(2) }), l({ promocaoId: 'B', mlPercentual: 5, prazoParaAderir: dia(1) }), l({ itemId: 'MLB2', promocaoId: 'A', mlPercentual: 5, prazoParaAderir: dia(1.5) })],
      AGORA, 3,
    );
    expect(r.map((x) => `${x.itemId}/${x.promocao.promocaoId}`)).toEqual(['MLB1/B', 'MLB2/A', 'MLB1/A']);
    expect(r[0].prazo).toBe('falta 1 dia');
  });
});

describe('resumoEmTexto agrupado (v47)', () => {
  it('vazio (null) quando nao ha nada a avisar', () => {
    expect(resumoEmTexto(montarAcompanhamento([foto()], new Map(), AGORA, OPTS), 10)).toBeNull();
    expect(resumoEmTexto(montarAcompanhamento([], new Map(), AGORA, OPTS), 10)).toBeNull();
  });

  it('as tres secoes, com titulos do analytics, grupo com cobertos, ate 5 anuncios e +N', () => {
    const fim = '2026-11-08T23:59:00-03:00';
    const fotos = Array.from({ length: 8 }, (_, i) =>
      foto({
        itemId: `MLB${i + 1}`, titulo: `Item ${i + 1}`,
        ativa: { tipo: 'SELLER_CAMPAIGN', id: 'C1', nome: 'OUTUBRO 2026', fim: paraIso(fim) },
        programadas: i < 2 ? [prog('X', dia(3), dia(20))] : [],
      }),
    );
    fotos.push(foto({ itemId: 'MLB90', titulo: 'Sem promo' }));
    const hist = new Map([['MLB90', [foto({ itemId: 'MLB90', tiradaEm: h(-6), ativa: ativa(dia(1)) })]]]);
    const itens = [linha({ itemId: 'MLB50', titulo: 'Prazo', nome: 'Black Friday 2026', promocaoId: 'BF', mlPercentual: 4, diferencaPorVenda: 1.2, prazoParaAderir: dia(2) })];
    const t = resumoEmTexto(montarAcompanhamento(fotos, hist, AGORA, OPTS, { itens, rotuloDoTipo: rot }), 10)!;
    expect(t).toContain('⏳ Vencendo\n• OUTUBRO 2026 (Campanha propria) termina dom 08/11: 8 anúncios, 2 já cobertos');
    expect(t.match(/ {2}– MLB/g)).toHaveLength(5);
    expect(t).toContain('  +1');
    expect(t).toContain('🚫 Ficou sem promoção\n• MLB90 Sem promo — desde 05/11');
    expect(t).toContain('📅 Prazo para aderir acabando\n• Black Friday 2026 · MLB50 Prazo — fecha sáb 07/11 · você recebe +R$ 1,20');
  });

  it('"termina hoje"; grupo 100% coberto e sem-data ficam fora; limite vale por secao', () => {
    const cob = foto({ itemId: 'MLB1', ativa: ativa(dia(2)), programadas: [prog('X', dia(2), dia(9))] });
    const sd = foto({ itemId: 'MLB2', ativa: { tipo: 'SMART', id: null, nome: 'Auto', fim: null } });
    expect(resumoEmTexto(montarAcompanhamento([cob, sd], new Map(), AGORA, OPTS), 10)).toBeNull();
    const hoje = [1, 2, 3].map((i) => foto({ itemId: `MLB${i}`, ativa: { tipo: 'DEAL', id: `P${i}`, nome: `Promo ${i}`, fim: h(i) } }));
    const t = resumoEmTexto(montarAcompanhamento(hoje, new Map(), AGORA, OPTS), 2)!;
    expect(t).toContain('termina hoje');
    expect(t).toContain('… e mais 1');
  });
});

describe('aba Promoções volta ao formato da v45 (sem o bloco antigo)', () => {
  it('o bloco "Vencendo / sem promoção" saiu da aba e mora na aba Acompanhamento', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf-8');
    const ini = html.indexOf('class="panel aba-promocoes"');
    const promo = html.slice(ini, html.indexOf('</section>', ini));
    expect(promo).not.toContain('id="acompBody"');
    expect(promo).toContain('id="acompResumo"');
    const ini2 = html.indexOf('class="panel aba-acompanhamento"');
    expect(ini2).toBeGreaterThan(-1);
    expect(html.slice(ini2, html.indexOf('</section>', ini2))).toContain('id="acompBody"');
  });
});
