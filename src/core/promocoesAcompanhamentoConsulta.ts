import { config } from '../config';
import { bancoDisponivel, fotosDaUltimaVarredura, historicoValido } from '../db/banco';
import { Acompanhamento, montarAcompanhamento, resumoEmTexto } from './promocoesAcompanhamento';

/**
 * v46: le as fotos do banco e monta o acompanhamento. Usada pela rota do painel e pela ferramenta
 * `promocoes_vencendo` (Gerente). Somente leitura.
 */

export function obterAcompanhamento(opts: { dias?: number; agora?: number } = {}): Acompanhamento {
  const diasAviso = Math.max(1, Math.trunc(Number(opts.dias) || config.promocoesAvisoDias));
  const vazio: Acompanhamento = {
    atualizadoEm: null,
    diasAviso,
    terminaEmBreve: [],
    ficouSemPromocao: [],
    semDataDeFim: [],
    historicoDisponivel: false,
  };
  if (!bancoDisponivel()) return vazio;
  try {
    const agora = opts.agora ?? Date.now();
    const atuais = fotosDaUltimaVarredura();
    if (!atuais.length) return { ...vazio, historicoDisponivel: true };
    const semPromoDias = config.promocoesSemPromoDias;
    // Basta olhar `semPromoDias` para tras: a ultima foto com promocao so vale dentro dessa janela,
    // e tudo que veio depois dela esta dentro dela tambem.
    const desde = new Date(agora - semPromoDias * 86400000).toISOString();
    const historico = historicoValido(desde, atuais[0].tiradaEm);
    return montarAcompanhamento(atuais, historico, agora, { diasAviso, semPromoDias });
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
  const enxuto = (o: (typeof a.terminaEmBreve)[number]) => ({
    itemId: o.itemId,
    titulo: o.titulo,
    promocao: o.promocao,
    fim: o.fim,
    prazo: o.prazo,
    diasRestantes: o.diasRestantes,
    coberta: o.coberta,
    folga: o.folga,
    propostasAbertas: o.propostasAbertas,
    desde: o.desde,
  });
  return {
    disponivel: true,
    atualizadoEm: a.atualizadoEm,
    diasAviso: a.diasAviso,
    totais: { terminaEmBreve: a.terminaEmBreve.length, ficouSemPromocao: a.ficouSemPromocao.length, semDataDeFim: a.semDataDeFim.length },
    terminaEmBreve: a.terminaEmBreve.slice(0, limite).map(enxuto),
    ficouSemPromocao: a.ficouSemPromocao.slice(0, limite).map(enxuto),
    semDataDeFim: a.semDataDeFim.slice(0, limite).map(enxuto),
    resumoEmTexto: resumoEmTexto(a, limite),
  };
}
