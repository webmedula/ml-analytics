import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/**
 * SERIE DIARIA POR ANUNCIO.
 *
 * O painel sempre foi um retrato: consultava o ML, mostrava, e jogava fora. Isso torna
 * IMPOSSIVEL responder "esta subindo ou caindo?" e "aquela promocao funcionou?" — porque o
 * Mercado Livre nao guarda o seu preco de tres meses atras nem a sua venda por dia. Se ninguem
 * gravou, o dado nao existe em lugar nenhum.
 *
 * Aqui gravamos um registro por anuncio por dia. Um arquivo por dia (data/history/AAAA-MM-DD.json):
 * regravar o dia de hoje e so sobrescrever o arquivo, e podar o passado e so apagar arquivos.
 */

export interface SnapshotDiario {
  data: string; // AAAA-MM-DD
  itemId: string;
  titulo?: string;
  preco: number | null;
  estoque: number | null;
  visitas: number;
  /** unidades vendidas ACUMULADAS na janela de 30 dias no momento do snapshot */
  unidades30: number;
  liquido30: number;
  /** situacao no Buy Box quando conhecida ('ganhando' | 'perdendo' | 'empatado') */
  buyBox?: string | null;
  /** o anuncio estava em alguma promocao naquele dia? null = nao sabemos */
  emPromocao?: boolean | null;
}

export function hojeISO(agora = new Date()): string {
  return agora.toISOString().slice(0, 10);
}

function dirHistorico(): string {
  return config.historyDir;
}

function arquivoDoDia(data: string): string {
  return path.join(dirHistorico(), `${data}.json`);
}

function garantirDir(): void {
  if (!fs.existsSync(dirHistorico())) fs.mkdirSync(dirHistorico(), { recursive: true });
}

/** Grava (ou regrava) o dia inteiro de uma vez. Rodar duas vezes no mesmo dia nao duplica. */
export function gravarDia(snapshots: SnapshotDiario[], data = hojeISO()): void {
  if (snapshots.length === 0) return;
  garantirDir();
  const tmp = arquivoDoDia(data) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshots), 'utf-8');
  fs.renameSync(tmp, arquivoDoDia(data));
  logger.info(`[HISTORICO] ${snapshots.length} anuncios gravados em ${data}.`);
}

/** Lista as datas disponiveis, mais recentes primeiro. */
export function datasDisponiveis(): string[] {
  try {
    if (!fs.existsSync(dirHistorico())) return [];
    return fs
      .readdirSync(dirHistorico())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function lerDia(data: string): SnapshotDiario[] {
  try {
    const p = arquivoDoDia(data);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

/** Serie de um anuncio nos ultimos `dias`, do mais antigo pro mais novo. */
export function serieDoAnuncio(itemId: string, dias = 30): SnapshotDiario[] {
  const datas = datasDisponiveis().slice(0, dias).reverse();
  const out: SnapshotDiario[] = [];
  for (const d of datas) {
    const registro = lerDia(d).find((s) => s.itemId === itemId);
    if (registro) out.push(registro);
  }
  return out;
}

/** Apaga dias mais antigos que a retencao configurada. */
export function podar(): number {
  const datas = datasDisponiveis();
  const excedentes = datas.slice(config.historyRetencaoDias);
  for (const d of excedentes) {
    try {
      fs.unlinkSync(arquivoDoDia(d));
    } catch {
      // arquivo ja sumiu: tudo bem
    }
  }
  if (excedentes.length) logger.info(`[HISTORICO] ${excedentes.length} dia(s) antigos removidos.`);
  return excedentes.length;
}

// --- funcoes puras de analise (testaveis sem tocar em disco) ---

/** Variacao percentual entre dois valores. null quando nao ha base pra comparar. */
export function variacao(atual: number, anterior: number): number | null {
  if (!Number.isFinite(atual) || !Number.isFinite(anterior)) return null;
  if (anterior === 0) return atual === 0 ? 0 : null; // sair do zero nao e "+infinito%"
  return Math.round(((atual - anterior) / Math.abs(anterior)) * 1000) / 10;
}

/** Distancia em dias entre duas datas AAAA-MM-DD. */
export function diasEntre(de: string, ate: string): number {
  const a = Date.parse(de + 'T00:00:00Z');
  const b = Date.parse(ate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000));
}

/** Acima disso, a diferenca do acumulado de 30 dias deixa de ser interpretavel. */
export const MAX_DIAS_DE_LACUNA = 7;

export interface VendaNoIntervalo {
  data: string;
  unidades: number;
  liquido: number;
  /** Quantos dias esse registro cobre. 1 = dias consecutivos; >1 = houve lacuna na gravacao. */
  diasCobertos: number;
  /** true quando a lacuna foi grande demais pra confiar na diferenca. */
  lacunaLonga: boolean;
  tinhaEstoque: boolean;
  emPromocao: boolean | null;
}

/**
 * Vendas entre snapshots consecutivos.
 *
 * O snapshot guarda o ACUMULADO de 30 dias, entao a venda do periodo e a diferenca entre dois
 * registros. Diferenca negativa (a janela de 30 dias descartou vendas antigas) vira 0 em vez de
 * virar venda negativa.
 *
 * CUIDADO COM LACUNA: se o servico ficar fora do ar e pular dias, a diferenca entre segunda e
 * quarta cobre DOIS dias. Tratar isso como um dia inflaria a venda diaria e, por tabela, a
 * velocidade que decide quanto comprar. Por isso cada registro carrega `diasCobertos`, e quem
 * calcula media divide pelo total de dias — nao pelo numero de registros.
 */
export function vendasPorDia(serie: SnapshotDiario[]): VendaNoIntervalo[] {
  const out: VendaNoIntervalo[] = [];
  for (let i = 1; i < serie.length; i++) {
    const ant = serie[i - 1];
    const at = serie[i];
    const dias = diasEntre(ant.data, at.data);
    out.push({
      data: at.data,
      unidades: Math.max(0, (at.unidades30 ?? 0) - (ant.unidades30 ?? 0)),
      liquido: Math.max(0, Math.round(((at.liquido30 ?? 0) - (ant.liquido30 ?? 0)) * 100) / 100),
      diasCobertos: dias,
      lacunaLonga: dias > MAX_DIAS_DE_LACUNA,
      tinhaEstoque: (at.estoque ?? 0) > 0,
      emPromocao: at.emPromocao ?? null,
    });
  }
  return out;
}

export interface OpcoesVelocidade {
  /** Dias em que o anuncio estava sem estoque nao contam: ele vendeu menos porque nao tinha. */
  ignorarDiasSemEstoque?: boolean;
  /** Dias de promocao inflam a media e enchem o deposito na hora de repor. */
  ignorarDiasEmPromocao?: boolean;
}

export interface Velocidade {
  unidadesPorDia: number;
  diasConsiderados: number;
  diasDescartadosSemEstoque: number;
  diasDescartadosPromocao: number;
  /** dias perdidos porque a gravacao pulou e a diferenca do acumulado ficou ininterpretavel */
  diasDescartadosPorLacuna: number;
  /** false quando sobrou pouco dia util: o numero existe mas nao merece confianca */
  confiavel: boolean;
}

/**
 * Velocidade de venda, corrigindo as duas distorcoes que fazem previsao ingenua errar feio:
 * ruptura (vendeu menos porque nao tinha) e promocao (vendeu mais do que o normal).
 */
export function velocidadeDeVenda(
  dias: Array<{ unidades: number; tinhaEstoque: boolean; emPromocao: boolean | null; diasCobertos?: number; lacunaLonga?: boolean }>,
  opcoes: OpcoesVelocidade = {},
): Velocidade {
  let semEstoque = 0;
  let promo = 0;
  let lacunas = 0;
  let unidades = 0;
  let diasUteis = 0;

  for (const d of dias) {
    const cobertos = d.diasCobertos ?? 1;

    // Lacuna longa: a diferenca do acumulado de 30 dias nao e mais interpretavel. Descarta em vez
    // de espalhar um numero inventado pelos dias que ninguem observou.
    if (d.lacunaLonga) {
      lacunas += cobertos;
      continue;
    }
    if (opcoes.ignorarDiasSemEstoque && !d.tinhaEstoque) {
      semEstoque += cobertos;
      continue;
    }
    if (opcoes.ignorarDiasEmPromocao && d.emPromocao === true) {
      promo += cobertos;
      continue;
    }
    unidades += d.unidades;
    diasUteis += cobertos;
  }

  return {
    // Divide pelos DIAS cobertos, nao pelo numero de registros: dois registros com uma lacuna de
    // tres dias entre eles representam tres dias de venda, nao dois.
    unidadesPorDia: diasUteis > 0 ? Math.round((unidades / diasUteis) * 1000) / 1000 : 0,
    diasConsiderados: diasUteis,
    diasDescartadosSemEstoque: semEstoque,
    diasDescartadosPromocao: promo,
    diasDescartadosPorLacuna: lacunas,
    confiavel: diasUteis >= 7,
  };
}
