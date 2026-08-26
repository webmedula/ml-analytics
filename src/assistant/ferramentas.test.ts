import { describe, expect, it } from 'vitest';
import { executarFerramenta, FERRAMENTAS } from './ferramentas';

/**
 * A API rejeita a requisicao inteira quando UMA ferramenta tem schema malformado, e o erro so
 * apareceria com o bot ja no ar, na cara do usuario. Estes testes sao baratos e pegam isso antes.
 */
describe('definicoes das ferramentas', () => {
  it('nomes unicos', () => {
    const nomes = FERRAMENTAS.map((f) => f.name);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('cada ferramenta tem nome valido, descricao util e schema de objeto', () => {
    for (const f of FERRAMENTAS) {
      expect(f.name).toMatch(/^[a-z0-9_]{1,64}$/);
      // Descricao curta demais faz o modelo escolher a ferramenta errada.
      expect(f.description.length).toBeGreaterThan(40);
      expect(f.input_schema).toMatchObject({ type: 'object' });
    }
  });

  it('todo campo obrigatorio existe nas properties', () => {
    for (const f of FERRAMENTAS) {
      const schema = f.input_schema as any;
      for (const req of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {})).toContain(req);
      }
    }
  });
});

describe('executarFerramenta', () => {
  it('ferramenta desconhecida devolve erro em vez de estourar', async () => {
    // Precisa ser resultado, nao excecao: o modelo consegue explicar um erro que chega como dado.
    await expect(executarFerramenta('nao_existe', {})).resolves.toMatchObject({
      erro: expect.stringContaining('nao_existe'),
    });
  });

  it('busca vazia no detalhe nao vira varredura do catalogo inteiro', async () => {
    await expect(executarFerramenta('detalhe_do_anuncio', { busca: '  ' })).resolves.toHaveProperty('erro');
  });
});
