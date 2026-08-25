import { describe, expect, it } from 'vitest';
import { Velocidade, variacao, velocidadeDeVenda, vendasPorDia } from './history';
import { calcularCompra, desvioPadrao, estoqueDeSeguranca, ordenarPorUrgencia } from './replenishment';

function vel(unidadesPorDia: number, dias = 30): Velocidade {
  return {
    unidadesPorDia,
    diasConsiderados: dias,
    diasDescartadosSemEstoque: 0,
    diasDescartadosPromocao: 0,
    confiavel: dias >= 7,
  };
}

const p = { prazoEntregaDias: 10, cicloCompraDias: 7 };

describe('variacao', () => {
  it('mede crescimento e queda', () => {
    expect(variacao(130, 100)).toBe(30);
    expect(variacao(70, 100)).toBe(-30);
  });

  it('nao inventa percentual ao sair do zero', () => {
    expect(variacao(50, 0)).toBeNull();
    expect(variacao(0, 0)).toBe(0);
  });
});

describe('vendasPorDia', () => {
  const s = (data: string, unidades30: number, liquido30: number, estoque: number) =>
    ({ data, itemId: 'MLB1', preco: 10, estoque, visitas: 0, unidades30, liquido30 } as any);

  it('deriva a venda do dia da diferenca do acumulado', () => {
    const dias = vendasPorDia([s('2026-08-01', 10, 100, 5), s('2026-08-02', 13, 130, 4), s('2026-08-03', 14, 140, 3)]);
    expect(dias.map((d) => d.unidades)).toEqual([3, 1]);
    expect(dias.map((d) => d.liquido)).toEqual([30, 10]);
  });

  it('nao gera venda negativa quando a janela de 30 dias descarta vendas antigas', () => {
    const dias = vendasPorDia([s('2026-08-01', 20, 200, 5), s('2026-08-02', 17, 170, 5)]);
    expect(dias[0].unidades).toBe(0);
    expect(dias[0].liquido).toBe(0);
  });

  it('marca os dias sem estoque', () => {
    const dias = vendasPorDia([s('2026-08-01', 10, 100, 3), s('2026-08-02', 10, 100, 0)]);
    expect(dias[0].tinhaEstoque).toBe(false);
  });

  it('serie de um dia so nao produz nenhuma diferenca', () => {
    expect(vendasPorDia([s('2026-08-01', 10, 100, 5)])).toEqual([]);
  });
});

describe('velocidadeDeVenda', () => {
  const dia = (unidades: number, tinhaEstoque = true, emPromocao: boolean | null = false) =>
    ({ unidades, tinhaEstoque, emPromocao });

  it('e a media simples quando nada e descartado', () => {
    expect(velocidadeDeVenda([dia(2), dia(4), dia(3)]).unidadesPorDia).toBe(3);
  });

  it('ruptura mascara demanda: dias sem estoque puxam a media pra baixo se contados', () => {
    const dias = [dia(4), dia(4), dia(0, false), dia(0, false)];
    expect(velocidadeDeVenda(dias).unidadesPorDia).toBe(2);
    const corrigida = velocidadeDeVenda(dias, { ignorarDiasSemEstoque: true });
    expect(corrigida.unidadesPorDia).toBe(4);
    expect(corrigida.diasDescartadosSemEstoque).toBe(2);
  });

  it('promocao infla a media e encheria o deposito', () => {
    const dias = [dia(2), dia(2), dia(20, true, true)];
    expect(velocidadeDeVenda(dias).unidadesPorDia).toBe(8);
    const corrigida = velocidadeDeVenda(dias, { ignorarDiasEmPromocao: true });
    expect(corrigida.unidadesPorDia).toBe(2);
    expect(corrigida.diasDescartadosPromocao).toBe(1);
  });

  it('marca como nao confiavel quando sobra pouco dia util', () => {
    expect(velocidadeDeVenda([dia(1), dia(2)]).confiavel).toBe(false);
    expect(velocidadeDeVenda(Array(7).fill(dia(1))).confiavel).toBe(true);
  });

  it('descartar tudo devolve zero em vez de dividir por zero', () => {
    const v = velocidadeDeVenda([dia(0, false), dia(0, false)], { ignorarDiasSemEstoque: true });
    expect(v.unidadesPorDia).toBe(0);
    expect(v.diasConsiderados).toBe(0);
  });
});

describe('desvioPadrao e estoque de seguranca', () => {
  it('demanda constante nao exige colchao', () => {
    expect(desvioPadrao([5, 5, 5, 5])).toBe(0);
    expect(estoqueDeSeguranca(0, 10)).toBe(0);
  });

  it('cresce com a raiz do prazo, nao com o prazo', () => {
    const dez = estoqueDeSeguranca(2, 10);
    const quarenta = estoqueDeSeguranca(2, 40);
    // Prazo x4 deveria dobrar a seguranca (raiz de 4), nao quadruplicar: a incerteza se acumula
    // pela variancia. Margem de 1 pelo arredondamento pra cima.
    expect(Math.abs(quarenta - dez * 2)).toBeLessThanOrEqual(1);
    expect(quarenta).toBeLessThan(dez * 4);
  });

  it('nivel de servico maior pede mais colchao', () => {
    expect(estoqueDeSeguranca(3, 9, 2.33)).toBeGreaterThan(estoqueDeSeguranca(3, 9, 1.65));
  });
});

describe('calcularCompra', () => {
  it('estoque zerado e a urgencia maxima', () => {
    const r = calcularCompra(vel(3), 0, 0, p);
    expect(r.urgencia).toBe('rompido');
    expect(r.comprar).toBe(3 * (10 + 7));
    expect(r.explicacao).toContain('Sem estoque AGORA');
  });

  it('cobertura menor que o prazo de entrega e critico: rompe antes de chegar', () => {
    const r = calcularCompra(vel(2), 10, 0, p); // dura 5 dias, fornecedor leva 10
    expect(r.urgencia).toBe('critico');
    expect(r.explicacao).toContain('Vai romper antes de chegar');
  });

  it('no ponto de compra, pede o suficiente pro prazo mais o ciclo', () => {
    // ponto de compra = 1 un/dia x 10 dias = 10. Com 10 em estoque, chegou a hora.
    const r = calcularCompra(vel(1), 10, 0, p);
    expect(r.urgencia).toBe('atencao');
    // alvo = 1 x (10 de prazo + 7 de ciclo) = 17; ja tem 10, entao faltam 7.
    expect(r.comprar).toBe(7);
  });

  it('logo acima do ponto de compra ainda esta ok', () => {
    expect(calcularCompra(vel(1), 15, 0, p).urgencia).toBe('ok');
  });

  it('estoque folgado nao gera compra', () => {
    const r = calcularCompra(vel(1), 60, 0, p);
    expect(r.urgencia).toBe('ok');
    expect(r.comprar).toBe(0);
  });

  it('anuncio parado nao vira sugestao de compra', () => {
    const r = calcularCompra(vel(0), 40, 0, p);
    expect(r.urgencia).toBe('parado');
    expect(r.comprar).toBe(0);
    expect(r.coberturaDias).toBeNull();
  });

  it('o que esta em transito conta como estoque', () => {
    const sem = calcularCompra(vel(2), 10, 0, p);
    const com = calcularCompra(vel(2), 10, 0, p, 30);
    expect(com.comprar).toBeLessThan(sem.comprar);
    expect(com.urgencia).toBe('ok');
  });

  it('demanda instavel exige mais estoque de seguranca', () => {
    const estavel = calcularCompra(vel(3), 20, 0, p);
    const instavel = calcularCompra(vel(3), 20, 4, p);
    expect(instavel.estoqueSeguranca).toBeGreaterThan(estavel.estoqueSeguranca);
    expect(instavel.comprar).toBeGreaterThan(estavel.comprar);
  });

  it('avisa quando o historico ainda e curto demais pra confiar', () => {
    const r = calcularCompra(vel(3, 3), 5, 0, p);
    expect(r.explicacao).toContain('o numero ainda e fraco');
  });
});

describe('ordenarPorUrgencia', () => {
  it('rompido primeiro, parado por ultimo, e quem vende mais na frente do empate', () => {
    const linha = (urgencia: any, velocidade: number) => ({ sugestao: { urgencia, velocidade } as any });
    const ordenado = ordenarPorUrgencia([
      linha('ok', 1),
      linha('parado', 0),
      linha('atencao', 2),
      linha('rompido', 5),
      linha('atencao', 9),
    ]);
    expect(ordenado.map((l) => l.sugestao.urgencia)).toEqual(['rompido', 'atencao', 'atencao', 'ok', 'parado']);
    expect(ordenado[1].sugestao.velocidade).toBe(9);
  });
});
