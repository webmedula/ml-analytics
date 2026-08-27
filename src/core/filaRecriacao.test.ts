import { describe, expect, it } from 'vitest';
import { avaliacoesParaRecuperar, montarFila, recomendar, resumirFila, LIMIARES_PADRAO } from './filaRecriacao';

describe('avaliacoesParaRecuperar', () => {
  it('com limite 4,5 e nota 4,0 e preciso dobrar o numero de opinioes', () => {
    // x >= N(t-a)/(5-t) = N(0,5)/(0,5) = N
    expect(avaliacoesParaRecuperar(4.0, 10, 4.5)).toBe(10);
    expect(avaliacoesParaRecuperar(4.0, 1862, 4.5)).toBe(1862);
  });

  it('quanto pior a nota, mais desproporcional fica', () => {
    expect(avaliacoesParaRecuperar(3.0, 10, 4.5)).toBe(30);
    expect(avaliacoesParaRecuperar(1.0, 4, 4.5)).toBe(28);
  });

  it('nota ja acima do limite nao precisa de nada', () => {
    expect(avaliacoesParaRecuperar(4.8, 10, 4.5)).toBeNull();
  });

  it('sem dado nao inventa numero', () => {
    expect(avaliacoesParaRecuperar(null, 10, 4.5)).toBeNull();
    expect(avaliacoesParaRecuperar(4.0, null, 4.5)).toBeNull();
    expect(avaliacoesParaRecuperar(4.0, 0, 4.5)).toBeNull();
  });

  it('limite 5 seria inalcancavel e devolve null em vez de dividir por zero', () => {
    expect(avaliacoesParaRecuperar(4.0, 10, 5)).toBeNull();
  });
});

describe('recomendar', () => {
  it('opiniao presa ao catalogo: nao recriar, por mais dinheiro que tenha', () => {
    const r = recomendar('preso_ao_catalogo', 5, 50000);
    expect(r.acao).toBe('nao_recriar');
    expect(r.porque).toMatch(/catalogo/i);
  });

  it('poucas avaliacoes: recuperar ganha de recriar', () => {
    const r = recomendar('recriavel', 4, 100);
    expect(r.acao).toBe('recuperar_por_avaliacao');
    expect(r.porque).toContain('4 avaliacao');
  });

  it('muitas avaliacoes e pouco dinheiro: recriar sem drama', () => {
    expect(recomendar('recriavel', 800, 100).acao).toBe('recriar');
  });

  it('muitas avaliacoes e muito dinheiro: cautela, com o valor na frente', () => {
    const r = recomendar('recriavel', 800, 34625.25);
    expect(r.acao).toBe('recriar_com_cautela');
    expect(r.porque).toContain('R$ 34.625,25');
  });

  it('sem evidencia: sondar antes de decidir', () => {
    expect(recomendar('indefinido', null, 500).acao).toBe('sondar');
    expect(recomendar('sem_dados', null, 500).acao).toBe('sondar');
  });

  it('anuncio de 1 ou 2 opinioes cai em recuperar, e nao some da lista', () => {
    // Nota 2,6 com 1 opiniao: 4 avaliacoes boas resolvem. Antes esse caso era cortado por um
    // minimo de opinioes e desaparecia da tela — justamente o mais facil de consertar.
    expect(recomendar('poucas_opinioes', 4, 800).acao).toBe('recuperar_por_avaliacao');
    expect(recomendar('sem_dados', 2, 800).acao).toBe('recuperar_por_avaliacao');
  });

  it('sem alternativa barata E sem classificacao confiavel, sonda', () => {
    expect(recomendar('poucas_opinioes', 400, 800).acao).toBe('sondar');
  });

  it('"nao adianta" e avaliado ANTES de "compensa"', () => {
    // Anuncio de catalogo com poucas avaliacoes: recuperar por avaliacao ate faria sentido, mas
    // recriar nao e a questao — o que nao pode e sugerir recriacao onde ela nao produz efeito.
    expect(recomendar('preso_ao_catalogo', 2, 100).acao).toBe('nao_recriar');
  });
});

describe('montarFila', () => {
  const notas = [
    { itemId: 'A', title: 'Catalogo campeao', nota: 4.0, totalAvaliacoes: 500, classificacao: 'preso_ao_catalogo', evidencia: 'x' },
    { itemId: 'B', title: 'Recriavel pequeno', nota: 4.0, totalAvaliacoes: 900, classificacao: 'recriavel', evidencia: 'x' },
    { itemId: 'C', title: 'Recriavel grande', nota: 4.0, totalAvaliacoes: 900, classificacao: 'recriavel', evidencia: 'x' },
    { itemId: 'D', title: 'Poucas opinioes', nota: 4.0, totalAvaliacoes: 3, classificacao: 'recriavel', evidencia: 'x' },
  ];
  const dinheiro = new Map([
    ['A', { liquido: 30000, unidades: 100, margem: 5000 }],
    ['B', { liquido: 150, unidades: 5, margem: 40 }],
    ['C', { liquido: 9000, unidades: 60, margem: 2000 }],
    ['D', { liquido: 500, unidades: 9, margem: null }],
  ]);

  it('poe o que tem acao na frente, mesmo faturando menos que o que nao tem', () => {
    const fila = montarFila(notas as any, dinheiro, 4.5);
    // A fatura 30 mil e lidera em dinheiro, mas nao ha o que fazer com ele: vai pro fim.
    expect(fila[fila.length - 1].itemId).toBe('A');
    expect(fila[0].itemId).toBe('C'); // maior dinheiro entre os acionaveis
  });

  it('dentro do grupo acionavel, ordena por dinheiro', () => {
    const fila = montarFila(notas as any, dinheiro, 4.5);
    const acionaveis = fila.filter((l) => l.acao !== 'nao_recriar').map((l) => l.liquidoEmRisco);
    expect(acionaveis).toEqual([...acionaveis].sort((a, b) => b - a));
  });

  it('anuncio sem venda no periodo entra com zero, e nao some da fila', () => {
    const fila = montarFila(notas as any, new Map(), 4.5);
    expect(fila).toHaveLength(4);
    expect(fila.every((l) => l.liquidoEmRisco === 0)).toBe(true);
  });

  it('cada linha carrega a alternativa de recuperar', () => {
    const fila = montarFila(notas as any, dinheiro, 4.5);
    const d = fila.find((l) => l.itemId === 'D')!;
    expect(d.avaliacoesParaRecuperar).toBe(3);
    expect(d.acao).toBe('recuperar_por_avaliacao');
  });
});

describe('resumirFila', () => {
  it('separa o dinheiro que tem saida do que nao tem', () => {
    const fila = montarFila(
      [
        { itemId: 'A', nota: 4.0, totalAvaliacoes: 500, classificacao: 'preso_ao_catalogo', evidencia: 'x' },
        { itemId: 'C', nota: 4.0, totalAvaliacoes: 900, classificacao: 'recriavel', evidencia: 'x' },
      ] as any,
      new Map([
        ['A', { liquido: 30000, unidades: 1, margem: null }],
        ['C', { liquido: 9000, unidades: 1, margem: null }],
      ]),
      4.5,
    );
    const r = resumirFila(fila);
    expect(r.total).toBe(2);
    expect(r.liquidoAcionavel).toBe(9000);
    expect(r.liquidoSemSaida).toBe(30000);
  });

  it('fila vazia nao quebra', () => {
    expect(resumirFila([])).toMatchObject({ total: 0, liquidoAcionavel: 0, liquidoSemSaida: 0 });
  });
});

describe('limiares padrao', () => {
  it('sao explicitos, pra poder discutir o numero em vez de descobrir no comportamento', () => {
    expect(LIMIARES_PADRAO.recuperavelAte).toBe(15);
    expect(LIMIARES_PADRAO.liquidoAlto).toBe(2000);
  });
});
