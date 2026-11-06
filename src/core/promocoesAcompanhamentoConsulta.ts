import { config } from '../config';
import { bancoDisponivel, fotosDaUltimaVarredura, historicoValido } from '../db/banco';
import { Acompanhamento, acompanhamentoVazio, montarAcompanhamento, resumoEmTexto } from './promocoesAcompanhamento';
import { getPromocoes, ROTULO_DO_TIPO } from './promocoes';

/**
 * v46: le as fotos do banco e monta o acompanhamento. Usada pela rota do painel e pela ferramenta
 * `promocoes_vencendo` (Gerente). Somente leitura.
 */

export function obterAcompanhamento(opts: { dias?: number; agora?: number } = {}): Acompanhamento {
  const diasAviso = Math.max(1, Math.trunc(Number(opts.dias) || config.promocoesAvisoDias));
  const vazio = acompanhamentoVazio(diasAviso, false);
  if (!bancoDisponivel()) return vazio;
  try {
    const agora = opts.agora ?? Date.now();
    const atuais = fotosDaUltimaVarredura();
    if (!atuais.length) return acompanhamentoVazio(diasAviso, true);
    const semPromoDias = config.promocoesSemPromoDias;
    // Basta olhar `semPromoDias` para tras: a ultima foto com promocao so vale dentro dessa janela,
    // e tudo que veio depois dela esta dentro dela tambem.
    const desde = new Date(agora - semPromoDias * 86400000).toISOString();
    const historico = historicoValido(desde, atuais[0].tiradaEm);
    // Melhor substituta e prazo para aderir vem do cache atual (tem o "voce recebe"), nao da foto.
    const cache = getPromocoes();
    return montarAcompanhamento(atuais, historico, agora, { diasAviso, semPromoDias }, {
      itens: cache && cache.apiDisponivel ? cache.itens : null,
      rotuloDoTipo: (t) => ROTULO_DO_TIPO[t] ?? t,
    });
  } catch {
    return vazio;
  }
}

/** Resposta da ferramenta `promocoes_vencendo`. `limite` vale por lista. */
export function promocoesVencendo(entrada: { dias?: number; limite?: number }, agora = Date.now()) {
  const limite = Math.min(30, Math.max(1, Math.trunc(Number(entrada?.limite) || 10)));
  const a = obterAcompanhamento({ dias: entrada?.dias, agora });
  if (!a.historicoDisponivel) {
    return { disponivel: false, mensagem: 'Historico de promocoes indisponivel (banco local fora do ar).', resumoEmTexto: null };
  }
  if (!a.atualizadoEm) {
    return { disponivel: false, mensagem: 'A varredura de promocoes ainda nao gravou nenhuma foto (roda ~2 min depois de subir e a cada 6h).', resumoEmTexto: null };
  }
  const substituta = (x: { nome: string | null; tipo: string; promocaoId: string | null; voceRecebe: number | null; diferencaPorVenda: number | null } | null) =>
    x && { nome: x.nome, tipo: x.tipo, promocaoId: x.promocaoId, voceRecebe: x.voceRecebe, diferencaPorVenda: x.diferencaPorVenda };
  const ocorrencia = (o: (typeof a.ficouSemPromocao)[number]) => ({
    itemId: o.itemId,
    titulo: o.titulo,
    promocao: o.promocao,
    fim: o.fim,
    desde: o.desde,
    coberta: o.coberta,
    propostasAbertas: o.propostasAbertas,
    melhorSubstituta: substituta(o.substituta),
  });
  return {
    disponivel: true,
    atualizadoEm: a.atualizadoEm,
    diasAviso: a.diasAviso,
    totais: {
      anunciosVencendo: a.terminaEmBreve.length,
      gruposVencendo: a.grupos.length,
      ficouSemPromocao: a.ficouSemPromocao.length,
      prazoAderir: a.prazoAderir.length,
      semDataDeFim: a.semDataDeFim.length,
    },
    vencendo: a.grupos.slice(0, limite).map((g) => ({
      promocao: g.nome ?? g.tipo,
      tipo: g.rotuloTipo,
      fim: g.fim,
      prazo: g.prazo,
      anuncios: g.total,
      cobertos: g.cobertos,
      exemplos: g.anuncios.filter((o) => !o.coberta).slice(0, 5).map(ocorrencia),
    })),
    ficouSemPromocao: a.ficouSemPromocao.slice(0, limite).map(ocorrencia),
    prazoAderir: a.prazoAderir.slice(0, limite).map((p) => ({
      itemId: p.itemId,
      titulo: p.titulo,
      promocao: p.promocao.nome ?? p.promocao.rotulo,
      prazo: p.prazo,
      prazoParaAderir: p.prazoParaAderir,
      diferencaPorVenda: p.diferencaPorVenda,
    })),
    semDataPorPromocao: a.semDataPorPromocao.slice(0, limite).map((g) => ({ promocao: g.nome ?? g.tipo, tipo: g.rotuloTipo, anuncios: g.total })),
    resumoEmTexto: resumoEmTexto(a, limite),
  };
}
