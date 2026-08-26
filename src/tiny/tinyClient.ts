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

  // O custo vem ANINHADO em `precos` na v3 (`precos.precoCusto`). Procurar so na raiz devolvia
  // undefined e virava "sem custo" — bug que sobreviveria calado ate alguem confiar na margem.
  const precos = p.precos ?? {};
  const candidatos = [
    p.precoCusto, p.preco_custo, p.precoCustoMedio, p.preco_custo_medio, p.custo,
    precos.precoCusto, precos.preco_custo, precos.precoCustoMedio, precos.preco_custo_medio, precos.custo,
  ];
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
 * Quantos produtos o Tiny DIZ que existem, contra quantos eu li.
 *
 * Se a varredura parou antes do total, "SKU nao existe no Tiny" nao significa divergencia de
 * cadastro — significa que eu nao cheguei nele. Sao conclusoes opostas e so este numero separa.
 */
export async function lerPaginacao(): Promise<any> {
  const r = await tinyRequest<any>('/produtos?limit=1&offset=0');
  return r?.paginacao ?? null;
}

/**
 * Procura UM sku direto no Tiny, tentando os nomes de parametro que a API pode aceitar.
 *
 * Existe porque a varredura pode nao ter alcancado o produto (paginacao, filtro implicito de
 * situacao). Perguntar pelo codigo exato responde a pergunta certa: o produto existe no ERP, sim
 * ou nao? Sem isso eu mandaria o usuario procurar divergencia de cadastro que talvez nem exista.
 */
export async function procurarSkuNoTiny(sku: string): Promise<{
  sku: string;
  encontrado: boolean;
  encontradoPor: string | null;
  custo: number | null;
  situacao?: string | null;
  descricao?: string | null;
  tentativas: Array<{ parametro: string; resultado: string }>;
}> {
  const alvo = sku.trim().toUpperCase();
  const tentativas: Array<{ parametro: string; resultado: string }> = [];

  for (const parametro of ['codigo', 'pesquisa', 'nome']) {
    try {
      const r = await tinyRequest<any>(`/produtos?${parametro}=${encodeURIComponent(sku)}&limit=10&offset=0`);
      const itens = extrairProdutos(r);
      const casou = itens.find((i) => {
        const p = i?.produto ?? i ?? {};
        return String(p.sku ?? p.codigo ?? '').trim().toUpperCase() === alvo;
      });

      if (casou) {
        const p = casou?.produto ?? casou ?? {};
        tentativas.push({ parametro, resultado: 'encontrou' });
        return {
          sku,
          encontrado: true,
          encontradoPor: parametro,
          custo: normalizarProduto(casou).custo,
          situacao: p.situacao ?? null,
          descricao: p.descricao ?? null,
          tentativas,
        };
      }
      tentativas.push({ parametro, resultado: `${itens.length} resultado(s), nenhum com o codigo exato` });
    } catch (err: any) {
      // Parametro nao aceito devolve erro: e informacao, nao falha. Segue pro proximo.
      tentativas.push({ parametro, resultado: `erro: ${err?.message || err}` });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { sku, encontrado: false, encontradoPor: null, custo: null, tentativas };
}

/** Detalhe de um produto. A LISTA do Tiny e resumida; o custo pode existir so aqui. */
export async function buscarProdutoDetalhe(id: string | number): Promise<any> {
  return tinyRequest<any>(`/produtos/${encodeURIComponent(String(id))}`);
}

/**
 * Varre um objeto inteiro atras de QUALQUER campo cujo nome fale em custo, e devolve onde achou.
 *
 * Feito assim de proposito: eu nao sei o nome exato que o Tiny usa no detalhe, e chutar nome de
 * campo foi justamente o que produziu o veredicto duvidoso da lista. Procurar por padrao no nome
 * mostra o que existe de verdade, inclusive campos aninhados que eu nao teria adivinhado.
 */
export function procurarCamposDeCusto(raiz: any, prefixo = '', achados: Array<{ campo: string; valor: unknown }> = []): Array<{ campo: string; valor: unknown }> {
  if (!raiz || typeof raiz !== 'object' || achados.length >= 40) return achados;

  for (const [chave, valor] of Object.entries(raiz)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    if (/cust/i.test(chave) && (typeof valor === 'number' || typeof valor === 'string')) {
      achados.push({ campo: caminho, valor });
    } else if (valor && typeof valor === 'object') {
      // Array grande (ex.: variacoes) so entra nos primeiros itens: o objetivo e amostrar, nao listar.
      const filhos = Array.isArray(valor) ? valor.slice(0, 3) : [valor];
      for (const filho of filhos) procurarCamposDeCusto(filho, caminho, achados);
    }
  }
  return achados;
}

/**
 * DIAGNOSTICO: antes de construir a margem, confirma que existe custo pra construir em cima.
 *
 * Olha a lista E o detalhe de alguns produtos. A distincao importa muito: se o custo so aparece no
 * detalhe, o problema e meu (endpoint errado) e a Fase 2 muda de desenho — uma chamada por SKU, com
 * cache. Se nem o detalhe tem custo, ai sim e cadastro, e nao ha o que programar.
 */
export async function diagnosticarTiny(): Promise<any> {
  const resposta = await tinyRequest<any>('/produtos?limit=20&offset=0');
  const itens = extrairProdutos(resposta);
  const normalizados = itens.map(normalizarProduto);

  const comSku = normalizados.filter((p) => p.sku).length;
  const comCustoNaLista = normalizados.filter((p) => p.custo != null).length;

  // Detalhe de ate 3 produtos da amostra.
  const detalhes: Array<{ id: unknown; sku: string | null; camposDeCusto: Array<{ campo: string; valor: unknown }>; erro?: string }> = [];
  let comCustoNoDetalhe = 0;
  let detalheCru: any = null;

  for (const item of itens.slice(0, 3)) {
    const p = item?.produto ?? item ?? {};
    const id = p.id ?? p.idProduto ?? null;
    if (id == null) continue;
    try {
      const detalhe = await buscarProdutoDetalhe(id);
      const corpo = detalhe?.produto ?? detalhe ?? {};
      if (detalheCru == null) detalheCru = corpo;
      const campos = procurarCamposDeCusto(corpo);
      const temValor = campos.some(({ valor }) => {
        const n = typeof valor === 'string' ? Number(valor.replace(',', '.')) : Number(valor);
        return Number.isFinite(n) && n > 0;
      });
      if (temValor) comCustoNoDetalhe++;
      detalhes.push({ id, sku: p.sku ?? null, camposDeCusto: campos });
    } catch (err: any) {
      detalhes.push({ id, sku: p.sku ?? null, camposDeCusto: [], erro: err?.message || String(err) });
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  let veredicto: string;
  if (itens.length === 0) {
    veredicto = 'A API respondeu, mas nao reconheci nenhum produto no formato da resposta. Veja `amostraCrua` pra ajustar a leitura.';
  } else if (comCustoNaLista > 0) {
    veredicto = `${comCustoNaLista} de ${itens.length} produtos ja trazem custo na propria lista. Da pra construir a margem lendo so a lista.`;
  } else if (comCustoNoDetalhe > 0) {
    veredicto =
      `A lista vem sem custo, mas ${comCustoNoDetalhe} de ${detalhes.length} produtos TEM custo no detalhe. ` +
      'O custo existe no cadastro; o que estava errado era eu ler so a lista. Veja `detalhes[].camposDeCusto` pro nome do campo.';
  } else if (detalhes.length === 0) {
    veredicto = 'Nao consegui identificar o id dos produtos pra consultar o detalhe. Veja `amostraCrua`.';
  } else {
    veredicto =
      'Nem a lista nem o detalhe trazem custo em nenhum campo. O custo nao esta cadastrado no Tiny — ' +
      'nao ha margem a calcular ate isso mudar.';
  }

  return {
    veredicto,
    chavesDoTopo: resposta && typeof resposta === 'object' ? Object.keys(resposta) : null,
    produtosNaAmostra: itens.length,
    comSku,
    comCustoNaLista,
    comCustoNoDetalhe,
    exemplos: normalizados.slice(0, 5),
    detalhes,
    amostraCrua: itens.slice(0, 1),
    detalheCru,
  };
}
