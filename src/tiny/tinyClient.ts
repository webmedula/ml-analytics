import { config } from '../config';
import { logger } from '../logger';
import { ensureValidTinyToken } from './tinyOauthClient';

/**
 * Leitura de produtos no Tiny (API v3). SOMENTE LEITURA — este servico nao escreve no seu ERP.
 *
 * O que interessa daqui e o custo por SKU: e ele que transforma "liquido" em MARGEM, e margem e o
 * unico numero que responde se um patrocinio compensa.
 */

export class TinyApiError extends Error {
  status: number;
  corpo: unknown;
  constructor(status: number, message: string, corpo?: unknown) {
    super(message);
    this.name = 'TinyApiError';
    this.status = status;
    this.corpo = corpo;
  }
}

async function tinyRequest<T>(caminho: string): Promise<T> {
  const token = await ensureValidTinyToken();
  const res = await fetch(`${config.tinyApiBaseUrl}${caminho}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  const texto = await res.text();
  let dados: any;
  try {
    dados = texto ? JSON.parse(texto) : undefined;
  } catch {
    dados = { raw: texto.slice(0, 500) };
  }

  if (!res.ok) {
    throw new TinyApiError(res.status, dados?.mensagem || dados?.message || `Erro HTTP ${res.status}`, dados);
  }
  return dados as T;
}

export interface ProdutoTiny {
  id?: number | string;
  sku?: string | null;
  descricao?: string | null;
  precoCusto?: number | null;
  precoCustoMedio?: number | null;
  situacao?: string | null;
}

/** O Tiny ja mudou o formato da lista mais de uma vez: aceita as formas conhecidas. */
export function extrairProdutos(resposta: any): any[] {
  if (Array.isArray(resposta)) return resposta;
  for (const chave of ['itens', 'produtos', 'data', 'results', 'retorno']) {
    const v = resposta?.[chave];
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.itens)) return v.itens;
  }
  return [];
}

/**
 * Normaliza um produto do Tiny, tolerando variacao de nomes entre versoes.
 * `custo` fica null quando nao ha valor utilizavel — melhor ausente que zero fingindo ser custo.
 */
export function normalizarProduto(bruto: any): { sku: string | null; descricao: string | null; custo: number | null } {
  const p = bruto?.produto ?? bruto ?? {};
  const sku = p.sku ?? p.codigo ?? null;

  const candidatos = [p.precoCusto, p.preco_custo, p.precoCustoMedio, p.preco_custo_medio, p.custo];
  let custo: number | null = null;
  for (const c of candidatos) {
    const n = typeof c === 'string' ? Number(c.replace(',', '.')) : Number(c);
    if (Number.isFinite(n) && n > 0) {
      custo = Math.round(n * 100) / 100;
      break;
    }
  }

  return {
    sku: sku ? String(sku).trim() : null,
    descricao: p.descricao ?? p.nome ?? null,
    custo,
  };
}

/** Lista produtos paginando. `limite` protege contra catalogo gigante numa primeira execucao. */
export async function listarProdutos(limite = 1000): Promise<Array<{ sku: string | null; descricao: string | null; custo: number | null }>> {
  const out: Array<{ sku: string | null; descricao: string | null; custo: number | null }> = [];
  const tamanhoPagina = 100;
  let offset = 0;

  for (;;) {
    const resposta = await tinyRequest<any>(`/produtos?limit=${tamanhoPagina}&offset=${offset}`);
    const itens = extrairProdutos(resposta);
    if (itens.length === 0) break;

    for (const item of itens) out.push(normalizarProduto(item));

    offset += tamanhoPagina;
    if (out.length >= limite || itens.length < tamanhoPagina) break;
    await new Promise((r) => setTimeout(r, 250)); // gentil com o ERP
  }

  logger.info(`[TINY] ${out.length} produto(s) lidos; ${out.filter((p) => p.custo != null).length} com custo preenchido.`);
  return out.slice(0, limite);
}

/**
 * DIAGNOSTICO: antes de construir a margem, confirma que existe custo pra construir em cima.
 * Devolve a primeira pagina crua e o resumo do que foi encontrado.
 */
export async function diagnosticarTiny(): Promise<any> {
  const resposta = await tinyRequest<any>('/produtos?limit=20&offset=0');
  const itens = extrairProdutos(resposta);
  const normalizados = itens.map(normalizarProduto);

  const comSku = normalizados.filter((p) => p.sku).length;
  const comCusto = normalizados.filter((p) => p.custo != null).length;

  let veredicto: string;
  if (itens.length === 0) {
    veredicto = 'A API respondeu, mas nao reconheci nenhum produto no formato da resposta. Veja `amostraCrua` pra ajustar a leitura.';
  } else if (comCusto === 0) {
    veredicto =
      'Nenhum dos produtos da amostra tem custo preenchido. Sem custo no Tiny nao ha margem a calcular — ' +
      'o problema estaria no cadastro, nao na integracao.';
  } else if (comCusto < itens.length / 2) {
    veredicto = `Só ${comCusto} de ${itens.length} produtos da amostra tem custo. A margem vai existir, mas incompleta.`;
  } else {
    veredicto = `${comCusto} de ${itens.length} produtos com custo preenchido. Da pra construir a margem.`;
  }

  return {
    veredicto,
    chavesDoTopo: resposta && typeof resposta === 'object' ? Object.keys(resposta) : null,
    produtosNaAmostra: itens.length,
    comSku,
    comCusto,
    exemplos: normalizados.slice(0, 5),
    amostraCrua: itens.slice(0, 2),
  };
}
