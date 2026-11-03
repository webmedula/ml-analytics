import { getPromocoes, LinhaPromocao, PromocoesResult } from './promocoes';

/**
 * Consulta das propostas de promocao, usada pela ferramenta `promocoes_do_ml` (Gerente no
 * Telegram) e pelo aviso diario. Separada da varredura pra ser testavel sem rede nem disco.
 */

const brl = (v: number | null | undefined): string =>
  v == null ? '?' : `R$ ${v.toFixed(2).replace('.', ',')}`;

function dataCurta(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Uma linha legivel por proposta — vai direto pro Telegram no aviso diario. */
export function linhaEmTexto(l: LinhaPromocao): string {
  const titulo = (l.titulo ?? l.itemId).slice(0, 60);
  const periodo = [dataCurta(l.inicio), dataCurta(l.fim)].filter(Boolean).join(' a ');
  const partes = [
    `• ${titulo} (${l.itemId})`,
    `  ${l.rotulo}${l.nome && l.nome !== l.rotulo ? ` "${l.nome}"` : ''}${periodo ? `, ${periodo}` : ''}`,
    `  ${brl(l.precoAtual)} → ${brl(l.precoProposto)}${l.descontoPercentual != null ? ` (-${l.descontoPercentual}%)` : ''}` +
      (l.mlBanca ? `, ML banca ${brl(l.mlBanca)}` : ''),
  ];
  if (l.voceRecebe != null) {
    const dif = l.diferencaPorVenda;
    partes.push(
      `  Você recebe ~${brl(l.voceRecebe)} (hoje ${brl(l.voceRecebeHoje)}` +
        (dif != null ? `, ${dif >= 0 ? '+' : ''}${brl(dif)} por venda)` : ')'),
    );
  }
  return partes.join('\n');
}

export interface FiltroPromocoes {
  apenas_novas?: boolean;
  horas?: number;
  situacao?: 'proposta' | 'participando' | 'todas';
  tipo?: string;
  apenas_ml_banca?: boolean;
  busca?: string;
  limite?: number;
}

export function filtrarPromocoes(f: FiltroPromocoes, r: PromocoesResult | null = getPromocoes(), agora = Date.now()) {
  if (!r) return { disponivel: false, mensagem: 'A varredura de promocoes ainda nao rodou (roda ~2 min depois de subir e a cada 6h).' };
  if (!r.apiDisponivel) return { disponivel: false, mensagem: r.avisoDaApi, atualizadoEm: r.atualizadoEm };

  const limite = Math.min(30, Math.max(1, Math.trunc(Number(f.limite) || 10)));
  const situacao = f.situacao || 'proposta';
  const horas = Math.max(1, Math.trunc(Number(f.horas) || 24));
  const desde = agora - horas * 3600 * 1000;
  const tipo = f.tipo ? String(f.tipo).toUpperCase() : null;
  const busca = f.busca ? String(f.busca).trim().toUpperCase() : null;

  const itens = r.itens.filter(
    (l) =>
      (situacao === 'todas' || l.situacao === situacao) &&
      (!f.apenas_novas || Date.parse(l.vistaPrimeiroEm) >= desde) &&
      (!tipo || l.tipo === tipo) &&
      (!f.apenas_ml_banca || l.mlBanca > 0) &&
      (!busca || l.itemId.toUpperCase() === busca || (l.titulo ?? '').toUpperCase().includes(busca)),
  );

  const porTipo: Record<string, number> = {};
  for (const l of itens) porTipo[l.rotulo] = (porTipo[l.rotulo] ?? 0) + 1;

  const mostrados = itens.slice(0, limite);
  return {
    disponivel: true,
    atualizadoEm: r.atualizadoEm,
    aviso: r.avisoDaApi,
    filtro: { situacao, apenas_novas: !!f.apenas_novas, horas: f.apenas_novas ? horas : undefined, tipo, busca },
    total: itens.length,
    anunciosComProposta: new Set(itens.map((l) => l.itemId)).size,
    porTipo,
    observacao:
      'voceRecebe e estimativa (preco + parte do ML - tarifa pela tabela do ML - frete medio). Ordenado pelas que menos ' +
      'tiram de cada venda. Aderir continua sendo pela tela do ML.',
    itens: mostrados.map((l) => ({
      itemId: l.itemId, titulo: l.titulo, tipo: l.tipo, rotulo: l.rotulo, nome: l.nome, situacao: l.situacao,
      precoAtual: l.precoAtual, precoProposto: l.precoProposto, faixa: l.precoMinimo || l.precoMaximo ? [l.precoMinimo, l.precoMaximo] : undefined,
      descontoPercentual: l.descontoPercentual, mlBanca: l.mlBanca, voceRecebe: l.voceRecebe, voceRecebeHoje: l.voceRecebeHoje,
      diferencaPorVenda: l.diferencaPorVenda, inicio: l.inicio, fim: l.fim, prazoParaAderir: l.prazoParaAderir, vistaPrimeiroEm: l.vistaPrimeiroEm,
    })),
    /** Texto pronto (Telegram). O aviso diario do Gerente envia isto sem passar pela IA. */
    resumoEmTexto: itens.length
      ? `${itens.length} proposta(s) de promoção do ML${f.apenas_novas ? ` nas últimas ${horas}h` : ''}` +
        ` em ${new Set(itens.map((l) => l.itemId)).size} anúncio(s):\n\n` +
        mostrados.map(linhaEmTexto).join('\n\n') +
        (itens.length > mostrados.length ? `\n\n…e mais ${itens.length - mostrados.length}. Pergunte "quais promoções do ML valem a pena?" para ver todas.` : '')
      : null,
  };
}
