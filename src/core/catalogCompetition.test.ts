import { describe, expect, it } from 'vitest';
import { buildCompetitionView, mapSituacao, motivosDePerda, sortCompetitionViews } from './catalogCompetition';
import type { MlItemAttributes, MlPriceToWin } from '../ml/mlClient';

function item(over: Partial<MlItemAttributes> = {}): MlItemAttributes {
  return { id: 'MLB1', title: 'Produto', price: 100, catalog_listing: true, catalog_product_id: 'MLB-PROD', status: 'active', ...over };
}

describe('mapSituacao', () => {
  it('mapeia os status do ML para a situacao simplificada', () => {
    expect(mapSituacao('winning')).toBe('ganhando');
    expect(mapSituacao('sharing_first_place')).toBe('empatado');
    expect(mapSituacao('competing')).toBe('perdendo');
    expect(mapSituacao('listed')).toBe('perdendo');
    expect(mapSituacao('qualquer_outra')).toBe('indefinido');
    expect(mapSituacao(undefined)).toBe('indefinido');
  });
});

describe('buildCompetitionView — calculo do gap', () => {
  it('perdendo: gap e percentual (sobre o proprio preco atual)', () => {
    const ptw: MlPriceToWin = { status: 'competing', current_price: 120, price_to_win: 100, winner: { price: 100 } };
    const v = buildCompetitionView(item(), ptw);
    expect(v.situacao).toBe('perdendo');
    expect(v.gap).toBe(20);
    expect(v.gapPercent).toBe(16.67); // 20 / 120
    expect(v.precoVencedor).toBe(100);
    expect(v.naoEhPreco).toBe(false);
  });

  it('preco-alvo irrealista (bem abaixo do vencedor) marca naoEhPreco', () => {
    const ptw: MlPriceToWin = { status: 'competing', current_price: 23.5, price_to_win: 0.73, winner: { price: 22.99 } };
    const v = buildCompetitionView(item(), ptw);
    expect(v.naoEhPreco).toBe(true);
  });

  it('ganhando: nao calcula gap (fica null)', () => {
    const ptw: MlPriceToWin = { status: 'winning', current_price: 100, price_to_win: 100 };
    const v = buildCompetitionView(item(), ptw);
    expect(v.situacao).toBe('ganhando');
    expect(v.gap).toBeNull();
    expect(v.gapPercent).toBeNull();
  });

  it('usa o preco do item quando o price_to_win nao traz current_price', () => {
    const ptw: MlPriceToWin = { status: 'competing', price_to_win: 90 };
    const v = buildCompetitionView(item({ price: 105 }), ptw);
    expect(v.precoAtual).toBe(105);
    expect(v.gap).toBe(15);
  });

  it('sem preco pra ganhar: gap fica null mesmo perdendo', () => {
    const ptw: MlPriceToWin = { status: 'competing', current_price: 100, price_to_win: null };
    const v = buildCompetitionView(item(), ptw);
    expect(v.gap).toBeNull();
  });

  it('captura o concorrente vencedor (item e vendedor) do price_to_win', () => {
    const ptw: MlPriceToWin = {
      status: 'competing', current_price: 120, price_to_win: 100,
      winner: { item_id: 'MLB999', price: 98, seller_id: 555 },
    };
    const v = buildCompetitionView(item(), ptw);
    expect(v.vencedorItemId).toBe('MLB999');
    expect(v.vencedorSellerId).toBe(555);
    expect(v.precoVencedor).toBe(98);
  });
});

describe('motivosDePerda — vantagens que o vencedor tem e voce nao', () => {
  it('lista os boosts que o vencedor tem (boosted) e o seu anuncio nao', () => {
    const ptw: MlPriceToWin = {
      status: 'competing',
      boosts: [
        { id: 'free_shipping', status: 'opportunity', description: 'Frete grátis' },
        { id: 'shipping_collect', status: 'boosted', description: 'Envios com coleta' },
        { id: 'same_day_shipping', status: 'opportunity', description: 'Envios no mesmo dia' },
      ],
      winner: {
        price: 22.99,
        boosts: [
          { id: 'free_shipping', status: 'boosted', description: 'Frete grátis' },
          { id: 'shipping_collect', status: 'boosted', description: 'Envios com coleta' },
          { id: 'same_day_shipping', status: 'boosted', description: 'Envios no mesmo dia' },
        ],
      },
    };
    // free_shipping e same_day: vencedor tem, voce nao. shipping_collect: os dois tem -> nao entra.
    expect(motivosDePerda(ptw)).toEqual(['Frete grátis', 'Envios no mesmo dia']);
  });

  it('sem boosts do vencedor: nenhum motivo (disputa e de preco)', () => {
    expect(motivosDePerda({ status: 'competing', winner: { price: 10 } })).toEqual([]);
  });
});

describe('sortCompetitionViews — ordena por urgencia', () => {
  it('perdendo (maior gap primeiro), depois empatado, ganhando, indefinido', () => {
    const mk = (id: string, status: string, cur?: number, win?: number): ReturnType<typeof buildCompetitionView> =>
      buildCompetitionView(item({ id }), { status, current_price: cur, price_to_win: win } as MlPriceToWin);

    const views = [
      mk('g', 'winning', 100, 100),
      mk('p1', 'competing', 110, 100), // gap 10
      mk('e', 'sharing_first_place', 100, 100),
      mk('p2', 'competing', 150, 100), // gap 50
      mk('x', 'weird'),
    ];
    const ordered = sortCompetitionViews(views).map((v) => v.itemId);
    expect(ordered).toEqual(['p2', 'p1', 'e', 'g', 'x']);
  });
});
