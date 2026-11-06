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

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "sáb 08/11" em horario de Brasilia. */
export function diaSemanaData(iso: string | null): string {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const d = new Date(t - BRT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DIAS_SEMANA[d.getUTCDay()]} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
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
  /** v47: para o historico (fotos da v46 nao trazem) */
  mlPercentual?: number | null;
  voceRecebe?: number | null;
  diferencaPorVenda?: number | null;
}

/** v47: TODAS as programadas do anuncio (a v46 guardava so uma). */
export interface ProgramadaFoto {
  tipo: string;
  id: string | null;
  inicio: string | null;
  fim: string | null;
  precoProposto: number | null;
  /** preco acima do que o comprador paga hoje: nao define o preco, entao nao cobre nada */
  semEfeito: boolean;
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
  programadas: ProgramadaFoto[];
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
    if (!ok) return { ...base, precoAtual: null, ativa: null, programadas: [], propostasAbertas: 0, propostas: [] };

    // Varias ativas: fica a que vence primeiro (a que o vendedor precisa acompanhar); sem nenhuma
    // com data, a primeira.
    const ativas = ls.filter((l) => l.situacao === 'ativa');
    const comFim = ativas.filter((l) => paraIso(l.fim)).sort((x, y) => Date.parse(paraIso(x.fim)!) - Date.parse(paraIso(y.fim)!));
    const at = comFim[0] ?? ativas[0] ?? null;
    const precoHoje = ls[0]?.precoAtual ?? null;
    const programadas: ProgramadaFoto[] = ls
      .filter((l) => l.situacao === 'programada')
      .map((l) => ({
        tipo: l.tipo,
        id: l.promocaoId ?? l.ofertaId,
        inicio: paraIso(l.inicio),
        fim: paraIso(l.fim),
        precoProposto: l.precoProposto,
        semEfeito: l.precoProposto != null && precoHoje != null && l.precoProposto > precoHoje + 0.005,
      }))
      .sort((x, y) => Date.parse(x.inicio ?? '9999') - Date.parse(y.inicio ?? '9999'));
    const propostas = ls
      .filter((l) => l.situacao === 'proposta' && !l.semEfeito)
      .map((l) => ({
        tipo: l.tipo,
        promocaoId: l.promocaoId,
        nome: l.nome ?? l.rotulo,
        precoProposto: l.precoProposto,
        fim: paraIso(l.fim),
        prazoParaAderir: paraIso(l.prazoParaAderir),
        mlPercentual: l.mlPercentual,
        voceRecebe: l.voceRecebe,
        diferencaPorVenda: l.diferencaPorVenda,
      }));
    return {
      ...base,
      ativa: at ? { tipo: at.tipo, id: at.promocaoId ?? at.ofertaId, nome: at.nome ?? at.rotulo, fim: paraIso(at.fim) } : null,
      programadas,
      propostasAbertas: propostas.length,
      propostas,
    };
  });
}

// ---------------------------------------------------------------- situacoes

export type SituacaoAcompanhamento = 'TERMINA_EM_BREVE' | 'FICOU_SEM_PROMOCAO' | 'SEM_DATA_DE_FIM';

/** Uma proposta aberta que pode substituir o que acaba. Vem do cache atual (getPromocoes). */
export interface Substituta {
  tipo: string;
  promocaoId: string | null;
  nome: string | null;
  precoProposto: number | null;
  mlPercentual: number | null;
  voceRecebe: number | null;
  diferencaPorVenda: number | null;
  prazoParaAderir: string | null;
}

export interface Ocorrencia {
  situacao: SituacaoAcompanhamento;
  itemId: string;
  titulo: string | null;
  permalink: string | null;
  precoAtual: number | null;
  /** promocao ativa (TERMINA_EM_BREVE, SEM_DATA_DE_FIM) ou a ultima que o anuncio teve (FICOU_SEM_PROMOCAO) */
  promocao: { tipo: string; nome: string | null } | null;
  promocaoId: string | null;
  fim: string | null;
  diasRestantes: number | null;
  /** "termina hoje" / "falta 1 dia" / "faltam N dias" */
  prazo: string | null;
  /** alguma programada realmente cobre o fim da ativa (ver `avaliarCobertura`) */
  coberta: boolean;
  /** programada que comeca depois do fim, mas com folga maior que 2h: nao cobre */
  folgaMinutos: number | null;
  folga: string | null;
  programadaInicio: string | null;
  propostasAbertas: number;
  /** v47: a melhor proposta aberta (maior "voce recebe", sem `semEfeito`) e as demais, da melhor para a pior */
  substituta: Substituta | null;
  outras: Substituta[];
  /** FICOU_SEM_PROMOCAO: tirada_em da primeira foto valida sem promocao depois da ultima com */
  desde: string | null;
  ultimaPromocaoVistaEm: string | null;
}

export interface OpcoesDoAcompanhamento {
  diasAviso: number;
  semPromoDias: number;
}

const temPromo = (f: FotoPromocao): boolean => !!f.ativa || f.programadas.length > 0;

/**
 * v47: alguma programada cobre o fim da ativa? So cobre se TODAS forem verdadeiras:
 *  - comeca ate 120 min depois do fim da ativa (inicio no passado tambem vale);
 *  - termina DEPOIS do fim da ativa (ou nao tem data de fim);
 *  - nao esta `semEfeito` (preco acima do atual).
 * Uma programada que ja vigora e termina junto (ou antes) da ativa nao cobre nada. A folga devolvida
 * e a da programada que termina depois mas comeca com mais de 2h de intervalo.
 */
export function avaliarCobertura(
  fimAtivaMs: number,
  programadas: ProgramadaFoto[],
): { coberta: boolean; folgaMinutos: number | null; programadaInicio: string | null } {
  let folgaMinutos: number | null = null;
  let programadaInicio: string | null = null;
  for (const p of programadas) {
    if (p.semEfeito) continue;
    const iniMs = p.inicio ? Date.parse(p.inicio) : NaN;
    if (Number.isNaN(iniMs)) continue; // sem inicio nao da para avaliar: nao chuta
    const fimMs = p.fim ? Date.parse(p.fim) : NaN;
    if (!Number.isNaN(fimMs) && fimMs <= fimAtivaMs) continue; // nao termina depois da ativa
    const folga = (iniMs - fimAtivaMs) / 60000;
    if (folga <= COBERTA_TOLERANCIA_MIN) return { coberta: true, folgaMinutos: null, programadaInicio: p.inicio };
    if (folgaMinutos == null || folga < folgaMinutos) {
      folgaMinutos = Math.round(folga);
      programadaInicio = p.inicio;
    }
  }
  return { coberta: false, folgaMinutos, programadaInicio };
}

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
    substituta: null as Substituta | null,
    outras: [] as Substituta[],
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
    const promocaoId = at.id;
    const fimMs = at.fim ? Date.parse(at.fim) : NaN;
    if (Number.isNaN(fimMs)) {
      // Nao chuta data: sem fim informado pela API, fica "sem data informada".
      return { ...base, situacao: 'SEM_DATA_DE_FIM', promocao, promocaoId, fim: null, diasRestantes: null, prazo: null };
    }
    // Fim que ja passou e a ativa ainda aparece: o ML nao atualizou. Nao e "vencendo", e dado velho.
    if (fimMs <= agora) return null;
    const dias = diasAte(fimMs, agora);
    if (dias > opts.diasAviso) return null;

    const cob = avaliarCobertura(fimMs, fotoAtual.programadas);
    return {
      ...base,
      situacao: 'TERMINA_EM_BREVE',
      promocao,
      promocaoId,
      fim: at.fim,
      diasRestantes: dias,
      prazo: rotuloDoPrazo(dias),
      coberta: cob.coberta,
      folgaMinutos: cob.folgaMinutos,
      folga: cob.folgaMinutos != null ? rotuloDaFolga(cob.folgaMinutos) : null,
      programadaInicio: cob.programadaInicio,
    };
  }

  if (fotoAtual.programadas.length > 0) return null; // tem promocao programada: nao ficou sem

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
  const prog = ultima.programadas[0] ?? null;
  return {
    ...base,
    situacao: 'FICOU_SEM_PROMOCAO',
    promocao: a ? { tipo: a.tipo, nome: a.nome } : prog ? { tipo: prog.tipo, nome: null } : null,
    promocaoId: a?.id ?? prog?.id ?? null,
    fim: a?.fim ?? prog?.fim ?? null,
    diasRestantes: null,
    prazo: null,
    desde,
    ultimaPromocaoVistaEm: ultima.tiradaEm,
  };
}

// ---------------------------------------------------------------- melhor substituta

const paraSubstituta = (l: LinhaPromocao): Substituta => ({
  tipo: l.tipo,
  promocaoId: l.promocaoId,
  nome: l.nome ?? l.rotulo,
  precoProposto: l.precoProposto,
  mlPercentual: l.mlPercentual,
  voceRecebe: l.voceRecebe,
  diferencaPorVenda: l.diferencaPorVenda,
  prazoParaAderir: paraIso(l.prazoParaAderir),
});

/**
 * Propostas abertas do anuncio, da melhor (maior "voce recebe") para a pior, SEM as `semEfeito`.
 * Vem do cache atual (`getPromocoes().itens`), que ja tem `voceRecebe`. So sem cache cai para as
 * propostas guardadas na foto, na ordem em que foram gravadas.
 */
export function propostasDoAnuncio(itemId: string, foto: FotoPromocao, itens: LinhaPromocao[] | null): Substituta[] {
  if (!itens) {
    return foto.propostas.map((p) => ({
      tipo: p.tipo,
      promocaoId: p.promocaoId,
      nome: p.nome,
      precoProposto: p.precoProposto,
      mlPercentual: p.mlPercentual ?? null,
      voceRecebe: p.voceRecebe ?? null,
      diferencaPorVenda: p.diferencaPorVenda ?? null,
      prazoParaAderir: p.prazoParaAderir,
    }));
  }
  return itens
    .filter((l) => l.itemId === itemId && l.situacao === 'proposta' && !l.semEfeito)
    .map(paraSubstituta)
    .sort((a, b) => (b.voceRecebe ?? -Infinity) - (a.voceRecebe ?? -Infinity));
}

// ---------------------------------------------------------------- grupos

export type RotuloDoTipo = (tipo: string) => string;

export interface GrupoVencendo {
  chave: string;
  promocaoId: string | null;
  tipo: string;
  /** o mesmo nome do tipo que a aba Promocoes mostra (ROTULO_DO_TIPO) */
  rotuloTipo: string;
  nome: string | null;
  /** o fim mais cedo do grupo (o dia e o mesmo para todos) */
  fim: string;
  diasRestantes: number;
  prazo: string;
  total: number;
  cobertos: number;
  todosCobertos: boolean;
  /** nao cobertos primeiro, os cobertos no fim */
  anuncios: Ocorrencia[];
}

const chaveDaPromocaoDe = (o: Pick<Ocorrencia, 'promocaoId' | 'promocao'>): string =>
  o.promocaoId ?? `${o.promocao?.tipo ?? ''}|${o.promocao?.nome ?? ''}`;

/** Agrupa os "termina em breve" por promocao (id, ou tipo+nome sem id) + dia do fim em Brasilia. */
export function agruparVencendo(ocorrencias: Ocorrencia[], rotuloDoTipo: RotuloDoTipo): GrupoVencendo[] {
  const m = new Map<string, Ocorrencia[]>();
  for (const o of ocorrencias) {
    const k = `${chaveDaPromocaoDe(o)}|${diaBrasilia(Date.parse(o.fim!))}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(o);
  }
  const grupos: GrupoVencendo[] = [...m.entries()].map(([chave, lista]) => {
    const anuncios = [...lista].sort(
      (a, b) => Number(a.coberta) - Number(b.coberta) || (a.titulo ?? a.itemId).localeCompare(b.titulo ?? b.itemId),
    );
    const fim = lista.map((o) => o.fim!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const dias = Math.min(...lista.map((o) => o.diasRestantes!));
    const cobertos = lista.filter((o) => o.coberta).length;
    const p = lista[0].promocao!;
    return {
      chave,
      promocaoId: lista[0].promocaoId,
      tipo: p.tipo,
      rotuloTipo: rotuloDoTipo(p.tipo),
      nome: p.nome,
      fim,
      diasRestantes: dias,
      prazo: rotuloDoPrazo(dias),
      total: lista.length,
      cobertos,
      todosCobertos: cobertos === lista.length,
      anuncios,
    };
  });
  // Grupos com todos cobertos vao para o fim; o resto, por fim mais proximo.
  return grupos.sort(
    (a, b) => Number(a.todosCobertos) - Number(b.todosCobertos) || Date.parse(a.fim) - Date.parse(b.fim) || (a.nome ?? '').localeCompare(b.nome ?? ''),
  );
}

export interface GrupoSemData {
  chave: string;
  promocaoId: string | null;
  tipo: string;
  rotuloTipo: string;
  nome: string | null;
  total: number;
  anuncios: Array<{ itemId: string; titulo: string | null; permalink: string | null }>;
}

/** "Sem data de fim" agrupado por promocao (consulta, nao alerta). */
export function agruparSemData(ocorrencias: Ocorrencia[], rotuloDoTipo: RotuloDoTipo): GrupoSemData[] {
  const m = new Map<string, Ocorrencia[]>();
  for (const o of ocorrencias) {
    const k = chaveDaPromocaoDe(o);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(o);
  }
  return [...m.entries()]
    .map(([chave, lista]) => {
      const p = lista[0].promocao!;
      return {
        chave,
        promocaoId: lista[0].promocaoId,
        tipo: p.tipo,
        rotuloTipo: rotuloDoTipo(p.tipo),
        nome: p.nome,
        total: lista.length,
        anuncios: lista
          .map((o) => ({ itemId: o.itemId, titulo: o.titulo, permalink: o.permalink }))
          .sort((a, b) => (a.titulo ?? a.itemId).localeCompare(b.titulo ?? b.itemId)),
      };
    })
    .sort((a, b) => b.total - a.total || (a.nome ?? '').localeCompare(b.nome ?? ''));
}

// ---------------------------------------------------------------- prazo para aderir

export interface PrazoAderir {
  itemId: string;
  titulo: string | null;
  permalink: string | null;
  promocao: { tipo: string; rotulo: string; nome: string | null; promocaoId: string | null };
  prazoParaAderir: string;
  diasRestantes: number;
  /** "fecha hoje" / "falta 1 dia" / "faltam N dias" */
  prazo: string;
  precoProposto: number | null;
  mlPercentual: number | null;
  voceRecebe: number | null;
  diferencaPorVenda: number | null;
}

const idDaPromocao = (l: Pick<LinhaPromocao, 'tipo' | 'promocaoId' | 'ofertaId'>): string => `${l.tipo}|${l.promocaoId ?? l.ofertaId ?? ''}`;

/**
 * PRAZO_ADERIR_ACABANDO: proposta ABERTA cujo prazo para aderir acaba em ate `diasAviso` dias (e ainda
 * nao passou), so as interessantes (ML banca parte, ou "vs. hoje" >= 0), nunca `semEfeito`, e fora se
 * o anuncio ja participa DESSA promocao (ativa ou programada). Sem prazo informado nao entra, nem
 * anuncio pausado/finalizado.
 * Uma linha por anuncio + proposta, ordenada pelo prazo. Vem do cache atual: funciona desde o deploy.
 */
export function prazosParaAderir(
  itens: LinhaPromocao[],
  agora: number,
  diasAviso: number,
  /** status das fotos, para cache de versao anterior que ainda nao traz `statusAnuncio` */
  statusPorItem: Map<string, string | null> = new Map(),
): PrazoAderir[] {
  const participa = new Set<string>();
  for (const l of itens) if (l.situacao === 'ativa' || l.situacao === 'programada') participa.add(`${l.itemId}#${idDaPromocao(l)}`);
  const out: PrazoAderir[] = [];
  for (const l of itens) {
    if (l.situacao !== 'proposta' || l.semEfeito) continue;
    // Pausado ou finalizado nao entra (mesma regra do "ficou sem promocao"); sem status, avalia.
    const status = l.statusAnuncio ?? statusPorItem.get(l.itemId) ?? null;
    if (status && status !== 'active') continue;
    const prazoIso = paraIso(l.prazoParaAderir);
    if (!prazoIso) continue;
    const prazoMs = Date.parse(prazoIso);
    if (prazoMs <= agora) continue;
    const dias = diasAte(prazoMs, agora);
    if (dias > diasAviso) continue;
    const interessante = (l.mlPercentual ?? 0) > 0 || (l.diferencaPorVenda != null && l.diferencaPorVenda >= 0);
    if (!interessante) continue;
    if (participa.has(`${l.itemId}#${idDaPromocao(l)}`)) continue;
    out.push({
      itemId: l.itemId,
      titulo: l.titulo,
      permalink: l.permalink,
      promocao: { tipo: l.tipo, rotulo: l.rotulo, nome: l.nome, promocaoId: l.promocaoId },
      prazoParaAderir: prazoIso,
      diasRestantes: dias,
      prazo: dias <= 0 ? 'fecha hoje' : rotuloDoPrazo(dias),
      precoProposto: l.precoProposto,
      mlPercentual: l.mlPercentual,
      voceRecebe: l.voceRecebe,
      diferencaPorVenda: l.diferencaPorVenda,
    });
  }
  return out.sort((a, b) => Date.parse(a.prazoParaAderir) - Date.parse(b.prazoParaAderir) || (b.diferencaPorVenda ?? -Infinity) - (a.diferencaPorVenda ?? -Infinity));
}

// ---------------------------------------------------------------- lista final e texto

export interface Acompanhamento {
  atualizadoEm: string | null;
  diasAviso: number;
  // v46 (mantidos)
  terminaEmBreve: Ocorrencia[];
  ficouSemPromocao: Ocorrencia[];
  semDataDeFim: Ocorrencia[];
  /** false = banco fora do ar: so as secoes que dependem dele ficam vazias */
  historicoDisponivel: boolean;
  // v47
  /** "prazo para aderir" vem do cache de promocoes, nao do banco: false so quando nao ha cache usavel */
  prazoDisponivel: boolean;
  grupos: GrupoVencendo[];
  prazoAderir: PrazoAderir[];
  semDataPorPromocao: GrupoSemData[];
}

export interface ContextoDoAcompanhamento {
  /** linhas do cache atual (getPromocoes().itens), ou null se ainda nao houve varredura */
  itens: LinhaPromocao[] | null;
  rotuloDoTipo?: RotuloDoTipo;
}

export function acompanhamentoVazio(diasAviso: number, historicoDisponivel: boolean): Acompanhamento {
  return {
    atualizadoEm: null,
    diasAviso,
    terminaEmBreve: [],
    ficouSemPromocao: [],
    semDataDeFim: [],
    historicoDisponivel,
    prazoDisponivel: false,
    grupos: [],
    prazoAderir: [],
    semDataPorPromocao: [],
  };
}

export function montarAcompanhamento(
  atuais: FotoPromocao[],
  historicoPorItem: Map<string, FotoPromocao[]>,
  agora: number,
  opts: OpcoesDoAcompanhamento,
  ctx: ContextoDoAcompanhamento = { itens: null },
): Acompanhamento {
  const rotulo = ctx.rotuloDoTipo ?? ((t: string) => t);
  const termina: Ocorrencia[] = [];
  const sem: Ocorrencia[] = [];
  const semData: Ocorrencia[] = [];
  for (const f of atuais) {
    const o = acompanharPromocoes(f, historicoPorItem.get(f.itemId) ?? [], agora, opts);
    if (!o) continue;
    const props = propostasDoAnuncio(f.itemId, f, ctx.itens);
    o.substituta = props[0] ?? null;
    o.outras = props.slice(1);
    o.propostasAbertas = props.length;
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
    prazoDisponivel: !!ctx.itens,
    grupos: agruparVencendo(termina, rotulo),
    prazoAderir: ctx.itens
      ? prazosParaAderir(ctx.itens, agora, opts.diasAviso, new Map(atuais.map((f) => [f.itemId, f.statusAnuncio] as const)))
      : [],
    semDataPorPromocao: agruparSemData(semData, rotulo),
  };
}

const brl = (v: number): string => `${v < 0 ? '-' : '+'}R$ ${Math.abs(v).toFixed(2).replace('.', ',')}`;
const curto = (o: { titulo: string | null; itemId: string }, n = 50): string => `${o.itemId} ${(o.titulo ?? '').slice(0, n)}`.trim();
function linhasDoGrupo(g: GrupoVencendo): string {
  const quando = g.diasRestantes <= 0 ? 'termina hoje' : `termina ${diaSemanaData(g.fim)}`;
  const cob = g.cobertos ? `, ${g.cobertos} já ${g.cobertos > 1 ? 'cobertos' : 'coberto'}` : '';
  return `• ${g.nome ?? g.tipo} (${g.rotuloTipo}) ${quando}: ${g.total} anúncio${g.total > 1 ? 's' : ''}${cob}`;
}

const linhaSemPromo = (o: Ocorrencia): string => `• ${curto(o)} — desde ${(dataHoraBrasilia(o.desde) || '').slice(0, 5)}`;

function linhaPrazo(p: PrazoAderir): string {
  const quando = p.diasRestantes <= 0 ? 'fecha hoje' : `fecha ${diaSemanaData(p.prazoParaAderir)}`;
  const ganho = p.diferencaPorVenda != null ? ` · você recebe ${brl(p.diferencaPorVenda)}` : '';
  return `• ${p.promocao.nome ?? p.promocao.rotulo} · ${curto(p)} — ${quando}${ganho}`;
}

/**
 * Texto pronto para o Telegram, agrupado. Titulos das secoes sao daqui; o Gerente so acrescenta o da
 * secao de promocoes novas. Fica de fora: grupos 100% cobertos (so painel) e SEM_DATA_DE_FIM (so
 * painel: sem data nao ha prazo para avisar). `limite` vale POR SECAO. null quando nao ha nada.
 */
export function resumoEmTexto(a: Acompanhamento, limite: number): string | null {
  const secao = <T>(titulo: string, lista: T[], fmt: (x: T) => string): string | null => {
    if (!lista.length) return null;
    const mostradas = lista.slice(0, limite).map(fmt);
    const resto = lista.length - mostradas.length;
    return `${titulo}\n${mostradas.join('\n')}${resto > 0 ? `\n… e mais ${resto}` : ''}`;
  };
  const partes = [
    secao('⏳ Vencendo', a.grupos.filter((g) => !g.todosCobertos), linhasDoGrupo),
    secao('🚫 Ficou sem promoção', a.ficouSemPromocao, linhaSemPromo),
    secao('📅 Prazo para aderir acabando', a.prazoAderir, linhaPrazo),
  ].filter((p): p is string => !!p);
  return partes.length ? partes.join('\n\n') : null;
}
