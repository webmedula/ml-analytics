import { Velocidade } from './history';

/**
 * REPOSICAO DE ESTOQUE — quanto comprar e quando.
 *
 * Tudo aqui e funcao pura: recebe velocidade e estoque, devolve numero. Nenhuma chamada de rede,
 * nenhum disco. Sao as contas que decidem compra, entao merecem teste, nao confianca.
 */

export interface ParametrosCompra {
  /** Dias entre fazer o pedido e a mercadoria estar disponivel pra vender. */
  prazoEntregaDias: number;
  /** De quanto em quanto tempo voce faz pedido (7 = semanal, 15 = quinzenal). */
  cicloCompraDias: number;
  /**
   * Nivel de servico desejado, em z-score. 1.65 ~ 95% (rompe 1 ciclo em 20).
   * Quanto maior, mais estoque de seguranca — e mais capital parado.
   */
  z?: number;
}

export interface SugestaoCompra {
  /** unidades/dia usadas na conta */
  velocidade: number;
  /** quantos dias o estoque atual ainda dura */
  coberturaDias: number | null;
  /** estoque abaixo do qual e hora de pedir */
  pontoDeCompra: number;
  /** colchao pra variacao da demanda durante o prazo de entrega */
  estoqueSeguranca: number;
  /** quanto comprar agora (0 = nao precisa) */
  comprar: number;
  /** dias ate romper, se nada for feito */
  diasAteRuptura: number | null;
  urgencia: 'rompido' | 'critico' | 'atencao' | 'ok' | 'parado';
  /** por que essa sugestao — texto pro operador, nao pro log */
  explicacao: string;
}

/** Desvio padrao amostral das unidades diarias. Base do estoque de seguranca. */
export function desvioPadrao(valores: number[]): number {
  const n = valores.length;
  if (n < 2) return 0;
  const media = valores.reduce((s, v) => s + v, 0) / n;
  const soma = valores.reduce((s, v) => s + (v - media) ** 2, 0);
  return Math.sqrt(soma / (n - 1));
}

/**
 * Estoque de seguranca = z x desvio x raiz(prazo).
 *
 * A raiz do prazo (e nao o prazo) porque a incerteza se acumula pela variancia, nao linearmente:
 * dobrar o prazo nao dobra o risco, multiplica por ~1.41.
 */
export function estoqueDeSeguranca(desvioDiario: number, prazoEntregaDias: number, z = 1.65): number {
  if (desvioDiario <= 0 || prazoEntregaDias <= 0) return 0;
  return Math.ceil(z * desvioDiario * Math.sqrt(prazoEntregaDias));
}

export function calcularCompra(
  velocidade: Velocidade,
  estoqueAtual: number,
  desvioDiario: number,
  p: ParametrosCompra,
  emTransito = 0,
): SugestaoCompra {
  const v = velocidade.unidadesPorDia;
  const seguranca = estoqueDeSeguranca(desvioDiario, p.prazoEntregaDias, p.z ?? 1.65);
  const pontoDeCompra = Math.ceil(v * p.prazoEntregaDias + seguranca);

  const disponivel = estoqueAtual + emTransito;
  const cobertura = v > 0 ? Math.round((disponivel / v) * 10) / 10 : null;

  // Cobre o prazo de entrega MAIS o proximo ciclo: quando a mercadoria chegar, ela precisa durar
  // ate o pedido seguinte chegar tambem.
  const alvo = Math.ceil(v * (p.prazoEntregaDias + p.cicloCompraDias) + seguranca);
  const comprar = Math.max(0, alvo - disponivel);

  let urgencia: SugestaoCompra['urgencia'];
  if (v <= 0) urgencia = 'parado';
  else if (estoqueAtual <= 0) urgencia = 'rompido';
  // Estritamente MENOR que o prazo: se durar exatamente o prazo, o estoque acaba no dia em que a
  // mercadoria chega — apertado, mas ainda e "hora de pedir", nao "vai romper". Com `<=` aqui,
  // 'atencao' virava inalcancavel sempre que o estoque de seguranca fosse zero.
  else if (cobertura != null && cobertura < p.prazoEntregaDias) urgencia = 'critico';
  else if (disponivel <= pontoDeCompra) urgencia = 'atencao';
  else urgencia = 'ok';

  const explicacao = montarExplicacao(urgencia, v, cobertura, p, comprar, velocidade);

  return {
    velocidade: v,
    coberturaDias: cobertura,
    pontoDeCompra,
    estoqueSeguranca: seguranca,
    comprar,
    diasAteRuptura: cobertura,
    urgencia,
    explicacao,
  };
}

function montarExplicacao(
  urgencia: SugestaoCompra['urgencia'],
  v: number,
  cobertura: number | null,
  p: ParametrosCompra,
  comprar: number,
  velocidade: Velocidade,
): string {
  const ressalva = !velocidade.confiavel
    ? ` Atencao: so ${velocidade.diasConsiderados} dia(s) util(eis) de histórico — o numero ainda e fraco.`
    : '';
  const descartes: string[] = [];
  if (velocidade.diasDescartadosSemEstoque > 0) {
    descartes.push(`${velocidade.diasDescartadosSemEstoque} dia(s) sem estoque foram ignorados (venderia mais se tivesse)`);
  }
  if (velocidade.diasDescartadosPromocao > 0) {
    descartes.push(`${velocidade.diasDescartadosPromocao} dia(s) de promocao foram ignorados (inflariam a media)`);
  }
  if (velocidade.diasDescartadosPorLacuna > 0) {
    descartes.push(`${velocidade.diasDescartadosPorLacuna} dia(s) sem gravacao foram ignorados (o servico ficou fora do ar)`);
  }
  const nota = descartes.length ? ` ${descartes.join('; ')}.` : '';

  switch (urgencia) {
    case 'parado':
      return `Sem venda no periodo. Nao ha o que repor — e vale olhar por que parou.${nota}`;
    case 'rompido':
      return `Sem estoque AGORA. Cada dia parado vende zero e derruba o posicionamento. Comprar ${comprar} un.${nota}${ressalva}`;
    case 'critico':
      return `O estoque dura ${cobertura} dia(s) e o fornecedor leva ${p.prazoEntregaDias}. Vai romper antes de chegar. Comprar ${comprar} un. hoje.${nota}${ressalva}`;
    case 'atencao':
      return `Chegou no ponto de compra: pedir ${comprar} un. no proximo pedido cobre o prazo e o ciclo.${nota}${ressalva}`;
    default:
      return `Estoque folgado para ${cobertura} dia(s), vendendo ${v} un./dia. Nada a fazer agora.${nota}${ressalva}`;
  }
}

const ORDEM_URGENCIA: Record<SugestaoCompra['urgencia'], number> = {
  rompido: 0,
  critico: 1,
  atencao: 2,
  ok: 3,
  parado: 4,
};

/** Mais urgente primeiro; dentro do mesmo nivel, quem vende mais na frente. */
export function ordenarPorUrgencia<T extends { sugestao: SugestaoCompra }>(linhas: T[]): T[] {
  return [...linhas].sort((a, b) => {
    const ua = ORDEM_URGENCIA[a.sugestao.urgencia];
    const ub = ORDEM_URGENCIA[b.sugestao.urgencia];
    if (ua !== ub) return ua - ub;
    return b.sugestao.velocidade - a.sugestao.velocidade;
  });
}
