import type { LinhaPromocao } from './promocoes';

/**
 * v46: acompanhamento de promocoes (vencendo / sem promocao). SOMENTE LEITURA.
 *
 * Tudo aqui e PURO (sem rede, sem disco, sem relogio): recebe fotos ja carregadas e a hora de
 * agora. A gravacao fica em db/banco.ts e a consulta em promocoesAcompanhamentoConsulta.ts.
 */

// ---------------------------------------------------------------- datas (fuso de Brasilia)

/** Brasilia e UTC-3 o ano todo (sem horario de verao desde 2019). */
const BRT_MS = 3 * 3600 * 1000;
const COBERTA_TOLERANCIA_MIN = 120;

/**
 * Le uma data do ML e devolve ISO em UTC, ou null. Com "Z" ou offset, vale o que vier. SEM fuso
 * (ex.: "2026-11-09T23:59:59"), assume Brasilia: e a conta do vendedor, e o Date.parse nu usaria o
 * fuso do servidor, que muda o dia certo.
 */
export function paraIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const txt = String(s).trim();
  if (!txt) return null;
  const temFuso = /(Z|[+-]\d{2}:?\d{2})$/i.test(txt);
  const t = Date.parse(temFuso ? txt : `${txt.includes('T') ? txt : `${txt}T00:00:00`}-03:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Dia civil em Brasilia (YYYY-MM-DD) de um instante. */
export function diaBrasilia(ms: number): string {
  return new Date(ms - BRT_MS).toISOString().slice(0, 10);
}

/** Dias de calendario (Brasilia) de `agoraMs` ate `alvoMs`. 0 = hoje. Negativo = ja passou o dia. */
export function diasAte(alvoMs: number, agoraMs: number): number {
  const d = (ms: number) => Date.parse(`${diaBrasilia(ms)}T00:00:00Z`);
  return Math.round((d(alvoMs) - d(agoraMs)) / 86400000);
}

/** "dd/mm HH:MM" em horario de Brasilia. */
export function dataHoraBrasilia(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t - BRT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function rotuloDoPrazo(dias: number): string {
  if (dias <= 0) return 'termina hoje';
  return dias === 1 ? 'falta 1 dia' : `faltam ${dias} dias`;
}

function rotuloDaFolga(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// ---------------------------------------------------------------- foto

export interface PropostaFoto {
  tipo: string;
  promocaoId: string | null;
  nome: string | null;
  precoProposto: number | null;
  fim: string | null;
  prazoParaAderir: string | null;
}

export interface FotoPromocao {
  itemId: string;
  /** ISO. Todas as fotos de uma mesma varredura levam o mesmo valor. */
  tiradaEm: string;
  titulo: string | null;
  permalink: string | null;
  /** active, paused, closed... null quando o ML nao informou */
  statusAnuncio: string | null;
  precoAtual: number | null;
  precoCheio: number | null;
  ativa: { tipo: string; id: string | null; nome: string | null; fim: string | null } | null;
  programada: { tipo: string; inicio: string | null; fim: string | null } | null;
  /** propostas abertas SEM as `semEfeito` */
  propostasAbertas: number;
  propostas: PropostaFoto[];
  buybox: { situacao: string | null; statusMl: string | null; precoParaGanhar: number | null; atualizadoEm: string | null } | null;
  /** false = varredura truncada ou anuncio com erro: a foto existe mas NAO entra em comparacao */
  varreduraOk: boolean;
}

export interface BuyBoxCopiado {
  situacao: string | null;
  statusMl: string | null;
  precoParaGanhar: number | null;
}

export interface EntradaDasFotos {
  tiradaEm: string;
  itens: LinhaPromocao[];
  anuncios: Array<{ id: string; title?: string; permalink?: string; status?: string; price?: number | null }>;
  /** anuncios cuja leitura de promocoes deu certo nesta varredura */
  idsOk: Set<string>;
  truncado: boolean;
  buybox: (itemId: string) => (BuyBoxCopiado & { atualizadoEm: string | null }) | null;
}

/** Uma foto por anuncio analisado. Anuncio com erro (ou varredura truncada) sai com varreduraOk=false. */
export function montarFotos(e: EntradaDasFotos): FotoPromocao[] {
  const porItem = new Map<string, LinhaPromocao[]>();
  for (const l of e.itens) {
    if (!porItem.has(l.itemId)) porItem.set(l.itemId, []);
    porItem.get(l.itemId)!.push(l);
  }
  return e.anuncios.map((a) => {
    const ok = e.idsOk.has(a.id) && !e.truncado;
    const ls = porItem.get(a.id) ?? [];
    const base = {
      itemId: a.id,
      tiradaEm: e.tiradaEm,
      titulo: a.title ?? null,
      permalink: a.permalink ?? null,
      statusAnuncio: a.status ?? null,
      precoAtual: ls[0]?.precoAtual ?? null,
      precoCheio: ls[0]?.precoCheio ?? (typeof a.price === 'number' ? a.price : null),
      buybox: e.buybox(a.id),
      varreduraOk: ok,
    };
    if (!ok) return { ...base, precoAtual: null, ativa: null, programada: null, propostasAbertas: 0, propostas: [] };

    // Varias ativas: fica a que vence primeiro (a que o vendedor precisa acompanhar); sem nenhuma
    // com data, a primeira.
    const ativas = ls.filter((l) => l.situacao === 'ativa');
    const comFim = ativas.filter((l) => paraIso(l.fim)).sort((x, y) => Date.parse(paraIso(x.fim)!) - Date.parse(paraIso(y.fim)!));
    const at = comFim[0] ?? ativas[0] ?? null;
    const progs = ls
      .filter((l) => l.situacao === 'programada')
      .sort((x, y) => Date.parse(paraIso(x.inicio) ?? '9999') - Date.parse(paraIso(y.inicio) ?? '9999'));
    const pr = progs[0] ?? null;
    const propostas = ls
      .filter((l) => l.situacao === 'proposta' && !l.semEfeito)
      .map((l) => ({
        tipo: l.tipo,
        promocaoId: l.promocaoId,
        nome: l.nome ?? l.rotulo,
        precoProposto: l.precoProposto,
        fim: paraIso(l.fim),
        prazoParaAderir: paraIso(l.prazoParaAderir),
      }));
    return {
      ...base,
      ativa: at ? { tipo: at.tipo, id: at.promocaoId ?? at.ofertaId, nome: at.nome ?? at.rotulo, fim: paraIso(at.fim) } : null,
      programada: pr ? { tipo: pr.tipo, inicio: paraIso(pr.inicio), fim: paraIso(pr.fim) } : null,
      propostasAbertas: propostas.length,
      propostas,
    };
  });
}

// ---------------------------------------------------------------- situacoes

export type SituacaoAcompanhamento = 'TERMINA_EM_BREVE' | 'FICOU_SEM_PROMOCAO' | 'SEM_DATA_DE_FIM';

export interface Ocorrencia {
  situacao: SituacaoAcompanhamento;
  itemId: string;
  titulo: string | null;
  permalink: string | null;
  precoAtual: number | null;
  /** promocao ativa (TERMINA_EM_BREVE, SEM_DATA_DE_FIM) ou a ultima que o anuncio teve (FICOU_SEM_PROMOCAO) */
  promocao: { tipo: string; nome: string | null } | null;
  fim: string | null;
  diasRestantes: number | null;
  /** "termina hoje" / "falta 1 dia" / "faltam N dias" */
  prazo: string | null;
  /** ha programada que comeca ate 2h depois do fim da atual (ou antes): nao e problema */
  coberta: boolean;
  /** programada que comeca depois do fim, mas com folga maior que 2h: nao cobre */
  folgaMinutos: number | null;
  folga: string | null;
  programadaInicio: string | null;
  propostasAbertas: number;
  propostas: PropostaFoto[];
  /** FICOU_SEM_PROMOCAO: tirada_em da primeira foto valida sem promocao depois da ultima com */
  desde: string | null;
  ultimaPromocaoVistaEm: string | null;
}

export interface OpcoesDoAcompanhamento {
  diasAviso: number;
  semPromoDias: number;
}

const temPromo = (f: FotoPromocao): boolean => !!f.ativa || !!f.programada;

/**
 * Avalia UM anuncio.
 *
 * `historico`: fotos VALIDAS anteriores a atual, da mais recente para a mais antiga (a atual nao
 * entra). A regra de FICOU_SEM_PROMOCAO nao olha so a anterior, senao o anuncio sumiria da lista na
 * varredura seguinte: vale enquanto a ultima foto valida COM promocao tiver no maximo
 * `semPromoDias` e todas as validas depois dela (incluindo a atual) estiverem sem promocao.
 */
export function acompanharPromocoes(
  fotoAtual: FotoPromocao,
  historico: FotoPromocao[],
  agora: number,
  opts: OpcoesDoAcompanhamento,
): Ocorrencia | null {
  // Varredura truncada ou anuncio com erro: nao conclui nada sobre ele.
  if (!fotoAtual.varreduraOk) return null;

  const base = {
    itemId: fotoAtual.itemId,
    titulo: fotoAtual.titulo,
    permalink: fotoAtual.permalink,
    precoAtual: fotoAtual.precoAtual,
    propostasAbertas: fotoAtual.propostasAbertas,
    propostas: fotoAtual.propostas,
    coberta: false,
    folgaMinutos: null as number | null,
    folga: null as string | null,
    programadaInicio: null as string | null,
    desde: null as string | null,
    ultimaPromocaoVistaEm: null as string | null,
  };

  const at = fotoAtual.ativa;
  if (at) {
    const promocao = { tipo: at.tipo, nome: at.nome };
    const fimMs = at.fim ? Date.parse(at.fim) : NaN;
    if (Number.isNaN(fimMs)) {
      // Nao chuta data: sem fim informado pela API, fica "sem data informada".
      return { ...base, situacao: 'SEM_DATA_DE_FIM', promocao, fim: null, diasRestantes: null, prazo: null };
    }
    // Fim que ja passou e a ativa ainda aparece: o ML nao atualizou. Nao e "vencendo", e dado velho.
    if (fimMs <= agora) return null;
    const dias = diasAte(fimMs, agora);
    if (dias > opts.diasAviso) return null;

    let coberta = false;
    let folgaMinutos: number | null = null;
    let programadaInicio: string | null = null;
    const pr = fotoAtual.programada;
    const inicioMs = pr?.inicio ? Date.parse(pr.inicio) : NaN;
    if (pr && !Number.isNaN(inicioMs)) {
      programadaInicio = pr.inicio;
      const folga = (inicioMs - fimMs) / 60000;
      if (folga <= COBERTA_TOLERANCIA_MIN) coberta = true;
      else folgaMinutos = Math.round(folga);
    }
    return {
      ...base,
      situacao: 'TERMINA_EM_BREVE',
      promocao,
      fim: at.fim,
      diasRestantes: dias,
      prazo: rotuloDoPrazo(dias),
      coberta,
      folgaMinutos,
      folga: folgaMinutos != null ? rotuloDaFolga(folgaMinutos) : null,
      programadaInicio,
    };
  }

  if (fotoAtual.programada) return null; // tem promocao programada: nao ficou sem

  // Pausado ou finalizado nao entra (sem status informado, avalia).
  if (fotoAtual.statusAnuncio && fotoAtual.statusAnuncio !== 'active') return null;

  const corte = agora - opts.semPromoDias * 86400000;
  const iUltima = historico.findIndex(temPromo);
  if (iUltima < 0) return null; // nunca teve promocao (na janela guardada)
  const ultima = historico[iUltima];
  if (Date.parse(ultima.tiradaEm) < corte) return null; // saiu da lista por tempo
  // `historico` e do mais novo ao mais antigo: o que vem antes de iUltima e posterior a ela, e por
  // construcao esta sem promocao. A mais antiga delas marca "desde quando".
  const semPromo = historico.slice(0, iUltima);
  const desde = (semPromo.length ? semPromo[semPromo.length - 1] : fotoAtual).tiradaEm;
  const a = ultima.ativa ?? null;
  return {
    ...base,
    situacao: 'FICOU_SEM_PROMOCAO',
    promocao: a ? { tipo: a.tipo, nome: a.nome } : ultima.programada ? { tipo: ultima.programada.tipo, nome: null } : null,
    fim: a?.fim ?? ultima.programada?.fim ?? null,
    diasRestantes: null,
    prazo: null,
    desde,
    ultimaPromocaoVistaEm: ultima.tiradaEm,
  };
}

// ---------------------------------------------------------------- lista final e texto

export interface Acompanhamento {
  atualizadoEm: string | null;
  diasAviso: number;
  terminaEmBreve: Ocorrencia[];
  ficouSemPromocao: Ocorrencia[];
  semDataDeFim: Ocorrencia[];
  historicoDisponivel: boolean;
}

export function montarAcompanhamento(
  atuais: FotoPromocao[],
  historicoPorItem: Map<string, FotoPromocao[]>,
  agora: number,
  opts: OpcoesDoAcompanhamento,
): Acompanhamento {
  const termina: Ocorrencia[] = [];
  const sem: Ocorrencia[] = [];
  const semData: Ocorrencia[] = [];
  for (const f of atuais) {
    const o = acompanharPromocoes(f, historicoPorItem.get(f.itemId) ?? [], agora, opts);
    if (!o) continue;
    (o.situacao === 'TERMINA_EM_BREVE' ? termina : o.situacao === 'FICOU_SEM_PROMOCAO' ? sem : semData).push(o);
  }
  // As nao cobertas primeiro (sao as que pedem acao), depois por data de fim.
  termina.sort((a, b) => Number(a.coberta) - Number(b.coberta) || Date.parse(a.fim!) - Date.parse(b.fim!));
  sem.sort((a, b) => Date.parse(b.desde!) - Date.parse(a.desde!));
  semData.sort((a, b) => (a.titulo ?? a.itemId).localeCompare(b.titulo ?? b.itemId));
  return {
    atualizadoEm: atuais[0]?.tiradaEm ?? null,
    diasAviso: opts.diasAviso,
    terminaEmBreve: termina,
    ficouSemPromocao: sem,
    semDataDeFim: semData,
    historicoDisponivel: true,
  };
}

const rotulo = (o: Ocorrencia): string => (o.promocao ? o.promocao.nome ?? o.promocao.tipo : 'promoção');

function linhaTermina(o: Ocorrencia): string {
  const props = o.propostasAbertas
    ? `${o.propostasAbertas} proposta${o.propostasAbertas > 1 ? 's' : ''} aberta${o.propostasAbertas > 1 ? 's' : ''} para substituir`
    : 'nenhuma proposta aberta para substituir';
  const prog = o.folga ? `Programada começa ${dataHoraBrasilia(o.programadaInicio)}, folga de ${o.folga} (não cobre).` : '';
  return [
    `• ${(o.titulo ?? o.itemId).slice(0, 60)} (${o.itemId})`,
    `  ${rotulo(o)}: ${o.prazo} (fim ${dataHoraBrasilia(o.fim)}). ${props}.${prog ? ` ${prog}` : ''}`,
  ].join('\n');
}

function linhaSemPromo(o: Ocorrencia): string {
  const antes = o.promocao ? ` Antes: ${rotulo(o)}.` : '';
  const props = o.propostasAbertas ? ` ${o.propostasAbertas} proposta${o.propostasAbertas > 1 ? 's' : ''} aberta${o.propostasAbertas > 1 ? 's' : ''}.` : '';
  return [`• ${(o.titulo ?? o.itemId).slice(0, 60)} (${o.itemId})`, `  Sem promoção desde ${dataHoraBrasilia(o.desde)}.${antes}${props}`].join('\n');
}

/**
 * Texto pronto para o Telegram. Fica de fora: as "cobertas" (aparecem so no painel) e SEM_DATA_DE_FIM
 * (so painel: sem data nao ha prazo para avisar). `limite` vale POR LISTA. null quando nao ha nada.
 */
export function resumoEmTexto(a: Acompanhamento, limite: number): string | null {
  const termina = a.terminaEmBreve.filter((o) => !o.coberta);
  const sem = a.ficouSemPromocao;
  const secao = (titulo: string, lista: Ocorrencia[], fmt: (o: Ocorrencia) => string): string | null => {
    if (!lista.length) return null;
    const mostradas = lista.slice(0, limite).map(fmt);
    const resto = lista.length - mostradas.length;
    return `${titulo} (${lista.length})\n${mostradas.join('\n')}${resto > 0 ? `\n… e mais ${resto}` : ''}`;
  };
  const partes = [
    secao(`Termina em até ${a.diasAviso} dia${a.diasAviso > 1 ? 's' : ''}`, termina, linhaTermina),
    secao('Ficou sem promoção', sem, linhaSemPromo),
  ].filter((p): p is string => !!p);
  return partes.length ? partes.join('\n\n') : null;
}
