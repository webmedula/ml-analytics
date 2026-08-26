import { config } from '../config';
import { DefinicaoDeFerramenta, FERRAMENTAS } from './ferramentas';

/**
 * DOIS PROVEDORES, UM LOOP.
 *
 * Anthropic e OpenRouter falam formatos diferentes de tool calling: a Anthropic devolve blocos
 * `tool_use` e recebe `tool_result` dentro de uma mensagem do usuario; o OpenRouter segue o padrao
 * OpenAI, com `tool_calls` no assistente e uma mensagem `role: "tool"` por resultado.
 *
 * A diferenca fica presa aqui. Quem conduz a conversa nao sabe qual dos dois esta atendendo — e e
 * isso que permite trocar de provedor por variavel de ambiente, sem tocar nas ferramentas.
 */

export interface ChamadaDeFerramenta {
  id: string;
  nome: string;
  entrada: any;
}

export interface PassoDoModelo {
  texto: string;
  chamadas: ChamadaDeFerramenta[];
  /** Mensagem do assistente no formato do provedor, pra devolver no historico. */
  mensagemDoAssistente: any;
}

export interface Provedor {
  nome: string;
  configurado(): boolean;
  /** Modelos que servem para ESTE uso (precisam saber chamar ferramenta). */
  listarModelos(): Promise<Array<{ id: string; detalhe?: string }>>;
  resolverModelo(forcar?: boolean): Promise<string>;
  mensagemDoUsuario(texto: string): any;
  conversar(mensagens: any[], modelo: string, sistema: string): Promise<PassoDoModelo>;
  mensagensDeResultado(resultados: Array<{ chamada: ChamadaDeFerramenta; saida: unknown }>): any[];
}

/** Resultados no formato Anthropic: TODOS dentro de uma unica mensagem do usuario. */
export function resultadosNoFormatoAnthropic(
  resultados: Array<{ chamada: ChamadaDeFerramenta; saida: unknown }>,
): any[] {
  return [{
    role: 'user',
    content: resultados.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.chamada.id,
      content: JSON.stringify(r.saida),
    })),
  }];
}

/** Resultados no formato OpenAI/OpenRouter: UMA mensagem por resultado, com role "tool". */
export function resultadosNoFormatoOpenAi(
  resultados: Array<{ chamada: ChamadaDeFerramenta; saida: unknown }>,
): any[] {
  return resultados.map((r) => ({
    role: 'tool',
    tool_call_id: r.chamada.id,
    name: r.chamada.nome,
    content: JSON.stringify(r.saida),
  }));
}

export function ferramentasNoFormatoOpenAi(fs: DefinicaoDeFerramenta[]) {
  return fs.map((f) => ({
    type: 'function',
    function: { name: f.name, description: f.description, parameters: f.input_schema },
  }));
}

async function json(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------- Anthropic

class ProvedorAnthropic implements Provedor {
  nome = 'anthropic';
  private escolhido: string | null = null;

  configurado(): boolean {
    return Boolean(config.anthropicApiKey);
  }

  private cabecalhos(): Record<string, string> {
    return {
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': config.anthropicVersion,
      'content-type': 'application/json',
    };
  }

  async listarModelos(): Promise<Array<{ id: string }>> {
    const res = await fetch(`${config.anthropicBaseUrl}/v1/models?limit=20`, { headers: this.cabecalhos() });
    const corpo = await json(res);
    if (!res.ok) throw new Error(corpo?.error?.message || `Erro HTTP ${res.status} ao listar modelos.`);
    return (corpo?.data ?? []).map((m: any) => ({ id: m.id }));
  }

  /** Sem modelo fixado, pergunta a API. Id de modelo envelhece; fixar no codigo so adia o erro. */
  async resolverModelo(forcar = false): Promise<string> {
    if (config.assistenteModelo) return config.assistenteModelo;
    if (this.escolhido && !forcar) return this.escolhido;

    const ids = (await this.listarModelos()).map((m) => m.id);
    if (ids.length === 0) throw new Error('A API nao devolveu nenhum modelo para esta chave.');
    this.escolhido = ids.find((id) => /sonnet/i.test(id)) ?? ids[0];
    return this.escolhido;
  }

  mensagemDoUsuario(texto: string): any {
    return { role: 'user', content: texto };
  }

  async conversar(mensagens: any[], modelo: string, sistema: string): Promise<PassoDoModelo> {
    const res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.cabecalhos(),
      body: JSON.stringify({
        model: modelo,
        max_tokens: config.assistenteMaxTokens,
        system: sistema,
        tools: FERRAMENTAS,
        messages: mensagens,
      }),
    });

    const corpo = await json(res);
    if (!res.ok) throw new Error(corpo?.error?.message || `Erro HTTP ${res.status} na API da Anthropic.`);

    const blocos: any[] = corpo?.content ?? [];
    return {
      texto: blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      chamadas: blocos
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, nome: b.name, entrada: b.input })),
      mensagemDoAssistente: { role: 'assistant', content: blocos },
    };
  }

  mensagensDeResultado(resultados: Array<{ chamada: ChamadaDeFerramenta; saida: unknown }>): any[] {
    return resultadosNoFormatoAnthropic(resultados);
  }
}

// --------------------------------------------------------------- OpenRouter

class ProvedorOpenRouter implements Provedor {
  nome = 'openrouter';

  configurado(): boolean {
    return Boolean(config.openrouterApiKey);
  }

  private cabecalhos(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'content-type': 'application/json',
      // Identificacao opcional do app; o OpenRouter usa nos rankings dele.
      'X-Title': 'ml-analytics',
    };
  }

  /**
   * So devolve modelos que declaram suporte a ferramenta.
   *
   * O catalogo do OpenRouter tem centenas de modelos e muitos NAO chamam funcao — inclusive parte
   * dos gratuitos. Escolher um desses nao daria erro claro: o modelo ignoraria as ferramentas e
   * responderia de cabeca, que e exatamente o comportamento que este desenho existe pra impedir.
   */
  async listarModelos(): Promise<Array<{ id: string; detalhe?: string }>> {
    const res = await fetch(`${config.openrouterBaseUrl}/models`, { headers: this.cabecalhos() });
    const corpo = await json(res);
    if (!res.ok) throw new Error(corpo?.error?.message || `Erro HTTP ${res.status} ao listar modelos.`);

    return (corpo?.data ?? [])
      .filter((m: any) => Array.isArray(m?.supported_parameters) && m.supported_parameters.includes('tools'))
      .map((m: any) => {
        const entrada = Number(m?.pricing?.prompt ?? 0) * 1_000_000;
        const saida = Number(m?.pricing?.completion ?? 0) * 1_000_000;
        return {
          id: m.id,
          detalhe: entrada === 0 && saida === 0
            ? 'gratuito'
            : `US$ ${entrada.toFixed(2)} entrada / ${saida.toFixed(2)} saida por milhao de tokens`,
        };
      });
  }

  async resolverModelo(): Promise<string> {
    if (config.assistenteModelo) return config.assistenteModelo;
    throw new Error(
      'Com OpenRouter e obrigatorio definir ASSISTENTE_MODELO: o catalogo tem centenas de modelos e ' +
      'escolher por conta seria loteria de preco e de qualidade. Abra /debug/assistente pra ver os que ' +
      'suportam ferramenta e copie um id.',
    );
  }

  mensagemDoUsuario(texto: string): any {
    return { role: 'user', content: texto };
  }

  async conversar(mensagens: any[], modelo: string, sistema: string): Promise<PassoDoModelo> {
    const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.cabecalhos(),
      body: JSON.stringify({
        model: modelo,
        max_tokens: config.assistenteMaxTokens,
        // No padrao OpenAI o sistema e a primeira mensagem, nao um campo separado.
        messages: [{ role: 'system', content: sistema }, ...mensagens],
        tools: ferramentasNoFormatoOpenAi(FERRAMENTAS),
      }),
    });

    const corpo = await json(res);
    if (!res.ok) throw new Error(corpo?.error?.message || `Erro HTTP ${res.status} no OpenRouter.`);

    const msg = corpo?.choices?.[0]?.message;
    if (!msg) throw new Error('O OpenRouter respondeu sem mensagem. Verifique se o modelo escolhido aceita ferramentas.');

    const chamadas: ChamadaDeFerramenta[] = (msg.tool_calls ?? []).map((c: any, i: number) => {
      let entrada: any = {};
      try {
        // No padrao OpenAI os argumentos vem como STRING JSON, e um modelo fraco as vezes manda
        // string quebrada. Melhor seguir com entrada vazia que derrubar a conversa.
        entrada = c?.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        entrada = {};
      }
      return { id: c?.id || `call_${i}`, nome: c?.function?.name, entrada };
    });

    return {
      texto: typeof msg.content === 'string' ? msg.content.trim() : '',
      chamadas,
      mensagemDoAssistente: msg,
    };
  }

  mensagensDeResultado(resultados: Array<{ chamada: ChamadaDeFerramenta; saida: unknown }>): any[] {
    return resultadosNoFormatoOpenAi(resultados);
  }
}

const anthropic = new ProvedorAnthropic();
const openrouter = new ProvedorOpenRouter();

/**
 * Escolhe o provedor. Explicito por ASSISTENTE_PROVEDOR; senao, quem tiver chave configurada.
 * Com as duas chaves presentes e nenhuma escolha, fica com o OpenRouter — quem configurou as duas
 * provavelmente quer a que cobra mais barato.
 */
export function provedorAtivo(): Provedor {
  const escolhido = config.assistenteProvedor.toLowerCase();
  if (escolhido === 'anthropic') return anthropic;
  if (escolhido === 'openrouter') return openrouter;
  if (openrouter.configurado()) return openrouter;
  return anthropic;
}
