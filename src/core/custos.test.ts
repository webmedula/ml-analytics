import { describe, expect, it } from 'vitest';
import { chaveSku, emparelhar } from './custos';
import { extrairSku } from '../ml/mlClient';

describe('chaveSku', () => {
  it('casa o mesmo SKU escrito de formas diferentes nos dois sistemas', () => {
    expect(chaveSku(' rl-6003 ')).toBe('RL-6003');
    expect(chaveSku('RL-6003')).toBe(chaveSku('rl-6003'));
  });

  it('vazio e nao-texto viram null em vez de chave falsa', () => {
    expect(chaveSku('')).toBeNull();
    expect(chaveSku('   ')).toBeNull();
    expect(chaveSku(null)).toBeNull();
    expect(chaveSku(undefined)).toBeNull();
  });
});

describe('extrairSku', () => {
  it('prefere o atributo SELLER_SKU, que e o campo atual do ML', () => {
    const r = extrairSku({
      seller_custom_field: 'ANTIGO-1',
      attributes: [{ id: 'BRAND', value_name: 'MCS' }, { id: 'SELLER_SKU', value_name: 'RL-6003' }],
    });
    expect(r).toEqual({ sku: 'RL-6003', origem: 'attributes.SELLER_SKU' });
  });

  it('cai no seller_custom_field quando nao ha atributo', () => {
    expect(extrairSku({ seller_custom_field: 'RL-6201' }).sku).toBe('RL-6201');
  });

  it('le SKU de variacao e avisa quando o anuncio tem mais de uma', () => {
    const uma = extrairSku({ variations: [{ attributes: [{ id: 'SELLER_SKU', value_name: 'V-1' }] }] });
    expect(uma).toEqual({ sku: 'V-1', origem: 'variacoes' });

    const varias = extrairSku({
      variations: [
        { seller_custom_field: 'V-1' },
        { seller_custom_field: 'V-2' },
      ],
    });
    expect(varias.sku).toBe('V-1');
    expect(varias.origem).toBe('variacoes (multiplos SKUs)');
  });

  it('anuncio sem SKU devolve null, e nao string vazia', () => {
    expect(extrairSku({ seller_custom_field: '   ', attributes: [] }).sku).toBeNull();
    expect(extrairSku({}).sku).toBeNull();
    expect(extrairSku(null).sku).toBeNull();
  });

  it('aceita o formato values[].name, que o ML usa em parte dos atributos', () => {
    expect(extrairSku({ attributes: [{ id: 'SELLER_SKU', values: [{ name: 'RL-6202' }] }] }).sku).toBe('RL-6202');
  });
});

describe('emparelhar', () => {
  const custos = { 'RL-6003': 1.85 };
  const semCusto = ['RL-6201'];

  it('separa os quatro estados, que exigem acoes diferentes', () => {
    const r = emparelhar(['rl-6003', 'RL-6201', 'NAO-EXISTE', null], custos, semCusto);
    // com custo: da pra calcular margem
    expect(r.comCusto).toBe(1);
    // existe no Tiny sem custo: falta cadastro
    expect(r.semCustoNoTiny).toBe(1);
    // nao existe no Tiny: SKU divergente entre os sistemas
    expect(r.foraDoTiny).toBe(1);
    // sem SKU no anuncio: nem da pra tentar
    expect(r.semSku).toBe(1);
  });

  it('nao conta anuncio nenhum duas vezes', () => {
    const skus = ['RL-6003', 'RL-6201', 'X', null, ''];
    const r = emparelhar(skus, custos, semCusto);
    expect(r.comCusto + r.semCustoNoTiny + r.foraDoTiny + r.semSku).toBe(skus.length);
  });

  it('lista vazia nao quebra', () => {
    expect(emparelhar([], custos, semCusto)).toEqual({ comCusto: 0, semCustoNoTiny: 0, foraDoTiny: 0, semSku: 0 });
  });
});
