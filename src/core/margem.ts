import { chaveSku } from './custos';

/**
 * ESTADO DO CUSTO DE UM ANUNCIO.
 *
 * Quatro estados em vez de "tem/nao tem" porque cada um pede uma acao diferente de quem cuida do
 * cadastro, e a diferenca entre eles e uma tarde de trabalho no lugar certo ou no lugar errado.
 */
export type EstadoDeCusto = 'com_custo' | 'sem_custo_no_tiny' | 'fora_do_tiny' | 'sem_sku';

export const ACAO_POR_ESTADO: Record<EstadoDeCusto, string> = {
  com_custo: 'Nada a fazer — margem calculavel.',
  sem_custo_no_tiny: 'Produto existe no Tiny sem precoCusto. Lancar a nota de entrada ou preencher o custo.',
  fora_do_tiny: 'O codigo do anuncio nao existe no Tiny. Alinhar o SKU entre os dois sistemas.',
  sem_sku: 'Anuncio sem SKU no ML. Preencher o atributo SELLER_SKU.',
};

export interface LacunaDoAnuncio {
  itemId: string;
  titulo: string;
  sku: string | null;
  origemDoSku: string | null;
  estado: EstadoDeCusto;
  custo: number | null;
  /** Quanto esse anuncio vendeu (liquido) na janela — e o que ordena o esforco de cadastro. */
  liquido: number;
  unidades: number;
}

/**
 * Classifica um anuncio. Funcao pura: o custo do erro aqui e alto e silencioso — classificar
 * errado nao da erro, da margem em branco (ou pior, margem cheia) no anuncio errado.
 */
export function classificarCusto(
  sku: string | null | undefined,
  custos: Record<string, number>,
  semCusto: Set<string>,
): { estado: EstadoDeCusto; custo: number | null } {
  const chave = chaveSku(sku);
  if (!chave) return { estado: 'sem_sku', custo: null };

  const c = custos[chave];
  if (c != null && c > 0) return { estado: 'com_custo', custo: c };
  if (semCusto.has(chave)) return { estado: 'sem_custo_no_tiny', custo: null };
  return { estado: 'fora_do_tiny', custo: null };
}

/**
 * Margem de uma venda, ja descontado tudo que sai do bolso: comissao, frete e mercadoria.
 *
 * Devolve `null` — e nao zero — quando nao ha custo. Zero significaria "nao sobrou nada"; null
 * significa "nao sei". Num painel que decide preco e patrocinio, confundir os dois e o erro mais
 * caro possivel: um produto sem custo cadastrado apareceria como 100% de margem.
 */
export function margemDaVenda(
  liquido: number,
  custoUnitario: number | null,
  unidades: number,
): { margem: number | null; percentual: number | null } {
  if (custoUnitario == null || !(custoUnitario > 0) || !(unidades > 0)) {
    return { margem: null, percentual: null };
  }
  const margem = Math.round((liquido - custoUnitario * unidades) * 100) / 100;
  const percentual = liquido > 0 ? Math.round((margem / liquido) * 1000) / 10 : null;
  return { margem, percentual };
}

export interface ResumoDeLacunas {
  total: number;
  porEstado: Record<EstadoDeCusto, number>;
  /** Faturamento liquido preso em cada estado — e isso que diz por onde comecar o cadastro. */
  liquidoPorEstado: Record<EstadoDeCusto, number>;
  cobertura: number;
  /** Cobertura pesada por dinheiro: 25% dos anuncios pode ser 80% do faturamento, ou 2%. */
  coberturaPorLiquido: number;
}

const zerado = (): Record<EstadoDeCusto, number> => ({
  com_custo: 0, sem_custo_no_tiny: 0, fora_do_tiny: 0, sem_sku: 0,
});

/**
 * Resume as lacunas contando anuncios E dinheiro.
 *
 * Contar anuncio sozinho engana: 17 anuncios sem SKU podem ser 17 itens que quase nao vendem. O
 * que decide a ordem do trabalho e quanto faturamento esta preso em cada estado.
 */
export function resumirLacunas(lacunas: LacunaDoAnuncio[]): ResumoDeLacunas {
  const porEstado = zerado();
  const liquidoPorEstado = zerado();

  for (const l of lacunas) {
    porEstado[l.estado]++;
    liquidoPorEstado[l.estado] += l.liquido || 0;
  }

  for (const k of Object.keys(liquidoPorEstado) as EstadoDeCusto[]) {
    liquidoPorEstado[k] = Math.round(liquidoPorEstado[k] * 100) / 100;
  }

  const total = lacunas.length;
  const liquidoTotal = Object.values(liquidoPorEstado).reduce((s, v) => s + v, 0);

  return {
    total,
    porEstado,
    liquidoPorEstado,
    cobertura: total > 0 ? Math.round((porEstado.com_custo / total) * 1000) / 10 : 0,
    coberturaPorLiquido: liquidoTotal > 0
      ? Math.round((liquidoPorEstado.com_custo / liquidoTotal) * 1000) / 10
      : 0,
  };
}

/** CSV pra trabalhar a lista fora do painel — cadastro se corrige em planilha, nao em dashboard. */
export function lacunasParaCsv(lacunas: LacunaDoAnuncio[]): string {
  const escapar = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const cabecalho = ['itemId', 'titulo', 'sku', 'origemDoSku', 'estado', 'acao', 'custo', 'liquido', 'unidades'];
  const linhas = lacunas.map((l) =>
    [l.itemId, l.titulo, l.sku, l.origemDoSku, l.estado, ACAO_POR_ESTADO[l.estado], l.custo, l.liquido, l.unidades]
      .map(escapar)
      .join(';'),
  );

  // Ponto-e-virgula e BOM: e o que faz o Excel em portugues abrir certo, com acento e sem juntar
  // tudo numa coluna so. Sem isso a lista chega ilegivel e ninguem usa.
  return '﻿' + [cabecalho.join(';'), ...linhas].join('\r\n');
}
