import { config } from '../config';
import { logger } from '../logger';
import { listarProdutos, type ProdutoNormalizado } from '../tiny/tinyClient';
import { chaveSku } from './custos';
import type { EstadoDeCusto, LacunaDoAnuncio } from './margem';
import { getMargem, refreshMargem, type ResultadoMargem } from './margemScan';

/**
 * DIAGNOSTICO DE CUSTOS (v50) — etapa 1 da analise de custos da MCS.
 *
 * Responde, sem mudar nada em lugar nenhum, o quanto da margem de hoje da pra confiar:
 *  - quanto do faturamento tem custo cadastrado no Tiny;
 *  - onde o preco de custo e o custo medio do Tiny discordam (sinal de numero velho ou digitado errado);
 *  - kits sem custo;
 *  - o imposto que saiu DE FATO nas vendas, por produto (lido das notas guardadas no backup);
 *  - o custo do Tiny ao lado do custo da ultima nota de importacao;
 *  - os 30 produtos que mais faturam, com custo, imposto e margem, pra conferir a olho.
 *
 * A MCS revende produtos importados pela propria empresa; o custo digitado no Tiny ja inclui frete,
 * impostos de importacao e despacho. Por isso a nota de importacao serve de CONFERENCIA, nao de fonte.
 */

// ---------- formato que vem do backup (/painel/api/impostos) ----------

export interface ImpostoSkuBackup {
  sku: string;
  descricao: string;
  quantidade: number;
  valorDaVenda: number;
  impostos: number;
  percentual: number | null;
  percentualTotTrib: number | null;
}

export interface ImportacaoSkuBackup {
  sku: string;
  descricao: string;
  quantidade: number;
  custoTotal: number;
  custoPorUnidade: number | null;
  ultimaEntrada: string;
}

export interface RespostaImpostosBackup {
  de: string;
  ate: string;
  meses: string[];
  notasLidas: number;
  regime: { crt: string | null; nome: string; observacao: string | null };
  vendas: { total: { valorDaVenda: number; impostos: number; percentual: number | null; percentualTotTrib: number | null }; porSku: ImpostoSkuBackup[] };
  importacoes: { porSku: ImportacaoSkuBackup[]; observacao: string };
}

export type ImpostosDoBackup =
  | { disponivel: true; dados: RespostaImpostosBackup }
  | { disponivel: false; calculando: boolean; motivo: string };

// ---------- resultado ----------

export interface LinhaTop {
  sku: string;
  titulo: string;
  anuncios: number;
  unidades: number;
  bruto: number;
  /** bruto - comissao - frete (o mesmo liquido da aba Desempenho). */
  liquido: number;
  estado: EstadoDeCusto;
  custoUnitario: number | null;
  custoMercadoria: number | null;
  /** % de imposto usado: o do produto quando ha venda suficiente nas notas; senao o geral. */
  impostoPct: number | null;
  impostoOrigem: 'produto' | 'geral' | null;
  impostoEstimado: number | null;
  /** liquido - mercadoria - imposto. Sem custo (ou sem imposto conhecido) fica null: "nao sei", nunca zero. */
  margem: number | null;
  margemPct: number | null;
  custoNotaImportacao: number | null;
  diferencaImportacaoPct: number | null;
}

export interface DiagnosticoCustos {
  atualizadoEm: string;
  janelaDias: number;
  cobertura: {
    anuncios: number;
    porEstado: Record<EstadoDeCusto, number>;
    liquidoPorEstado: Record<EstadoDeCusto, number>;
    coberturaPorAnuncio: number;
    coberturaPorFaturamento: number;
  };
  tiny: { produtosLidos: number; comPrecoCusto: number; comCustoMedio: number; semCusto: number; kits: number };
  divergenciasTiny: Array<{ sku: string; descricao: string; custoPreco: number; custoMedio: number; diferencaPct: number; liquido: number }>;
  kitsSemCusto: Array<{ sku: string; descricao: string; liquido: number }>;
  impostos: {
    disponivel: boolean;
    calculando: boolean;
    motivo: string | null;
    periodo: string | null;
    notasLidas: number | null;
    regime: string | null;
    observacao: string | null;
    percentualGeral: number | null;
    percentualTotTribGeral: number | null;
    produtosComImposto: number;
  };
  importacao: {
    disponivel: boolean;
    conferidos: number;
    divergentes: Array<{ sku: string; descricao: string; custoTiny: number; custoNota: number; diferencaPct: number; ultimaEntrada: string; liquido: number }>;
    semCustoNoTinyComNota: Array<{ sku: string; descricao: string; custoNota: number; ultimaEntrada: string }>;
    observacao: string | null;
  };
  top: LinhaTop[];
  /** Frases curtas com o que o diagnostico achou, na ordem em que vale agir. */
  achados: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const brl = (n: number): string => 'R$ ' + r2(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Diferenca de b em relacao a a, em %. */
const difPct = (a: number, b: number): number => r1(((b - a) / a) * 100);
const pct = (n: number): string => `${String(n).replace('.', ',')}%`;

/** Faturamento minimo do produto nas notas pra usar o % de imposto dele em vez do geral. */
const MIN_VENDA_PARA_PCT_PROPRIO = 300;

/**
 * Monta o diagnostico. Funcao pura: recebe margem (ML + Tiny), catalogo do Tiny e impostos do backup.
 */
export function montarDiagnostico(
  margem: Pick<ResultadoMargem, 'janelaDias' | 'resumo' | 'anuncios'>,
  produtos: ProdutoNormalizado[],
  impostos: ImpostosDoBackup,
  opcoes: { divergenciaPct: number; topN?: number; agora?: Date },
): DiagnosticoCustos {
  const lim = opcoes.divergenciaPct;
  const topN = opcoes.topN ?? 30;

  // --- faturamento por SKU (varios anuncios podem vender o mesmo produto) ---
  interface PorSku { sku: string; titulo: string; anuncios: number; unidades: number; bruto: number; liquido: number; estado: EstadoDeCusto; custo: number | null }
  const porSku = new Map<string, PorSku>();
  const semSku: LacunaDoAnuncio[] = [];
  for (const a of margem.anuncios) {
    const k = chaveSku(a.sku);
    if (!k) { semSku.push(a); continue; }
    const s = porSku.get(k) ?? { sku: k, titulo: a.titulo, anuncios: 0, unidades: 0, bruto: 0, liquido: 0, estado: a.estado, custo: a.custo };
    s.anuncios++;
    s.unidades += a.unidades || 0;
    s.bruto += a.bruto || 0;
    s.liquido += a.liquido || 0;
    if (!s.titulo && a.titulo) s.titulo = a.titulo;
    porSku.set(k, s);
  }
  const liquidoDoSku = (sku: string) => r2(porSku.get(sku)?.liquido ?? 0);

  // --- catalogo do Tiny ---
  const tiny = new Map<string, ProdutoNormalizado>();
  for (const p of produtos) { const k = chaveSku(p.sku); if (k && !tiny.has(k)) tiny.set(k, p); }
  let comPrecoCusto = 0, comCustoMedio = 0, semCusto = 0, kits = 0;
  const divergenciasTiny: DiagnosticoCustos['divergenciasTiny'] = [];
  const kitsSemCusto: DiagnosticoCustos['kitsSemCusto'] = [];
  for (const [k, p] of tiny) {
    if (p.custoPreco) comPrecoCusto++;
    if (p.custoMedio) comCustoMedio++;
    if (!p.custo) semCusto++;
    if (p.tipo === 'K') {
      kits++;
      if (!p.custo) kitsSemCusto.push({ sku: k, descricao: p.descricao || '', liquido: liquidoDoSku(k) });
    }
    if (p.custoPreco && p.custoMedio) {
      const d = difPct(p.custoPreco, p.custoMedio);
      if (Math.abs(d) >= lim) divergenciasTiny.push({ sku: k, descricao: p.descricao || '', custoPreco: p.custoPreco, custoMedio: p.custoMedio, diferencaPct: d, liquido: liquidoDoSku(k) });
    }
  }
  divergenciasTiny.sort((a, b) => b.liquido - a.liquido || Math.abs(b.diferencaPct) - Math.abs(a.diferencaPct));
  kitsSemCusto.sort((a, b) => b.liquido - a.liquido);

  // --- impostos e importacao (backup) ---
  const dados = impostos.disponivel ? impostos.dados : null;
  const simples = !!dados?.regime.observacao;
  const impostoSku = new Map<string, ImpostoSkuBackup>();
  const importSku = new Map<string, ImportacaoSkuBackup>();
  if (dados) {
    for (const v of dados.vendas.porSku) { const k = chaveSku(v.sku); if (k) impostoSku.set(k, v); }
    for (const v of dados.importacoes.porSku) { const k = chaveSku(v.sku); if (k) importSku.set(k, v); }
  }
  const pctGeral = dados && !simples ? dados.vendas.total.percentual : null;
  const pctDoSku = (k: string): { pct: number | null; origem: 'produto' | 'geral' | null } => {
    if (!dados || simples) return { pct: null, origem: null };
    const v = impostoSku.get(k);
    if (v && v.valorDaVenda >= MIN_VENDA_PARA_PCT_PROPRIO && v.percentual != null) return { pct: v.percentual, origem: 'produto' };
    return pctGeral != null ? { pct: pctGeral, origem: 'geral' } : { pct: null, origem: null };
  };

  let conferidos = 0;
  const divergentes: DiagnosticoCustos['importacao']['divergentes'] = [];
  const semCustoNoTinyComNota: DiagnosticoCustos['importacao']['semCustoNoTinyComNota'] = [];
  for (const [k, imp] of importSku) {
    if (imp.custoPorUnidade == null || !(imp.custoPorUnidade > 0)) continue;
    const custoTiny = tiny.get(k)?.custo ?? null;
    if (custoTiny == null) {
      semCustoNoTinyComNota.push({ sku: k, descricao: imp.descricao, custoNota: r2(imp.custoPorUnidade), ultimaEntrada: imp.ultimaEntrada });
      continue;
    }
    conferidos++;
    const d = difPct(custoTiny, imp.custoPorUnidade);
    if (Math.abs(d) >= lim) divergentes.push({ sku: k, descricao: imp.descricao, custoTiny, custoNota: r2(imp.custoPorUnidade), diferencaPct: d, ultimaEntrada: imp.ultimaEntrada, liquido: liquidoDoSku(k) });
  }
  divergentes.sort((a, b) => b.liquido - a.liquido || Math.abs(b.diferencaPct) - Math.abs(a.diferencaPct));

  // --- top N por faturamento liquido ---
  const top: LinhaTop[] = [...porSku.values()]
    .sort((a, b) => b.liquido - a.liquido)
    .slice(0, topN)
    .map((s) => {
      const custoMercadoria = s.custo != null ? r2(s.custo * s.unidades) : null;
      const { pct, origem } = pctDoSku(s.sku);
      const impostoEstimado = pct != null ? r2((s.bruto * pct) / 100) : null;
      const margemV = custoMercadoria != null && impostoEstimado != null ? r2(s.liquido - custoMercadoria - impostoEstimado) : null;
      const imp = importSku.get(s.sku);
      const custoNota = imp?.custoPorUnidade != null ? r2(imp.custoPorUnidade) : null;
      return {
        sku: s.sku,
        titulo: s.titulo,
        anuncios: s.anuncios,
        unidades: s.unidades,
        bruto: r2(s.bruto),
        liquido: r2(s.liquido),
        estado: s.estado,
        custoUnitario: s.custo,
        custoMercadoria,
        impostoPct: pct,
        impostoOrigem: origem,
        impostoEstimado,
        margem: margemV,
        margemPct: margemV != null && s.bruto > 0 ? r1((margemV / s.bruto) * 100) : null,
        custoNotaImportacao: custoNota,
        diferencaImportacaoPct: custoNota != null && s.custo ? difPct(s.custo, custoNota) : null,
      };
    });

  // --- achados, em palavras ---
  const res = margem.resumo;
  const achados: string[] = [];
  const liqTotal = Object.values(res.liquidoPorEstado).reduce((t, v) => t + v, 0);
  const semCustoLiq = liqTotal - res.liquidoPorEstado.com_custo;
  achados.push(`${pct(res.coberturaPorLiquido)} do faturamento líquido dos últimos ${margem.janelaDias} dias tem custo cadastrado no Tiny (${pct(res.cobertura)} dos anúncios).`);
  if (semCustoLiq > 0) {
    const partes: string[] = [];
    if (res.liquidoPorEstado.sem_custo_no_tiny > 0) partes.push(`${brl(res.liquidoPorEstado.sem_custo_no_tiny)} em produtos sem custo no Tiny`);
    if (res.liquidoPorEstado.fora_do_tiny > 0) partes.push(`${brl(res.liquidoPorEstado.fora_do_tiny)} em anúncios cujo SKU não existe no Tiny`);
    if (res.liquidoPorEstado.sem_sku > 0) partes.push(`${brl(res.liquidoPorEstado.sem_sku)} em anúncios sem SKU`);
    achados.push(`Faturamento sem custo: ${partes.join('; ')}.`);
  }
  if (divergentes.length) achados.push(`${divergentes.length} produto(s) com o custo do Tiny ${lim}% ou mais longe do custo da nota de importação. Pode ser lote novo sem atualizar o Tiny, ou despesas que a nota não tem.`);
  if (semCustoNoTinyComNota.length) achados.push(`${semCustoNoTinyComNota.length} produto(s) têm nota de importação mas estão sem custo no Tiny: o custo da nota serve de ponto de partida.`);
  if (divergenciasTiny.length) achados.push(`${divergenciasTiny.length} produto(s) com preço de custo e custo médio do Tiny diferentes em ${lim}% ou mais.`);
  if (kitsSemCusto.length) achados.push(`${kitsSemCusto.length} kit(s) sem custo no Tiny.`);
  if (!dados) achados.push(impostos.disponivel ? '' : `Imposto real ainda não disponível: ${impostos.motivo}`);
  else if (simples) achados.push(`O emitente está no ${dados.regime.nome}: o imposto da venda (DAS) não vem item a item na nota, então a margem abaixo sai sem imposto. Informe a alíquota efetiva do DAS para completar.`);
  else if (pctGeral != null) achados.push(`O imposto que saiu nas notas de venda de ${dados.de} a ${dados.ate} foi ${pct(pctGeral)} do valor vendido, em média.`);

  return {
    atualizadoEm: (opcoes.agora ?? new Date()).toISOString(),
    janelaDias: margem.janelaDias,
    cobertura: {
      anuncios: res.total,
      porEstado: res.porEstado,
      liquidoPorEstado: res.liquidoPorEstado,
      coberturaPorAnuncio: res.cobertura,
      coberturaPorFaturamento: res.coberturaPorLiquido,
    },
    tiny: { produtosLidos: tiny.size, comPrecoCusto, comCustoMedio, semCusto, kits },
    divergenciasTiny: divergenciasTiny.slice(0, 50),
    kitsSemCusto: kitsSemCusto.slice(0, 50),
    impostos: {
      disponivel: !!dados,
      calculando: !impostos.disponivel && impostos.calculando,
      motivo: impostos.disponivel ? null : impostos.motivo,
      periodo: dados ? `${dados.de} a ${dados.ate}` : null,
      notasLidas: dados?.notasLidas ?? null,
      regime: dados?.regime.nome ?? null,
      observacao: dados?.regime.observacao ?? null,
      percentualGeral: pctGeral,
      percentualTotTribGeral: dados?.vendas.total.percentualTotTrib ?? null,
      produtosComImposto: impostoSku.size,
    },
    importacao: {
      disponivel: !!dados,
      conferidos,
      divergentes: divergentes.slice(0, 50),
      semCustoNoTinyComNota: semCustoNoTinyComNota.slice(0, 50),
      observacao: dados?.importacoes.observacao ?? null,
    },
    top,
    achados: achados.filter(Boolean),
  };
}

// ---------- leitura do backup ----------

export async function buscarImpostosDoBackup(): Promise<ImpostosDoBackup> {
  if (!config.backupBaseUrl || !config.backupApiKey) {
    return { disponivel: false, calculando: false, motivo: 'defina BACKUP_BASE_URL e BACKUP_API_KEY (a PANEL_API_KEY do backup) para ler o imposto das notas.' };
  }
  try {
    const res = await fetch(`${config.backupBaseUrl}/painel/api/impostos`, {
      headers: { 'x-api-key': config.backupApiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const corpo: any = await res.json().catch(() => ({}));
    if (res.status === 202) return { disponivel: false, calculando: true, motivo: 'o backup está somando as notas fiscais; tente de novo em alguns minutos.' };
    if (res.status === 404) return { disponivel: false, calculando: false, motivo: 'o backup ainda não tem a rota de impostos (precisa da versão 0.10.0) ou está sem PANEL_API_KEY.' };
    if (res.status === 401) return { disponivel: false, calculando: false, motivo: 'o backup recusou a chave: confira se BACKUP_API_KEY é igual à PANEL_API_KEY do backup.' };
    if (!res.ok) return { disponivel: false, calculando: false, motivo: `o backup respondeu ${res.status}${corpo?.erro ? ` (${corpo.erro})` : ''}.` };
    return { disponivel: true, dados: corpo as RespostaImpostosBackup };
  } catch (err: any) {
    return { disponivel: false, calculando: false, motivo: `não consegui falar com o backup (${err?.message || err}).` };
  }
}

// ---------- cache e orquestracao ----------

let cache: DiagnosticoCustos | null = null;
/** O que entrou no ultimo diagnostico: refazer so a parte do backup nao precisa varrer ML e Tiny de novo. */
let entradas: { margem: ResultadoMargem; produtos: ProdutoNormalizado[] } | null = null;

export function getDiagnostico(): DiagnosticoCustos | null {
  return cache;
}

/** Refaz o diagnostico: margem (cache de ate 6 h, senao varre), catalogo do Tiny e impostos do backup. */
export async function refreshDiagnostico(): Promise<DiagnosticoCustos> {
  const atual = getMargem();
  const idadeH = atual ? (Date.now() - new Date(atual.atualizadoEm).getTime()) / 3_600_000 : Infinity;
  const margem = atual && idadeH < 6 ? atual : await refreshMargem();
  const [produtos, impostos] = await Promise.all([listarProdutos(5000), buscarImpostosDoBackup()]);
  entradas = { margem, produtos };
  cache = montarDiagnostico(margem, produtos, impostos, { divergenciaPct: config.custoDivergenciaPct });
  logger.info(`[CUSTOS] diagnostico: ${cache.cobertura.coberturaPorFaturamento}% do faturamento com custo; impostos ${cache.impostos.disponivel ? 'ok' : 'indisponivel'}.`);
  return cache;
}

/**
 * Serve o diagnostico. Sem cache, monta. Se o backup ainda estava somando as notas, pergunta de novo so a ele
 * (barato) e remonta com o que ja tinha de ML e Tiny.
 */
export async function obterDiagnostico(forcar = false): Promise<DiagnosticoCustos> {
  if (forcar || !cache || !entradas) return refreshDiagnostico();
  if (cache.impostos.calculando) {
    const impostos = await buscarImpostosDoBackup();
    cache = montarDiagnostico(entradas.margem, entradas.produtos, impostos, { divergenciaPct: config.custoDivergenciaPct });
  }
  return cache;
}
