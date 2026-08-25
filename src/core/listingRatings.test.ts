import { describe, expect, it } from 'vitest';
import {
  buildRatingView,
  classificarAnuncio,
  EntradaClassificacao,
  ehUserProduct,
  ordenarRatings,
  RatingView,
  resumir,
} from './listingRatings';

const base: EntradaClassificacao = {
  itemId: 'MLB1',
  notaItem: 4.0,
  totalItem: 20,
  limite: 4.5,
  minOpinioes: 3,
};

function classificar(over: Partial<EntradaClassificacao> = {}) {
  return classificarAnuncio({ ...base, ...over });
}

describe('ehUserProduct', () => {
  it('reconhece produto do usuario pelo prefixo MLBU', () => {
    expect(ehUserProduct('MLBU4275986047')).toBe(true);
    expect(ehUserProduct('MLAU123')).toBe(true);
  });

  it('nao confunde produto de catalogo com produto do usuario', () => {
    expect(ehUserProduct('MLB19872191')).toBe(false);
    expect(ehUserProduct(null)).toBe(false);
    expect(ehUserProduct(undefined)).toBe(false);
  });
});

describe('classificarAnuncio — casos de saida antecipada', () => {
  it('sem resposta da API vira sem_dados', () => {
    expect(classificar({ notaItem: null, totalItem: null }).classificacao).toBe('sem_dados');
  });

  it('anuncio sem opinioes nao e candidato', () => {
    expect(classificar({ totalItem: 0 }).classificacao).toBe('sem_opinioes');
  });

  it('nota no limite ou acima nao e candidato', () => {
    expect(classificar({ notaItem: 4.5 }).classificacao).toBe('nota_ok');
    expect(classificar({ notaItem: 4.9 }).classificacao).toBe('nota_ok');
  });

  it('nota baixa com poucas opinioes nao aciona nada', () => {
    expect(classificar({ notaItem: 4.0, totalItem: 1 }).classificacao).toBe('poucas_opinioes');
    expect(classificar({ notaItem: 4.0, totalItem: 2 }).classificacao).toBe('poucas_opinioes');
  });

  it('a partir do minimo de opinioes, a nota passa a valer', () => {
    expect(classificar({ notaItem: 4.0, totalItem: 3 }).classificacao).not.toBe('poucas_opinioes');
  });
});

// Os dois casos abaixo sao dados REAIS da conta, coletados em 2026-08-20 via /debug/catalog.
describe('classificarAnuncio — caso real: balanca MLB4196542749 (catalogo)', () => {
  const balanca: Partial<EntradaClassificacao> = {
    itemId: 'MLB4196542749',
    catalogListing: true,
    catalogProductId: 'MLB19872191',
    notaItem: 4.6,
    totalItem: 1864,
    chaveDoPool: 'MLB19872191',
    poolDeCatalogo: true,
    anuncioDoPrimeiroReview: 'MLB3004510105',
  };

  it('com a nota real (4,6) nem chega a ser candidato', () => {
    expect(classificar(balanca).classificacao).toBe('nota_ok');
  });

  it('se a nota fosse baixa, o pool compartilhado seria detectado pelo anuncio de outro vendedor', () => {
    const r = classificar({ ...balanca, notaItem: 4.0 });
    expect(r.classificacao).toBe('preso_ao_catalogo');
    expect(r.evidencia).toContain('MLB3004510105');
  });

  it('detecta catalogo pela secondary_key mesmo sem o id do anuncio vizinho', () => {
    const r = classificar({ ...balanca, notaItem: 4.0, anuncioDoPrimeiroReview: null, poolDeCatalogo: null });
    expect(r.classificacao).toBe('preso_ao_catalogo');
    expect(r.evidencia).toContain('MLB19872191');
  });

  it('detecta catalogo pelo catalog_listing de dentro do review', () => {
    const r = classificar({ ...balanca, notaItem: 4.0, anuncioDoPrimeiroReview: null, chaveDoPool: null });
    expect(r.classificacao).toBe('preso_ao_catalogo');
  });
});

describe('classificarAnuncio — caso real: chave tic-tac MLB4881096643 (lista geral)', () => {
  const ticTac: Partial<EntradaClassificacao> = {
    itemId: 'MLB4881096643',
    catalogListing: false,
    catalogProductId: null,
    notaItem: 4.0,
    totalItem: 1,
    chaveDoPool: 'MLBU4275986047',
    poolDeCatalogo: false,
    anuncioDoPrimeiroReview: 'MLB4881096643',
  };

  it('com 1 opiniao real, o veredito e nao agir', () => {
    expect(classificar(ticTac).classificacao).toBe('poucas_opinioes');
  });

  it('com opinioes suficientes, cai em depende_do_user_product — nao em recriavel', () => {
    const r = classificar({ ...ticTac, totalItem: 12 });
    expect(r.classificacao).toBe('depende_do_user_product');
    expect(r.evidencia).toContain('MLBU4275986047');
  });

  it('a evidencia diz explicitamente que precisa ser verificado antes da virada', () => {
    expect(classificar({ ...ticTac, totalItem: 12 }).evidencia).toContain('verificado');
  });
});

describe('classificarAnuncio — anuncio sem produto nenhum', () => {
  it('e o unico caso que promete zerar', () => {
    const r = classificar({ catalogListing: false, catalogProductId: null, chaveDoPool: null, poolDeCatalogo: null });
    expect(r.classificacao).toBe('recriavel');
  });

  it('atributos de catalogo prevalecem mesmo sem sinal do review', () => {
    const r = classificar({ catalogProductId: 'MLB999', chaveDoPool: null, poolDeCatalogo: null });
    expect(r.classificacao).toBe('preso_ao_catalogo');
  });
});

describe('ordenacao e resumo', () => {
  const view = (over: Partial<RatingView>): RatingView => ({
    itemId: 'x', nota: 4, totalAvaliacoes: 10, notaProduto: null, totalAvaliacoesProduto: null,
    chaveDoPool: null, userProductId: null, classificacao: 'nota_ok', evidencia: '', ...over,
  });

  it('poe o que da pra agir na frente e a pior nota primeiro', () => {
    const ordenado = ordenarRatings([
      view({ itemId: 'a', classificacao: 'nota_ok' }),
      view({ itemId: 'b', classificacao: 'preso_ao_catalogo' }),
      view({ itemId: 'c', classificacao: 'recriavel', nota: 4.2 }),
      view({ itemId: 'd', classificacao: 'depende_do_user_product' }),
      view({ itemId: 'e', classificacao: 'recriavel', nota: 3.1 }),
    ]);
    expect(ordenado.map((v) => v.itemId)).toEqual(['e', 'c', 'd', 'b', 'a']);
  });

  it('conta cada classificacao', () => {
    const r = resumir([
      view({ classificacao: 'recriavel' }),
      view({ classificacao: 'recriavel' }),
      view({ classificacao: 'depende_do_user_product' }),
    ]);
    expect(r.recriavel).toBe(2);
    expect(r.depende_do_user_product).toBe(1);
    expect(r.preso_ao_catalogo).toBe(0);
  });
});

describe('buildRatingView', () => {
  it('leva a chave do pool do rating para a linha exibida', () => {
    const v = buildRatingView(
      { id: 'MLB4881096643', title: 'Chave Tic Tac', catalog_listing: false, catalog_product_id: null, sold_quantity: 54 },
      { ratingAverage: 4, total: 12, rota: '/reviews/item/MLB4881096643', userProductId: 'MLBU4275986047', chaveDoPool: 'MLBU4275986047', poolDeCatalogo: false, anuncioDoPrimeiroReview: 'MLB4881096643' },
      null,
      4.5,
      3,
    );
    expect(v.chaveDoPool).toBe('MLBU4275986047');
    expect(v.userProductId).toBe('MLBU4275986047');
    expect(v.classificacao).toBe('depende_do_user_product');
    expect(v.vendidos).toBe(54);
  });
});
