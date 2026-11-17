import fs from 'node:fs';
import { config } from '../config';
import { logger } from '../logger';
import {
  buscarProdutoDetalhe,
  extrairComponentesDoKit,
  lerEstoque,
  listarProdutos,
  TinyApiError,
  type EstoqueTiny,
  type ProdutoNormalizado,
} from '../tiny/tinyClient';
import { chaveSku } from './custos';
import { buscarImpostosDoBackup } from './diagnosticoCustos';

/**
 * PLANEJAMENTO DE COMPRAS (v51): o que pedir na proxima importacao, quanto e ate quando.
 *
 * A aba Reposicao olha cada anuncio do ML sozinho, com as vendas do ML e um prazo curto. A MCS importa
 * da China e vende o mesmo estoque no ML, na Shopee e no TikTok, entao a pergunta certa e por PRODUTO
 * (SKU), somando todos os canais, com o prazo real de uma importacao.
 *
 * De onde vem cada numero:
 *  - vendas por produto e por mes: notas fiscais de saida guardadas no backup (todas as lojas, porque
 *    toda venda vira nota). Kit vendido vira venda dos componentes, pela estrutura do kit no Tiny;
 *  - estoque: Tiny (`/estoque/{id}`), o mesmo que abastece todas as lojas;
 *  - custo: preco de custo do Tiny (ja com nacionalizacao);
 *  - ultima importacao: nota de entrada de importacao no backup.
 *
 * So leitura: nao escreve no Tiny, no ML nem no backup.
 */

// ---------- dados coletados ----------

export interface MesColetado {
  mes: string;
  /** Dias do mes que entram na conta (o mes corrente conta ate ontem). */
  dias: number;
  notasLidas: number;
}

export interface ProdutoColetado {
  descricao: string;
  custo: number | null;
  tipo: string | null;
}

export interface DadosCompras {
  coletadoEm: string;
  /** Data (AAAA-MM-DD, Brasilia) usada como "hoje" na coleta. */
  hoje: string;
  meses: MesColetado[];
  /** Vendas por SKU (chave normalizada) e por mes, como estao nas notas (kit ainda e kit). */
  vendas: Record<string, { descricao: string; porMes: Record<string, number> }>;
  /** Estrutura dos kits vendidos: kit -> componentes. Kit sem estrutura lida fica com lista vazia. */
  kits: Record<string, Array<{ sku: string; quantidade: number }>>;
  produtos: Record<string, ProdutoColetado>;
  /** Estoque por SKU. Ausente = nao lido. */
  estoques: Record<string, EstoqueTiny>;
  estoque: { lidos: number; semNumero: number; erros: number; parouPor: string | null };
  importacoes: Record<string, { ultimaEntrada: string; custoPorUnidade: number | null; quantidade: number }>;
  avisos: string[];
}

// ---------- plano (calculo puro) ----------

export type Situacao = 'em_falta' | 'pedir_ja' | 'pedir_em_breve' | 'ok' | 'excesso' | 'parado' | 'sem_estoque_lido';

export interface ParametrosPlano {
  /** Dias entre fazer o pedido na China e a mercadoria estar disponivel para vender. */
  prazoDias: number;
  /** Quantos dias de venda cada pedido deve cobrir depois que chega. */
  coberturaDias: number;
  /** Folga para atraso de navio, alfandega ou pico de venda. */
  segurancaDias: number;
  /** Acima de quantos dias de estoque o produto conta como excesso. */
  excessoDias: number;
}

export interface LinhaPlano {
  sku: string;
  descricao: string;
  situacao: Situacao;
  /** Unidades vendidas por mes, na ordem de `meses` (inclui o que veio via kit). */
  vendasPorMes: number[];
  /** Parte das vendas que veio de kits. */
  viaKit: number;
  vendasPorMesMedia: number;
  tendencia: 'subindo' | 'caindo' | 'estavel' | null;
  estoque: number | null;
  /** Dias que o estoque dura no ritmo atual. null = sem venda ou sem estoque lido. */
  diasDeEstoque: number | null;
  /** Data em que deve acabar no ritmo atual. */
  acabaEm: string | null;
  /** Ultimo dia para fazer o pedido sem faltar (prazo + seguranca). */
  pedirAte: string | null;
  quantidadeSugerida: number;
  custoUnitario: number | null;
  investimento: number | null;
  /** Valor do estoque parado ou em excesso (custo x unidades acima de `excessoDias`). */
  valorParado: number | null;
  ultimaImportacao: string | null;
}

export interface PlanoCompras {
  atualizadoEm: string;
  hoje: string;
  parametros: ParametrosPlano;
  meses: MesColetado[];
  diasAnalisados: number;
  resumo: {
    porSituacao: Record<Situacao, number>;
    investimentoSugerido: number;
    produtosSemCustoNaCompra: number;
    valorEmEstoque: number;
    valorParado: number;
  };
  linhas: LinhaPlano[];
  estoque: DadosCompras['estoque'];
  avisos: string[];
}

const ORDEM: Situacao[] = ['em_falta', 'pedir_ja', 'pedir_em_breve', 'sem_estoque_lido', 'excesso', 'parado', 'ok'];
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T12:00:00Z`) + Math.round(n) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Mes atual e os N anteriores (AAAA-MM), do mais antigo para o mais novo, com os dias que contam. */
export function mesesDaJanela(hoje: string, mesesCompletos: number): Array<{ mes: string; dias: number }> {
  let a = Number(hoje.slice(0, 4));
  let m = Number(hoje.slice(5, 7));
  const diaHoje = Number(hoje.slice(8, 10));
  const out: Array<{ mes: string; dias: number }> = [];
  // mes corrente: conta ate ontem (o backup coleta as notas de madrugada)
  if (diaHoje > 1) out.push({ mes: `${a}-${String(m).padStart(2, '0')}`, dias: diaHoje - 1 });
  for (let i = 0; i < mesesCompletos; i++) {
    m--;
    if (m < 1) { m = 12; a--; }
    const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
    out.push({ mes: `${a}-${String(m).padStart(2, '0')}`, dias });
  }
  return out.reverse();
}

export function montarPlano(dados: DadosCompras, p: ParametrosPlano, agora = new Date()): PlanoCompras {
  const meses = dados.meses;
  const idx = new Map(meses.map((m, i) => [m.mes, i]));
  const diasTotal = meses.reduce((a, m) => a + m.dias, 0);

  // vendas explodidas: kit vira componentes
  const porSku = new Map<string, { descricao: string; porMes: number[]; viaKit: number }>();
  const pegar = (k: string, descricao: string) => {
    let v = porSku.get(k);
    if (!v) { v = { descricao, porMes: meses.map(() => 0), viaKit: 0 }; porSku.set(k, v); }
    if (!v.descricao && descricao) v.descricao = descricao;
    return v;
  };
  const kitsSemEstrutura: string[] = [];
  for (const [k, venda] of Object.entries(dados.vendas)) {
    const comps = dados.kits[k];
    if (comps && comps.length) {
      for (const c of comps) {
        const ck = chaveSku(c.sku);
        if (!ck) continue;
        const v = pegar(ck, dados.produtos[ck]?.descricao || '');
        for (const [mes, q] of Object.entries(venda.porMes)) {
          const i = idx.get(mes);
          if (i == null) continue;
          v.porMes[i] += q * c.quantidade;
          v.viaKit += q * c.quantidade;
        }
      }
      continue;
    }
    if (comps && !comps.length) kitsSemEstrutura.push(k);
    const v = pegar(k, venda.descricao || dados.produtos[k]?.descricao || '');
    for (const [mes, q] of Object.entries(venda.porMes)) {
      const i = idx.get(mes);
      if (i != null) v.porMes[i] += q;
    }
  }
  // produtos com estoque e sem venda tambem entram (dinheiro parado)
  for (const [k, e] of Object.entries(dados.estoques)) {
    if (e.saldo > 0 && !porSku.has(k) && dados.produtos[k]?.tipo !== 'K') pegar(k, dados.produtos[k]?.descricao || '');
  }

  const linhas: LinhaPlano[] = [];
  for (const [sku, v] of porSku) {
    const total = v.porMes.reduce((a, b) => a + b, 0);
    const porDia = diasTotal > 0 ? total / diasTotal : 0;
    const est = dados.estoques[sku];
    const estoque = est ? est.disponivel : null;
    const custo = dados.produtos[sku]?.custo ?? null;
    if (total <= 0 && (estoque == null || estoque <= 0)) continue;

    const dias = estoque != null && porDia > 0 ? Math.max(0, estoque) / porDia : null;
    let situacao: Situacao;
    if (estoque == null) situacao = 'sem_estoque_lido';
    else if (porDia <= 0) situacao = 'parado';
    else if (estoque <= 0) situacao = 'em_falta';
    else if (dias! < p.prazoDias) situacao = 'pedir_ja';
    else if (dias! < p.prazoDias + p.segurancaDias) situacao = 'pedir_em_breve';
    else if (dias! > p.excessoDias) situacao = 'excesso';
    else situacao = 'ok';

    const precisaPedir = situacao === 'em_falta' || situacao === 'pedir_ja' || situacao === 'pedir_em_breve';
    const alvo = porDia * (p.prazoDias + p.segurancaDias + p.coberturaDias);
    const qtd = precisaPedir ? Math.max(0, Math.ceil(alvo - Math.max(0, estoque ?? 0))) : 0;

    let valorParado: number | null = null;
    if (custo != null && estoque != null && estoque > 0) {
      if (situacao === 'parado') valorParado = r2(estoque * custo);
      else if (situacao === 'excesso') valorParado = r2((estoque - porDia * p.excessoDias) * custo);
    }

    // tendencia: ultimo mes completo contra a media dos dois anteriores
    let tendencia: LinhaPlano['tendencia'] = null;
    const completos = meses.map((m, i) => ({ m, q: v.porMes[i]! })).filter((x) => x.m.dias >= 28);
    if (completos.length >= 3) {
      const ult = completos[completos.length - 1]!.q;
      const ant = (completos[completos.length - 2]!.q + completos[completos.length - 3]!.q) / 2;
      if (ant >= 3 || ult >= 3) tendencia = ult > ant * 1.3 ? 'subindo' : ult < ant * 0.7 ? 'caindo' : 'estavel';
    }

    linhas.push({
      sku,
      descricao: v.descricao,
      situacao,
      vendasPorMes: v.porMes.map(r1),
      viaKit: r1(v.viaKit),
      vendasPorMesMedia: r1(porDia * 30),
      tendencia,
      estoque,
      diasDeEstoque: dias != null ? Math.round(dias) : null,
      acabaEm: dias != null ? somarDias(dados.hoje, dias) : null,
      pedirAte: dias != null ? somarDias(dados.hoje, Math.max(0, dias - p.prazoDias - p.segurancaDias)) : null,
      quantidadeSugerida: qtd,
      custoUnitario: custo,
      investimento: custo != null ? r2(qtd * custo) : null,
      valorParado,
      ultimaImportacao: dados.importacoes[sku]?.ultimaEntrada ?? null,
    });
  }

  linhas.sort((a, b) => {
    const s = ORDEM.indexOf(a.situacao) - ORDEM.indexOf(b.situacao);
    if (s) return s;
    if (a.situacao === 'excesso' || a.situacao === 'parado') return (b.valorParado ?? 0) - (a.valorParado ?? 0);
    return (a.diasDeEstoque ?? 0) - (b.diasDeEstoque ?? 0) || b.vendasPorMesMedia - a.vendasPorMesMedia;
  });

  const porSituacao = Object.fromEntries(ORDEM.map((s) => [s, 0])) as Record<Situacao, number>;
  let investimento = 0, semCusto = 0, valorEstoque = 0, valorParado = 0;
  for (const l of linhas) {
    porSituacao[l.situacao]++;
    if (l.quantidadeSugerida > 0) { if (l.investimento != null) investimento += l.investimento; else semCusto++; }
    if (l.estoque != null && l.estoque > 0 && l.custoUnitario != null) valorEstoque += l.estoque * l.custoUnitario;
    valorParado += l.valorParado ?? 0;
  }

  const avisos = [...dados.avisos];
  if (kitsSemEstrutura.length) avisos.push(`${kitsSemEstrutura.length} kit(s) vendido(s) sem a lista de componentes lida no Tiny; contam como produto próprio: ${kitsSemEstrutura.slice(0, 5).join(', ')}${kitsSemEstrutura.length > 5 ? '…' : ''}.`);
  const pouca = meses.filter((m) => m.dias >= 28 && m.notasLidas === 0).map((m) => m.mes);
  if (pouca.length) avisos.push(`Sem notas de venda no backup em ${pouca.join(', ')}: as vendas desses meses saem zeradas e o ritmo fica baixo.`);

  return {
    atualizadoEm: agora.toISOString(),
    hoje: dados.hoje,
    parametros: p,
    meses,
    diasAnalisados: diasTotal,
    resumo: { porSituacao, investimentoSugerido: r2(investimento), produtosSemCustoNaCompra: semCusto, valorEmEstoque: r2(valorEstoque), valorParado: r2(valorParado) },
    linhas,
    estoque: dados.estoque,
    avisos,
  };
}

// ---------- coleta (Tiny + backup) ----------

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hojeEmBrasilia(agora = new Date()): string {
  return new Date(agora.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

export interface EstadoColeta {
  rodando: boolean;
  etapa: string | null;
  iniciadaEm: string | null;
  erro: string | null;
}

let dadosCache: DadosCompras | null = null;
const estado: EstadoColeta = { rodando: false, etapa: null, iniciadaEm: null, erro: null };

function carregar(): DadosCompras | null {
  if (dadosCache) return dadosCache;
  try {
    if (fs.existsSync(config.comprasCachePath)) dadosCache = JSON.parse(fs.readFileSync(config.comprasCachePath, 'utf-8'));
  } catch {
    dadosCache = null;
  }
  return dadosCache;
}

function salvar(d: DadosCompras): void {
  dadosCache = d;
  try {
    if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = config.comprasCachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf-8');
    fs.renameSync(tmp, config.comprasCachePath);
  } catch (err: any) {
    logger.warn('[COMPRAS] Falha ao gravar o cache:', err?.message || err);
  }
}

async function coletar(): Promise<DadosCompras> {
  const hoje = hojeEmBrasilia();
  const avisos: string[] = [];

  estado.etapa = 'lendo o catálogo do Tiny';
  const lista = await listarProdutos(config.comprasMaxProdutos);
  const produtos: Record<string, ProdutoColetado> = {};
  const porChave = new Map<string, ProdutoNormalizado>();
  for (const p of lista) {
    const k = chaveSku(p.sku);
    if (!k || porChave.has(k)) continue;
    porChave.set(k, p);
    produtos[k] = { descricao: p.descricao || '', custo: p.custo, tipo: p.tipo ?? null };
  }

  // vendas mes a mes, pelo backup
  estado.etapa = 'lendo as notas de venda no backup';
  const janela = mesesDaJanela(hoje, config.comprasMesesCompletos);
  const meses: MesColetado[] = [];
  const vendas: DadosCompras['vendas'] = {};
  let calculando = false;
  for (const { mes, dias } of janela) {
    const r = await buscarImpostosDoBackup({ de: mes, ate: mes });
    if (!r.disponivel) {
      if (r.calculando) calculando = true;
      else throw new Error(`Backup: ${r.motivo}`);
      meses.push({ mes, dias, notasLidas: 0 });
      continue;
    }
    meses.push({ mes, dias, notasLidas: r.dados.notasLidas });
    for (const v of r.dados.vendas.porSku) {
      const k = chaveSku(v.sku);
      if (!k) continue;
      const s = (vendas[k] ??= { descricao: v.descricao, porMes: {} });
      s.porMes[mes] = (s.porMes[mes] ?? 0) + v.quantidade;
    }
  }
  if (calculando) avisos.push('O backup ainda estava somando as notas de algum mês; esses meses saem zerados. Tente "Refazer agora" em alguns minutos.');

  // ultima importacao: 12 meses
  const importacoes: DadosCompras['importacoes'] = {};
  const umAno = mesesDaJanela(hoje, 11);
  const imp = await buscarImpostosDoBackup({ de: umAno[0]!.mes, ate: umAno[umAno.length - 1]!.mes });
  if (imp.disponivel) {
    for (const i of imp.dados.importacoes.porSku) {
      const k = chaveSku(i.sku);
      if (k) importacoes[k] = { ultimaEntrada: i.ultimaEntrada, custoPorUnidade: i.custoPorUnidade, quantidade: i.quantidade };
    }
  } else avisos.push(`Última importação indisponível: ${imp.motivo}`);

  // estrutura dos kits vendidos
  estado.etapa = 'lendo a estrutura dos kits';
  const kits: DadosCompras['kits'] = {};
  for (const k of Object.keys(vendas)) {
    const p = porChave.get(k);
    if (!p || p.tipo !== 'K' || !p.id) continue;
    try {
      kits[k] = extrairComponentesDoKit(await buscarProdutoDetalhe(p.id));
    } catch {
      kits[k] = [];
    }
    await pausa(config.comprasPausaTinyMs);
  }

  // estoque: primeiro quem vendeu, depois o resto do catalogo ativo (para achar dinheiro parado)
  const componentes = new Set(Object.values(kits).flat().map((c) => chaveSku(c.sku)).filter(Boolean) as string[]);
  const prioridade = (k: string) => (vendas[k] || componentes.has(k) ? 0 : 1);
  const alvos = [...porChave.entries()]
    .filter(([, p]) => p.id && p.tipo !== 'K' && (p.situacao == null || p.situacao === 'A'))
    .sort((a, b) => prioridade(a[0]) - prioridade(b[0]))
    .slice(0, config.comprasMaxEstoques);
  const estoques: DadosCompras['estoques'] = {};
  const est = { lidos: 0, semNumero: 0, erros: 0, parouPor: null as string | null };
  let errosSeguidos = 0;
  for (let i = 0; i < alvos.length; i++) {
    const [k, p] = alvos[i]!;
    estado.etapa = `lendo o estoque no Tiny (${i + 1} de ${alvos.length})`;
    try {
      const e = await lerEstoque(p.id!);
      if (e) { estoques[k] = e; est.lidos++; } else est.semNumero++;
      errosSeguidos = 0;
    } catch (err: any) {
      est.erros++;
      errosSeguidos++;
      const status = err instanceof TinyApiError ? err.status : 0;
      if (status === 401 || status === 403) { est.parouPor = `o Tiny recusou a leitura de estoque (${status}). Confira se o aplicativo do analytics no Tiny tem permissão de leitura de Estoque e refaça o login em /oauth/tiny/login.`; break; }
      if (status === 429) await pausa(30_000);
      if (errosSeguidos >= 10) { est.parouPor = `10 erros seguidos lendo estoque (último: ${err?.message || err}).`; break; }
    }
    await pausa(config.comprasPausaTinyMs);
  }
  if (est.parouPor) avisos.push(`Estoque incompleto: ${est.parouPor}`);

  return { coletadoEm: new Date().toISOString(), hoje, meses, vendas, kits, produtos, estoques, estoque: est, importacoes, avisos };
}

/** Inicia a coleta em segundo plano (se nao estiver rodando). */
export function iniciarColeta(): void {
  if (estado.rodando) return;
  estado.rodando = true;
  estado.iniciadaEm = new Date().toISOString();
  estado.erro = null;
  coletar()
    .then((d) => { salvar(d); logger.info(`[COMPRAS] coleta pronta: ${Object.keys(d.vendas).length} produto(s) com venda, ${d.estoque.lidos} estoque(s) lido(s).`); })
    .catch((err: any) => { estado.erro = err?.message || String(err); logger.warn('[COMPRAS] coleta falhou:', estado.erro); })
    .finally(() => { estado.rodando = false; estado.etapa = null; });
}

function vencido(d: DadosCompras | null): boolean {
  if (!d) return true;
  const h = (Date.now() - new Date(d.coletadoEm).getTime()) / 3_600_000;
  return !Number.isFinite(h) || h >= config.comprasValidadeHoras;
}

export function parametrosPadrao(): ParametrosPlano {
  return {
    prazoDias: config.comprasPrazoDias,
    coberturaDias: config.comprasCoberturaDias,
    segurancaDias: config.comprasSegurancaDias,
    excessoDias: config.comprasExcessoDias,
  };
}

/** Le parametros de uma query, caindo no padrao quando faltam ou sao invalidos. */
export function parametrosDaQuery(q: Record<string, unknown>): ParametrosPlano {
  const pad = parametrosPadrao();
  const n = (v: unknown, d: number, max: number) => {
    const x = Number(v);
    return v != null && v !== '' && Number.isFinite(x) && x >= 0 && x <= max ? Math.round(x) : d;
  };
  return {
    prazoDias: n(q.prazo, pad.prazoDias, 365),
    coberturaDias: n(q.cobertura, pad.coberturaDias, 730),
    segurancaDias: n(q.seguranca, pad.segurancaDias, 180),
    excessoDias: n(q.excesso, pad.excessoDias, 1460),
  };
}

export type RespostaCompras =
  | { pronto: true; plano: PlanoCompras; coleta: EstadoColeta }
  | { pronto: false; coleta: EstadoColeta; mensagem: string };

/** Serve o plano com os dados em cache; dispara nova coleta quando venceu ou quando pedido. */
export function obterPlano(p: ParametrosPlano, forcar = false): RespostaCompras {
  const d = carregar();
  if (forcar || vencido(d)) iniciarColeta();
  if (!d) {
    return {
      pronto: false,
      coleta: { ...estado },
      mensagem: estado.erro
        ? `A coleta falhou: ${estado.erro}`
        : `Montando pela primeira vez (${estado.etapa ?? 'iniciando'}). Ler o estoque de cada produto no Tiny leva alguns minutos.`,
    };
  }
  return { pronto: true, plano: montarPlano(d, p), coleta: { ...estado } };
}

/** Coleta diaria em segundo plano. */
export function startComprasLoop(): void {
  if (!config.backupBaseUrl || !config.backupApiKey) {
    logger.info('[COMPRAS] BACKUP_BASE_URL/BACKUP_API_KEY vazios: o planejamento de compras fica desligado ate configurar.');
    return;
  }
  setTimeout(() => { if (vencido(carregar())) iniciarColeta(); }, 5 * 60_000).unref?.();
  setInterval(() => { if (vencido(carregar())) iniciarColeta(); }, 60 * 60_000).unref?.();
}
