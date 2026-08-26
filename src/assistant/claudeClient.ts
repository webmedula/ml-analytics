import { config } from '../config';
import { logger } from '../logger';
import { executarFerramenta } from './ferramentas';
import { provedorAtivo } from './provedores';

/**
 * Conduz a conversa com o modelo usando FERRAMENTAS, seja qual for o provedor.
 *
 * O modelo nunca recebe a base inteira: ele decide qual funcao chamar, o codigo executa e devolve o
 * resultado. O texto final e so a redacao — os numeros ja vieram prontos.
 */

const SISTEMA = `Voce e o assistente de analise da operacao de um vendedor no Mercado Livre, integrado ao ERP Tiny.

REGRAS:
- Todo numero que voce disser tem que ter vindo de uma ferramenta. Nunca estime, arredonde por conta
  propria nem complete o que faltou. Se a ferramenta nao trouxe o dado, diga que nao tem.
- "Liquido" = venda menos comissao do ML menos frete pago pelo vendedor. "Margem" = liquido menos o
  custo do produto. Sao coisas diferentes; nao troque uma pela outra.
- Margem so existe para anuncios com custo cadastrado no Tiny. Quando faltar, diga que falta e por
  que (a ferramenta informa), em vez de omitir o anuncio em silencio.
- Ao comparar ou recomendar, diga em que numero voce se baseou.
- Responda em portugues do Brasil, direto, no tom de quem conversa com o dono da loja. Voce esta no
  Telegram: seja curto. Valores em R$ com duas casas. No maximo uns 6 itens por lista.
- Nao use tabela nem markdown pesado: o Telegram nao renderiza bem. Listas com hifen funcionam.
- Voce so LE dados. Nao altera anuncio, preco nem estoque. Se pedirem isso, explique que a alteracao
  precisa ser feita por quem opera.`;

export async function listarModelos(): Promise<Array<{ id: string; detalhe?: string }>> {
  return provedorAtivo().listarModelos();
}

export async function resolverModelo(forcar = false): Promise<string> {
  return provedorAtivo().resolverModelo(forcar);
}

export interface RespostaDoAssistente {
  texto: string;
  ferramentasUsadas: string[];
  passos: number;
  provedor: string;
  modelo: string;
}

/** Roda a conversa ate o modelo parar de pedir ferramenta, com teto de passos. */
export async function perguntar(pergunta: string): Promise<RespostaDoAssistente> {
  const provedor = provedorAtivo();
  if (!provedor.configurado()) {
    throw new Error(`Provedor "${provedor.nome}" sem chave configurada. Veja /debug/assistente.`);
  }

  const modelo = await provedor.resolverModelo();
  const mensagens: any[] = [provedor.mensagemDoUsuario(pergunta)];
  const usadas: string[] = [];

  for (let passo = 1; passo <= config.assistenteMaxPassos; passo++) {
    const r = await provedor.conversar(mensagens, modelo, SISTEMA);

    if (r.chamadas.length === 0) {
      return {
        texto: r.texto || 'Nao consegui formular uma resposta.',
        ferramentasUsadas: usadas,
        passos: passo,
        provedor: provedor.nome,
        modelo,
      };
    }

    mensagens.push(r.mensagemDoAssistente);

    const resultados = [];
    for (const chamada of r.chamadas) {
      usadas.push(chamada.nome);
      let saida: unknown;
      try {
        saida = await executarFerramenta(chamada.nome, chamada.entrada);
      } catch (err: any) {
        // Erro vira resultado, nao excecao: o modelo consegue explicar a falha ao usuario, e uma
        // ferramenta quebrada nao derruba a conversa inteira.
        saida = { erro: err?.message || String(err) };
      }
      resultados.push({ chamada, saida });
    }

    mensagens.push(...provedor.mensagensDeResultado(resultados));
  }

  logger.warn(`[ASSISTENTE] Teto de ${config.assistenteMaxPassos} passos atingido: "${pergunta.slice(0, 60)}"`);
  return {
    texto: 'A consulta ficou longa demais e eu parei no meio. Tenta perguntar de forma mais especifica.',
    ferramentasUsadas: usadas,
    passos: config.assistenteMaxPassos,
    provedor: provedor.nome,
    modelo,
  };
}
