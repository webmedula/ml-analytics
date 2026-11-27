import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getMlAuthStatus } from '../ml/mlOauthClient';
import { getItemsAttributes, getMlUserId, getSellerItemIds, getSellerNickname, MlApiError, mlGet } from '../ml/mlClient';

/**
 * MERCADO (v57): o que acontece no Mercado Livre FORA dos anuncios da MCS.
 *
 * - Mais vendidos por categoria: /highlights/MLB/category/{id} (os 20 que o ML mostra na lista de mais vendidos).
 * - Tendencias: /trends/MLB[/{categoria}] (50 termos: 10 que mais cresceram, 20 mais buscados, 20 populares).
 * - Concorrencia num produto de catalogo: /products/{id}/items (todos os vendedores e precos).
 * - Busca livre: /sites/MLB/search; desde 2025 o ML recusa (403) para muitos apps, e ai cai para
 *   /products/search (catalogo).
 *
 * O ML nao informa quantas unidades o concorrente vendeu nem o historico. Por isso guardamos uma FOTO
 * por semana das categorias da MCS (data/mercado-fotos.json) e o radar compara a ultima com a anterior.
 * Tudo somente leitura.
 */

const SITE = 'MLB';
const CACHE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------- tipos

export interface ItemMaisVendido {
  posicao: number;
  id: string;
  tipo: string; // PRODUCT | ITEM | USER_PRODUCT
  titulo: string | null;
  preco: number | null;
  /** true quando o produto/anuncio e da MCS (anuncio nosso ou produto de catalogo em que temos anuncio). */
  nosso: boolean;
  link: string | null;
}

export interface Tendencia {
  termo: string;
  grupo: 'crescendo' | 'mais_buscado' | 'popular';
}

export interface CategoriaNaFoto {
  id: string;
  nome: string;
  anunciosDaMcs: number;
  maisVendidos: ItemMaisVendido[];
  tendencias: Tendencia[];
  erro?: string;
}

export interface FotoDoMercado {
  data: string; // ISO
  categorias: CategoriaNaFoto[];
}

// ---------------------------------------------------------------- partes puras (testadas)

/** O ML devolve 50 termos em ordem: 10 que mais cresceram, 20 mais buscados, 20 populares. */
export function agruparTendencias(lista: Array<{ keyword?: string }>): Tendencia[] {
  return (lista || [])
    .map((t, i) => ({
      termo: String(t?.keyword || '').trim(),
      grupo: (i < 10 ? 'crescendo' : i < 30 ? 'mais_buscado' : 'popular') as Tendencia['grupo'],
    }))
    .filter((t) => t.termo);
}

/** Aceita "MLB1234" ou texto livre. */
export function pareceIdDeCategoria(v: string): boolean {
  return /^MLB\d+$/i.test(v.trim());
}

/** Categorias da MCS em ordem de quantidade de anuncios. */
export function contarCategorias(itens: Array<{ category_id?: string | null }>, max: number): Array<{ id: string; anuncios: number }> {
  const cont = new Map<string, number>();
  for (const i of itens) if (i.category_id) cont.set(i.category_id, (cont.get(i.category_id) || 0) + 1);
  return [...cont.entries()]
    .map(([id, anuncios]) => ({ id, anuncios }))
    .sort((a, b) => b.anuncios - a.anuncios || a.id.localeCompare(b.id))
    .slice(0, max);
}

export interface MudancaNaCategoria {
  id: string;
  nome: string;
  nossos: Array<{ titulo: string | null; posicao: number; antes: number | null }>;
  nossosQueSairam: Array<{ titulo: string | null; antes: number }>;
  entraram: ItemMaisVendido[];
  subiram: Array<{ titulo: string | null; posicao: number; antes: number }>;
  tendenciasNovas: string[];
  erro?: string;
}

/** Compara a categoria entre duas fotos. Sem foto anterior, `antes` vem null e nao ha entradas/saidas. */
export function compararCategoria(atual: CategoriaNaFoto, anterior: CategoriaNaFoto | undefined): MudancaNaCategoria {
  const posAntes = new Map((anterior?.maisVendidos || []).map((m) => [m.id, m.posicao]));
  const idsAgora = new Set(atual.maisVendidos.map((m) => m.id));
  const termosAntes = new Set((anterior?.tendencias || []).map((t) => t.termo.toLowerCase()));

  return {
    id: atual.id,
    nome: atual.nome,
    nossos: atual.maisVendidos.filter((m) => m.nosso).map((m) => ({ titulo: m.titulo, posicao: m.posicao, antes: posAntes.get(m.id) ?? null })),
    nossosQueSairam: anterior
      ? anterior.maisVendidos.filter((m) => m.nosso && !idsAgora.has(m.id)).map((m) => ({ titulo: m.titulo, antes: m.posicao }))
      : [],
    entraram: anterior && anterior.maisVendidos.length ? atual.maisVendidos.filter((m) => !posAntes.has(m.id)) : [],
    subiram: anterior
      ? atual.maisVendidos
          .filter((m) => posAntes.has(m.id) && (posAntes.get(m.id) as number) - m.posicao >= 3)
          .map((m) => ({ titulo: m.titulo, posicao: m.posicao, antes: posAntes.get(m.id) as number }))
      : [],
    tendenciasNovas: anterior && anterior.tendencias.length
      ? atual.tendencias.filter((t) => t.grupo === 'crescendo' && !termosAntes.has(t.termo.toLowerCase())).map((t) => t.termo)
      : atual.tendencias.filter((t) => t.grupo === 'crescendo').map((t) => t.termo),
    ...(atual.erro ? { erro: atual.erro } : {}),
  };
}

const curto = (t: string | null, n = 60) => (!t ? '(sem título)' : t.length > n ? `${t.slice(0, n - 1)}…` : t);
const dataBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/** Texto pronto para o Telegram (sem IA). */
export function textoDoRadar(atual: FotoDoMercado, anterior: FotoDoMercado | null, mudancas: MudancaNaCategoria[]): string {
  const linhas: string[] = [];
  linhas.push(anterior ? `Comparando ${dataBr(anterior.data)} com ${dataBr(atual.data)}.` : `Primeira foto (${dataBr(atual.data)}); a comparação começa na próxima semana.`);

  for (const m of mudancas) {
    linhas.push('');
    linhas.push(`📦 ${m.nome}`);
    if (m.erro) {
      linhas.push(`  Não deu para ler: ${m.erro}`);
      continue;
    }
    if (m.nossos.length) {
      for (const n of m.nossos) {
        const seta = n.antes == null ? (anterior ? ' (entrou)' : '') : n.antes > n.posicao ? ` (subiu de ${n.antes}º)` : n.antes < n.posicao ? ` (caiu de ${n.antes}º)` : '';
        linhas.push(`  ✅ Nosso em ${n.posicao}º: ${curto(n.titulo)}${seta}`);
      }
    } else {
      linhas.push('  Nenhum produto nosso entre os 20 mais vendidos.');
    }
    for (const s of m.nossosQueSairam) linhas.push(`  ⚠️ Saiu da lista (era ${s.antes}º): ${curto(s.titulo)}`);
    if (m.entraram.length) {
      linhas.push(`  Novos na lista: ${m.entraram.slice(0, 3).map((e) => `${e.posicao}º ${curto(e.titulo, 45)}${e.preco != null ? ` (R$ ${e.preco.toFixed(2).replace('.', ',')})` : ''}`).join('; ')}`);
    }
    if (m.subiram.length) {
      linhas.push(`  Subiram forte: ${m.subiram.slice(0, 3).map((s) => `${curto(s.titulo, 45)} (${s.antes}º → ${s.posicao}º)`).join('; ')}`);
    }
    if (m.tendenciasNovas.length) linhas.push(`  Buscas em alta: ${m.tendenciasNovas.slice(0, 5).join(', ')}`);
  }
  return linhas.join('\n');
}

// ---------------------------------------------------------------- leitura no ML

const cache = new Map<string, { em: number; valor: unknown }>();
async function emCache<T>(chave: string, f: () => Promise<T>): Promise<T> {
  const c = cache.get(chave);
  if (c && Date.now() - c.em < CACHE_MS) return c.valor as T;
  const valor = await f();
  cache.set(chave, { em: Date.now(), valor });
  return valor;
}

const erroLegivel = (err: any): string =>
  err instanceof MlApiError ? `Mercado Livre respondeu ${err.status} (${err.message})` : err?.message || String(err);

/** Ids dos nossos anuncios e dos produtos de catalogo em que temos anuncio. */
async function nossosIds(): Promise<{ itens: Set<string>; produtos: Set<string>; sellerId: number; atributos: Array<{ id: string; category_id?: string; catalog_product_id?: string | null; title?: string; price?: number | null }> }> {
  return emCache('nossos', async () => {
    const sellerId = await getMlUserId();
    const ids = await getSellerItemIds(1000, false);
    const atributos = await getItemsAttributes(ids);
    return {
      sellerId,
      atributos,
      itens: new Set(atributos.map((a) => a.id)),
      produtos: new Set(atributos.map((a) => a.catalog_product_id).filter(Boolean) as string[]),
    };
  });
}

export async function nomeDaCategoria(id: string): Promise<string> {
  return emCache(`cat:${id}`, async () => {
    try {
      const c = await mlGet<any>(`/categories/${id}`);
      const caminho = (c?.path_from_root || []).map((p: any) => p?.name).filter(Boolean);
      return caminho.length > 1 ? caminho.slice(-2).join(' > ') : c?.name || id;
    } catch {
      return id;
    }
  });
}

/** Texto livre ("luminaria de led") -> categorias do ML que o proprio ML preve. */
export async function categoriasPorTexto(texto: string): Promise<Array<{ id: string; nome: string }>> {
  const r = await mlGet<any[]>(`/sites/${SITE}/domain_discovery/search?limit=3&q=${encodeURIComponent(texto)}`);
  return (r || []).filter((x) => x?.category_id).map((x) => ({ id: x.category_id, nome: x.category_name || x.domain_name || x.category_id }));
}

async function resolverCategoria(entrada: string): Promise<{ id: string; nome: string } | null> {
  if (pareceIdDeCategoria(entrada)) return { id: entrada.toUpperCase(), nome: await nomeDaCategoria(entrada.toUpperCase()) };
  const achadas = await categoriasPorTexto(entrada);
  return achadas[0] ?? null;
}

/** Os 20 mais vendidos de uma categoria, com titulo/preco e marcando o que e nosso. */
export async function maisVendidosDaCategoria(categoriaId: string): Promise<ItemMaisVendido[]> {
  return emCache(`hl:${categoriaId}`, async () => {
    const r = await mlGet<any>(`/highlights/${SITE}/category/${categoriaId}`);
    const conteudo: any[] = Array.isArray(r?.content) ? r.content : [];
    const nossos = await nossosIds().catch(() => null);

    const itensIds = conteudo.filter((c) => c?.type === 'ITEM').map((c) => String(c.id));
    const atributos = new Map((itensIds.length ? await getItemsAttributes(itensIds).catch(() => []) : []).map((a) => [a.id, a]));

    const saida: ItemMaisVendido[] = [];
    for (const c of conteudo) {
      const id = String(c?.id || '');
      if (!id) continue;
      const tipo = String(c?.type || '');
      let titulo: string | null = null;
      let preco: number | null = null;
      let link: string | null = null;
      let nosso = false;
      if (tipo === 'ITEM') {
        const a = atributos.get(id);
        titulo = a?.title ?? null;
        preco = a?.price ?? null;
        link = a?.permalink ?? null;
        nosso = !!nossos?.itens.has(id) || (!!nossos && a?.seller_id === nossos.sellerId);
      } else {
        // PRODUCT (catalogo). USER_PRODUCT tambem costuma responder em /products; se nao, fica so o id.
        try {
          const p = await emCache(`prod:${id}`, () => mlGet<any>(`/products/${id}`));
          titulo = p?.name ?? null;
          preco = p?.buy_box_winner?.price ?? null;
          link = p?.permalink ?? null;
          nosso = !!nossos?.produtos.has(id) || (!!nossos && p?.buy_box_winner?.seller_id === nossos.sellerId);
        } catch {
          nosso = !!nossos?.produtos.has(id);
        }
      }
      saida.push({ posicao: Number(c?.position) || saida.length + 1, id, tipo, titulo, preco, nosso, link });
    }
    return saida.sort((a, b) => a.posicao - b.posicao);
  });
}

export async function tendencias(categoriaId?: string): Promise<Tendencia[]> {
  return emCache(`tr:${categoriaId || ''}`, async () => {
    const r = await mlGet<any[]>(`/trends/${SITE}${categoriaId ? `/${categoriaId}` : ''}`);
    return agruparTendencias(Array.isArray(r) ? r : []);
  });
}

// ---------------------------------------------------------------- fotos semanais

export function lerFotos(): FotoDoMercado[] {
  try {
    const j = JSON.parse(fs.readFileSync(config.mercadoFotosPath, 'utf-8'));
    return Array.isArray(j?.fotos) ? j.fotos : [];
  } catch {
    return [];
  }
}

function salvarFotos(fotos: FotoDoMercado[]): void {
  fs.mkdirSync(path.dirname(config.mercadoFotosPath), { recursive: true });
  const tmp = `${config.mercadoFotosPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ fotos: fotos.slice(-config.mercadoFotosRetencao) }, null, 1), 'utf-8');
  fs.renameSync(tmp, config.mercadoFotosPath);
}

export async function categoriasDaMcs(): Promise<Array<{ id: string; nome: string; anuncios: number }>> {
  const n = await nossosIds();
  const top = contarCategorias(n.atributos, config.mercadoMaxCategorias);
  const out = [];
  for (const c of top) out.push({ ...c, nome: await nomeDaCategoria(c.id) });
  return out;
}

let tirandoFoto: Promise<FotoDoMercado> | null = null;

export function tirarFoto(): Promise<FotoDoMercado> {
  if (tirandoFoto) return tirandoFoto;
  tirandoFoto = (async () => {
    cache.clear(); // a foto precisa do dado de agora, nao do cache de ate 1h
    const categorias: CategoriaNaFoto[] = [];
    for (const c of await categoriasDaMcs()) {
      const cat: CategoriaNaFoto = { id: c.id, nome: c.nome, anunciosDaMcs: c.anuncios, maisVendidos: [], tendencias: [] };
      try {
        cat.maisVendidos = await maisVendidosDaCategoria(c.id);
      } catch (err) {
        cat.erro = `mais vendidos: ${erroLegivel(err)}`;
      }
      try {
        cat.tendencias = await tendencias(c.id);
      } catch (err) {
        cat.erro = [cat.erro, `tendências: ${erroLegivel(err)}`].filter(Boolean).join('; ');
      }
      categorias.push(cat);
    }
    const foto: FotoDoMercado = { data: new Date().toISOString(), categorias };
    salvarFotos([...lerFotos(), foto]);
    logger.info(`[MERCADO] Foto do mercado guardada (${categorias.length} categoria(s)).`);
    return foto;
  })().finally(() => {
    tirandoFoto = null;
  });
  return tirandoFoto;
}

/** Hora/dia da semana em Brasilia. Pura. */
export function agoraEmBrasilia(agora: Date): { hora: number; dia: string; diaDaSemana: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    })
      .formatToParts(agora)
      .map((x) => [x.type, x.value]),
  );
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hora: Number(p.hour), dia: `${p.year}-${p.month}-${p.day}`, diaDaSemana: dias[p.weekday] ?? -1 };
}

/**
 * Tira foto quando: nao ha nenhuma; a ultima tem 7 dias ou mais; ou e segunda a partir das 6h (Brasilia)
 * e ainda nao houve foto hoje — assim o radar das 9h de segunda do Gerente sempre pega a semana fechada.
 */
export function deveTirarFoto(agora: Date, ultima: string | null): boolean {
  if (!ultima) return true;
  if (agora.getTime() - new Date(ultima).getTime() >= 7 * 24 * 3600 * 1000) return true;
  const a = agoraEmBrasilia(agora);
  return a.diaDaSemana === 1 && a.hora >= 6 && agoraEmBrasilia(new Date(ultima)).dia !== a.dia;
}

export function startMercadoLoop(): void {
  const run = async () => {
    if (!getMlAuthStatus().authenticated) return;
    const fotos = lerFotos();
    if (!deveTirarFoto(new Date(), fotos.at(-1)?.data ?? null)) return;
    try {
      await tirarFoto();
    } catch (err: any) {
      logger.warn('[MERCADO] Falha na foto semanal:', erroLegivel(err));
    }
  };
  setTimeout(() => void run(), 90_000).unref();
  setInterval(() => void run(), 60 * 60 * 1000).unref();
  logger.info('[MERCADO] Foto semanal do mercado ligada (segunda a partir das 6h, horário de Brasília).');
}

// ---------------------------------------------------------------- consultas (ferramentas)

const limitar = (v: unknown, padrao: number, teto: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(teto, Math.max(1, Math.trunc(n))) : padrao;
};

export async function consultaMaisVendidos(entrada: { categoria?: string; limite?: number }): Promise<unknown> {
  const limite = limitar(entrada?.limite, 20, 20);
  try {
    if (!entrada?.categoria) {
      const cats = await categoriasDaMcs();
      return {
        mensagem: 'Sem categoria informada: estas sao as categorias com mais anuncios da MCS. Peça de novo com uma delas (id ou nome).',
        categoriasDaMcs: cats,
      };
    }
    const cat = await resolverCategoria(entrada.categoria);
    if (!cat) return { disponivel: false, mensagem: `Nao achei categoria do ML para "${entrada.categoria}".` };
    const lista = await maisVendidosDaCategoria(cat.id);
    return {
      categoria: cat,
      observacao: 'Ordem da lista de mais vendidos do ML. O ML nao informa quantas unidades cada um vendeu.',
      nossosNaLista: lista.filter((m) => m.nosso).map((m) => ({ posicao: m.posicao, titulo: m.titulo })),
      itens: lista.slice(0, limite),
    };
  } catch (err) {
    return { disponivel: false, erro: erroLegivel(err) };
  }
}

export async function consultaTendencias(entrada: { categoria?: string }): Promise<unknown> {
  try {
    const cat = entrada?.categoria ? await resolverCategoria(entrada.categoria) : null;
    if (entrada?.categoria && !cat) return { disponivel: false, mensagem: `Nao achei categoria do ML para "${entrada.categoria}".` };
    const t = await tendencias(cat?.id);
    return {
      categoria: cat ?? { id: SITE, nome: 'Mercado Livre inteiro' },
      observacao: 'Termos da semana segundo o ML. crescendo = os que mais cresceram; mais_buscado; popular.',
      crescendo: t.filter((x) => x.grupo === 'crescendo').map((x) => x.termo),
      maisBuscados: t.filter((x) => x.grupo === 'mais_buscado').map((x) => x.termo),
      populares: t.filter((x) => x.grupo === 'popular').map((x) => x.termo),
    };
  } catch (err) {
    return { disponivel: false, erro: erroLegivel(err) };
  }
}

/** Vendedores de um produto de catalogo. Aceita nosso anuncio (MLB...) ou o id do produto. */
export async function consultaConcorrencia(entrada: { anuncio?: string; produto?: string; limite?: number }): Promise<unknown> {
  const limite = limitar(entrada?.limite, 15, 40);
  try {
    let produtoId = entrada?.produto?.trim().toUpperCase() || '';
    let nossoPreco: number | null = null;
    let nossoTitulo: string | null = null;
    if (!produtoId && entrada?.anuncio) {
      const [a] = await getItemsAttributes([entrada.anuncio.trim().toUpperCase()]);
      if (!a) return { disponivel: false, mensagem: `Anuncio ${entrada.anuncio} nao encontrado.` };
      nossoPreco = a.price ?? null;
      nossoTitulo = a.title ?? null;
      if (!a.catalog_product_id) {
        return {
          disponivel: false,
          mensagem: 'Esse anuncio nao esta ligado a um produto de catalogo do ML, entao o ML nao lista os concorrentes. Use mercado_busca com o nome do produto.',
          anuncio: { id: a.id, titulo: a.title, preco: a.price },
        };
      }
      produtoId = a.catalog_product_id;
    }
    if (!produtoId) return { disponivel: false, mensagem: 'Informe o anuncio (MLB...) ou o produto de catalogo.' };

    const nossos = await nossosIds().catch(() => null);
    const [produto, r] = await Promise.all([
      emCache(`prod:${produtoId}`, () => mlGet<any>(`/products/${produtoId}`)).catch(() => null),
      mlGet<any>(`/products/${produtoId}/items?limit=100`),
    ]);
    const resultados: any[] = Array.isArray(r?.results) ? r.results : [];
    const ordenados = [...resultados].sort((a, b) => (a?.price ?? Infinity) - (b?.price ?? Infinity));
    const vendedores = [];
    for (const [i, x] of ordenados.slice(0, limite).entries()) {
      vendedores.push({
        posicaoPorPreco: i + 1,
        anuncio: x?.item_id ?? null,
        vendedor: x?.seller_id ? await getSellerNickname(x.seller_id) : null,
        preco: x?.price ?? null,
        precoOriginal: x?.original_price ?? null,
        freteGratis: x?.shipping?.free_shipping ?? null,
        full: x?.shipping?.logistic_type === 'fulfillment',
        tipo: x?.listing_type_id === 'gold_pro' ? 'Premium' : x?.listing_type_id === 'gold_special' ? 'Clássico' : x?.listing_type_id ?? null,
        nosso: !!nossos && (nossos.itens.has(x?.item_id) || x?.seller_id === nossos.sellerId),
      });
    }
    const precos = resultados.map((x) => x?.price).filter((p) => typeof p === 'number') as number[];
    const menor = precos.length ? Math.min(...precos) : null;
    const nosso = vendedores.find((v) => v.nosso);
    if (nossoPreco == null && nosso) nossoPreco = nosso.preco;
    return {
      produto: { id: produtoId, nome: produto?.name ?? nossoTitulo, ganhandoAgora: produto?.buy_box_winner ? { anuncio: produto.buy_box_winner.item_id, preco: produto.buy_box_winner.price } : null },
      totalDeVendedores: r?.paging?.total ?? resultados.length,
      menorPreco: menor,
      nossoPreco,
      diferencaParaOMenor: nossoPreco != null && menor != null ? Math.round((nossoPreco - menor) * 100) / 100 : null,
      vendedores,
    };
  } catch (err) {
    return { disponivel: false, erro: erroLegivel(err) };
  }
}

export async function consultaBusca(entrada: { termo?: string; limite?: number }): Promise<unknown> {
  const termo = String(entrada?.termo || '').trim();
  if (!termo) return { disponivel: false, mensagem: 'Informe o termo de busca.' };
  const limite = limitar(entrada?.limite, 10, 30);
  const q = encodeURIComponent(termo);
  try {
    const r = await mlGet<any>(`/sites/${SITE}/search?q=${q}&limit=${limite}`);
    const nossos = await nossosIds().catch(() => null);
    return {
      fonte: 'busca do Mercado Livre',
      total: r?.paging?.total ?? null,
      resultados: (r?.results || []).map((x: any, i: number) => ({
        posicao: i + 1,
        anuncio: x?.id,
        titulo: x?.title,
        preco: x?.price,
        vendedor: x?.seller?.nickname ?? x?.seller?.id ?? null,
        freteGratis: x?.shipping?.free_shipping ?? null,
        produtoDeCatalogo: x?.catalog_product_id ?? null,
        nosso: !!nossos && (nossos.itens.has(x?.id) || x?.seller?.id === nossos.sellerId),
      })),
    };
  } catch (err) {
    if (!(err instanceof MlApiError) || (err.status !== 403 && err.status !== 401)) return { disponivel: false, erro: erroLegivel(err) };
  }
  // A busca publica foi fechada para muitos apps: cai para o catalogo.
  try {
    const r = await mlGet<any>(`/products/search?status=active&site_id=${SITE}&q=${q}&limit=${limite}`);
    return {
      fonte: 'catalogo do Mercado Livre (a busca normal esta bloqueada para este app)',
      observacao: 'Sao produtos de catalogo, nao anuncios. Para ver vendedores e precos de um deles, use mercado_concorrencia com produto=<id>.',
      total: r?.paging?.total ?? null,
      resultados: (r?.results || []).map((x: any, i: number) => ({ posicao: i + 1, produto: x?.id, nome: x?.name, dominio: x?.domain_id ?? null })),
    };
  } catch (err) {
    return { disponivel: false, erro: erroLegivel(err) };
  }
}

/** Radar: compara a ultima foto com a anterior. resumoEmTexto vai pronto pro Telegram. */
export function consultaRadar(): unknown {
  const fotos = lerFotos();
  const atual = fotos.at(-1);
  if (!atual) return { disponivel: false, mensagem: 'Ainda nao ha foto do mercado (a primeira sai alguns minutos depois que o servico sobe com o ML conectado).' };
  const anterior = fotos.length > 1 ? fotos[fotos.length - 2] : null;
  const mudancas = atual.categorias.map((c) => compararCategoria(c, anterior?.categorias.find((x) => x.id === c.id)));
  return {
    fotoAtual: atual.data,
    fotoAnterior: anterior?.data ?? null,
    categorias: mudancas,
    resumoEmTexto: textoDoRadar(atual, anterior, mudancas),
  };
}

/** /debug/mercado: resposta crua de cada rota do ML, para conferir o formato no primeiro teste. */
export async function sondarMercado(categoria?: string, termo = 'luminaria'): Promise<unknown> {
  const tentar = async (rota: string) => {
    try {
      const r = await mlGet<any>(rota);
      return { rota, ok: true, amostra: JSON.stringify(r).slice(0, 1500) };
    } catch (err) {
      return { rota, ok: false, erro: erroLegivel(err) };
    }
  };
  let cat = categoria;
  if (!cat) cat = (await categoriasDaMcs().catch(() => []))[0]?.id;
  const q = encodeURIComponent(termo);
  return {
    categoriaUsada: cat ?? null,
    respostas: await Promise.all([
      cat ? tentar(`/highlights/${SITE}/category/${cat}`) : null,
      tentar(`/trends/${SITE}${cat ? `/${cat}` : ''}`),
      tentar(`/sites/${SITE}/search?q=${q}&limit=2`),
      tentar(`/products/search?status=active&site_id=${SITE}&q=${q}&limit=2`),
      tentar(`/sites/${SITE}/domain_discovery/search?limit=2&q=${q}`),
    ]),
  };
}
