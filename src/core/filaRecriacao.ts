import { config } from '../config';

/**
 * FILA DE ANUNCIOS COM NOTA BAIXA — o que fazer com cada um, em ordem.
 *
 * A varredura de notas ja dizia SE recriar zera a pontuacao. Isso responde metade da pergunta: a
 * outra metade e se COMPENSA. Recriar joga fora historico de vendas, posicionamento na busca e as
 * avaliacoes boas junto com as ruins — e ate agora essa conta ficava na cabeca de quem decide,
 * anuncio por anuncio.
 *
 * Aqui as duas metades ficam lado a lado: o veredicto tecnico, o dinheiro que o anuncio movimenta
 * hoje, e quantas avaliacoes boas resolveriam a nota SEM recriar nada.
 */

export type Acao = 'nao_recriar' | 'recuperar_por_avaliacao' | 'recriar' | 'recriar_com_cautela' | 'sondar';

export interface LinhaDaFila {
  itemId: string;
  titulo: string;
  permalink: string | null;
  nota: number | null;
  totalAvaliacoes: number | null;
  classificacao: string;
  evidencia: string;
  chaveDoPool: string | null;
  /** Liquido dos ultimos 30 dias. NAO e prejuizo: e o que a recriacao poe em risco. */
  liquidoEmRisco: number;
  unidades: number;
  margem: number | null;
  estoque: number | null;
  /** Quantas notas 5 levariam a media de volta ao limite, sem recriar. */
  avaliacoesParaRecuperar: number | null;
  acao: Acao;
  porque: string;
}

/**
 * Quantas avaliacoes 5 estrelas seriam necessarias pra media voltar ao limite.
 *
 * Sai de: (soma_atual + 5x) / (N + x) >= t  =>  x >= N(t - a) / (5 - t)
 *
 * E o numero que decide entre recriar e recuperar. Com nota 4,0 e limite 4,5, x = N: um anuncio de
 * 4 opinioes precisa de 4 avaliacoes boas — trivial. Um de 1.862 precisa de 1.862 — impossivel.
 * Sem essa conta, os dois casos parecem o mesmo problema.
 */
export function avaliacoesParaRecuperar(nota: number | null, total: number | null, limite: number): number | null {
  if (nota == null || total == null || total <= 0) return null;
  if (nota >= limite) return null;
  if (limite >= 5) return null;
  return Math.ceil((total * (limite - nota)) / (5 - limite));
}

export interface Limiares {
  /** Ate quantas avaliacoes boas ainda vale tentar recuperar em vez de recriar. */
  recuperavelAte: number;
  /** A partir de quanto de liquido mensal a recriacao passa a exigir cautela. */
  liquidoAlto: number;
}

export const LIMIARES_PADRAO: Limiares = { recuperavelAte: 15, liquidoAlto: 2000 };

const reais = (v: number): string =>
  'R$ ' + v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Decide a acao. Funcao PURA — e a regra de negocio inteira, e merece teste em vez de confianca.
 *
 * A ordem das regras importa: "nao adianta" vem antes de "compensa", porque nao faz sentido pesar
 * custo de uma acao que nao produz efeito nenhum.
 */
export function recomendar(
  classificacao: string,
  avaliacoesNecessarias: number | null,
  liquidoEmRisco: number,
  limiares: Limiares = LIMIARES_PADRAO,
): { acao: Acao; porque: string } {
  if (classificacao === 'preso_ao_catalogo') {
    return {
      acao: 'nao_recriar',
      porque:
        'As opinioes pertencem ao produto do catalogo, compartilhado com outros vendedores. Recriar nao zera nada — ' +
        'so custaria o historico.',
    };
  }

  // Recuperar vem ANTES de recriar E antes de sondar: quando poucas avaliacoes resolvem, nao
  // importa muito se recriar zeraria — o caminho barato ja existe. Isso tambem cobre o anuncio de
  // 1 ou 2 opinioes, que antes sumia da lista por nao ter opiniao suficiente pra ser classificado.
  if (avaliacoesNecessarias != null && avaliacoesNecessarias <= limiares.recuperavelAte) {
    return {
      acao: 'recuperar_por_avaliacao',
      porque:
        `Bastam ${avaliacoesNecessarias} avaliacao(oes) 5 estrelas pra nota voltar ao limite. Sai mais barato que ` +
        'recriar, e preserva historico, posicionamento e as avaliacoes boas.',
    };
  }

  if (classificacao !== 'recriavel' && classificacao !== 'depende_do_user_product') {
    return {
      acao: 'sondar',
      porque:
        'Nao ha evidencia suficiente pra afirmar se recriar zera. A sondagem cria um clone pausado, compara o ' +
        'produto do usuario e descarta em seguida — responde sem estragar nada.',
    };
  }

  if (liquidoEmRisco >= limiares.liquidoAlto) {
    return {
      acao: 'recriar_com_cautela',
      porque:
        `Recriar zera a nota, mas este anuncio movimentou ${reais(liquidoEmRisco)} em 30 dias. O anuncio novo comeca ` +
        'do zero em historico e posicionamento — decida sabendo que essa receita fica em risco.',
    };
  }

  return {
    acao: 'recriar',
    porque:
      `Recriar zera a nota e o que fica em risco e pequeno (${reais(liquidoEmRisco)} em 30 dias). ` +
      'Caso mais confortavel da fila.',
  };
}

/** Acoes que pedem algo de quem opera. As que nao pedem vao pro fim da fila. */
const ACIONAVEL: Record<Acao, number> = {
  recriar: 0,
  recriar_com_cautela: 0,
  recuperar_por_avaliacao: 0,
  sondar: 1,
  nao_recriar: 2,
};

export interface EntradaDeNota {
  itemId: string;
  title?: string;
  permalink?: string;
  nota: number | null;
  totalAvaliacoes: number | null;
  classificacao: string;
  evidencia: string;
  chaveDoPool?: string | null;
  disponivel?: number | null;
}

export interface DadosDeDinheiro {
  liquido: number;
  unidades: number;
  margem: number | null;
}

/**
 * Monta a fila. Funcao pura: recebe as notas e o dinheiro ja apurados, devolve a ordem de trabalho.
 *
 * Ordena por acionavel primeiro e, dentro de cada grupo, por dinheiro. So por dinheiro, o topo da
 * lista encheria de anuncios onde nao ha nada a fazer — que sao justamente os de catalogo, os que
 * mais vendem.
 */
export function montarFila(
  notas: EntradaDeNota[],
  dinheiro: Map<string, DadosDeDinheiro>,
  limite = config.ratingsMinScore,
  limiares: Limiares = LIMIARES_PADRAO,
): LinhaDaFila[] {
  const linhas = notas.map((n) => {
    const d = dinheiro.get(n.itemId);
    const liquidoEmRisco = Math.round((d?.liquido ?? 0) * 100) / 100;
    const necessarias = avaliacoesParaRecuperar(n.nota, n.totalAvaliacoes, limite);
    const { acao, porque } = recomendar(n.classificacao, necessarias, liquidoEmRisco, limiares);

    return {
      itemId: n.itemId,
      titulo: n.title || n.itemId,
      permalink: n.permalink ?? null,
      nota: n.nota,
      totalAvaliacoes: n.totalAvaliacoes,
      classificacao: n.classificacao,
      evidencia: n.evidencia,
      chaveDoPool: n.chaveDoPool ?? null,
      liquidoEmRisco,
      unidades: d?.unidades ?? 0,
      margem: d?.margem ?? null,
      estoque: n.disponivel ?? null,
      avaliacoesParaRecuperar: necessarias,
      acao,
      porque,
    };
  });

  return linhas.sort((a, b) => {
    const grupo = ACIONAVEL[a.acao] - ACIONAVEL[b.acao];
    return grupo !== 0 ? grupo : b.liquidoEmRisco - a.liquidoEmRisco;
  });
}

export interface ResumoDaFila {
  total: number;
  porAcao: Record<string, number>;
  /** Faturamento reunido nos anuncios em que HA o que fazer — o tamanho real da oportunidade. */
  liquidoAcionavel: number;
  liquidoSemSaida: number;
}

export function resumirFila(fila: LinhaDaFila[]): ResumoDaFila {
  const porAcao: Record<string, number> = {};
  let liquidoAcionavel = 0;
  let liquidoSemSaida = 0;

  for (const l of fila) {
    porAcao[l.acao] = (porAcao[l.acao] ?? 0) + 1;
    if (ACIONAVEL[l.acao] === 0) liquidoAcionavel += l.liquidoEmRisco;
    else if (l.acao === 'nao_recriar') liquidoSemSaida += l.liquidoEmRisco;
  }

  return {
    total: fila.length,
    porAcao,
    liquidoAcionavel: Math.round(liquidoAcionavel * 100) / 100,
    liquidoSemSaida: Math.round(liquidoSemSaida * 100) / 100,
  };
}
