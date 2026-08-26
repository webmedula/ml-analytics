import { describe, expect, it } from 'vitest';
import { ferramentasNoFormatoOpenAi, resultadosNoFormatoAnthropic, resultadosNoFormatoOpenAi } from './provedores';
import { FERRAMENTAS } from './ferramentas';

/**
 * Os dois provedores esperam formatos DIFERENTES pro mesmo resultado. Errar aqui nao aparece como
 * erro de codigo: a API rejeita a conversa, ou pior, aceita e o modelo perde o resultado da
 * ferramenta e responde de cabeca — que e justamente o que este desenho existe pra impedir.
 */

const resultados = [
  { chamada: { id: 'call_1', nome: 'resumo_da_operacao', entrada: {} }, saida: { liquido: 10 } },
  { chamada: { id: 'call_2', nome: 'top_anuncios', entrada: { ordenar_por: 'margem' } }, saida: { itens: [] } },
];

describe('formato Anthropic', () => {
  it('junta todos os resultados numa unica mensagem de usuario', () => {
    const msgs = resultadosNoFormatoAnthropic(resultados);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toHaveLength(2);
    expect(msgs[0].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });

  it('serializa a saida como texto, que e o que a API aceita', () => {
    const bloco = resultadosNoFormatoAnthropic(resultados)[0].content[0];
    expect(typeof bloco.content).toBe('string');
    expect(JSON.parse(bloco.content)).toEqual({ liquido: 10 });
  });
});

describe('formato OpenAI / OpenRouter', () => {
  it('gera UMA mensagem por resultado, com role tool', () => {
    const msgs = resultadosNoFormatoOpenAi(resultados);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'resumo_da_operacao' });
    expect(msgs[1].tool_call_id).toBe('call_2');
  });

  it('o id do resultado casa com o id da chamada — trocar isso embaralha as respostas', () => {
    const msgs = resultadosNoFormatoOpenAi(resultados);
    for (let i = 0; i < resultados.length; i++) {
      expect(msgs[i].tool_call_id).toBe(resultados[i].chamada.id);
    }
  });
});

describe('ferramentas no formato OpenAI', () => {
  it('embrulha cada ferramenta em type/function com parameters', () => {
    const fs = ferramentasNoFormatoOpenAi(FERRAMENTAS);
    expect(fs).toHaveLength(FERRAMENTAS.length);
    for (const f of fs) {
      expect(f.type).toBe('function');
      expect(f.function.name).toBeTruthy();
      // No padrao OpenAI o schema chama "parameters"; na Anthropic, "input_schema".
      expect(f.function.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('preserva os campos obrigatorios de cada schema', () => {
    const original = FERRAMENTAS.find((f) => (f.input_schema as any).required)!;
    const convertida = ferramentasNoFormatoOpenAi([original])[0];
    expect((convertida.function.parameters as any).required).toEqual((original.input_schema as any).required);
  });
});
