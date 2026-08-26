/**
 * CORRESPONDENCIA DE SKU ENTRE ML E TINY.
 *
 * Os codigos divergem por motivos mecanicos, nao por serem produtos diferentes: hifen em lugar
 * diferente (MCS-ABR7.6X550 x MCSABR7.6X550), o titulo inteiro colado no campo SKU com o codigo
 * no fim, e kits escritos como "MCS9102+MCS9155".
 *
 * TUDO AQUI E SUGESTAO, nunca aplicacao automatica. Casar errado nao da erro: da um custo de outro
 * produto entrando na margem, e ninguem percebe ate decidir preco em cima de um numero inventado.
 * Por isso cada sugestao carrega o motivo e um nivel de confianca, pra pessoa confirmar.
 */

export type Confianca = 'alta' | 'media' | 'baixa';

export interface Sugestao {
  skuDoMl: string;
  skuSugerido: string | null;
  /** Componentes, quando a sugestao vem de um kit. */
  componentes?: string[];
  custo: number | null;
  confianca: Confianca;
  motivo: string;
}

/** Reduz o codigo ao essencial: so letras e numeros, maiusculo. E o que faz hifen e ponto sumirem. */
export function normalizarParaComparacao(sku: string | null | undefined): string {
  if (typeof sku !== 'string') return '';
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Separa um SKU de kit. Aceita os separadores que aparecem na pratica: + e / */
export function separarKit(sku: string): string[] | null {
  const partes = sku.split(/[+/]/).map((p) => p.trim()).filter((p) => p.length > 0);
  return partes.length > 1 ? partes : null;
}

export interface IndiceTiny {
  /** normalizado -> sku original no Tiny */
  porNormalizado: Map<string, string>;
  /** sku original -> custo (ausente quando o Tiny nao tem custo cadastrado) */
  custos: Map<string, number>;
  /** normalizados com 5+ caracteres, do mais longo pro mais curto: usado na busca por codigo embutido */
  paraBuscaEmTexto: string[];
}

export function montarIndice(skusDoTiny: string[], custos: Record<string, number>): IndiceTiny {
  const porNormalizado = new Map<string, string>();
  const mapaCustos = new Map<string, number>();

  for (const sku of skusDoTiny) {
    const n = normalizarParaComparacao(sku);
    if (!n) continue;
    // Primeiro a chegar vence: dois codigos do Tiny que normalizam igual sao ambiguos, e trocar um
    // pelo outro a cada varredura daria sugestao instavel.
    if (!porNormalizado.has(n)) porNormalizado.set(n, sku);
    const c = custos[sku.trim().toUpperCase()];
    if (c != null && c > 0) mapaCustos.set(sku, c);
  }

  const paraBuscaEmTexto = [...porNormalizado.keys()]
    .filter((n) => n.length >= 5)
    .sort((a, b) => b.length - a.length);

  return { porNormalizado, custos: mapaCustos, paraBuscaEmTexto };
}

/** Similaridade 0..1 por distancia de edicao. So sustenta sugestao fraca, nunca decisao. */
export function similaridade(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = linha[j];
      linha[j] = Math.min(
        linha[j] + 1,
        linha[j - 1] + 1,
        anterior + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      anterior = temp;
    }
  }

  return 1 - linha[b.length] / Math.max(a.length, b.length);
}

/**
 * Propoe a correspondencia de UM sku do ML, em ordem de forca da evidencia.
 * Devolve null quando nada plausivel aparece — melhor sem sugestao que com sugestao ruim.
 */
export function sugerirCorrespondencia(skuDoMl: string, indice: IndiceTiny): Sugestao | null {
  const base = { skuDoMl, componentes: undefined as string[] | undefined };
  const custoDe = (sku: string): number | null => indice.custos.get(sku) ?? null;

  // 1. Mesmo codigo com pontuacao diferente. Evidencia forte: os caracteres sao os mesmos.
  const n = normalizarParaComparacao(skuDoMl);
  const direto = indice.porNormalizado.get(n);
  if (direto) {
    return {
      ...base,
      skuSugerido: direto,
      custo: custoDe(direto),
      confianca: 'alta',
      motivo: `Mesmo codigo ignorando hifen, ponto e espaco (${skuDoMl} = ${direto}).`,
    };
  }

  // 2. Kit: todos os componentes existem no Tiny. O custo do kit e a soma — e so vale se TODOS
  //    tiverem custo, senao a soma seria um numero pela metade se passando por custo cheio.
  const partes = separarKit(skuDoMl);
  if (partes) {
    const achados = partes.map((p) => indice.porNormalizado.get(normalizarParaComparacao(p)) ?? null);
    if (achados.every((a) => a)) {
      const custos = achados.map((a) => custoDe(a!));
      const todosComCusto = custos.every((c) => c != null);
      return {
        ...base,
        skuSugerido: achados.join(' + '),
        componentes: achados as string[],
        custo: todosComCusto ? Math.round(custos.reduce((s, c) => s + (c as number), 0) * 100) / 100 : null,
        confianca: 'alta',
        motivo: todosComCusto
          ? `Kit: soma do custo de ${achados.join(' + ')}.`
          : `Kit reconhecido, mas nem todo componente tem custo no Tiny (${achados.join(', ')}).`,
      };
    }
  }

  // 3. Codigo embutido no TEXTO: cobre o titulo inteiro colado no campo SKU.
  //
  //    Duas travas, as duas por falso positivo que o teste encontrou:
  //    - pega o candidato mais longo, senao "MCS55" casaria dentro de "MCS5590";
  //    - so aceita quando o SKU do ML e mesmo texto — tem espaco, ou e bem mais longo que o
  //      codigo. Sem isso, "MCS91020" casaria com "MCS9102" (diferenca de um digito, produtos
  //      diferentes) e entregaria o custo errado com confianca media.
  const pareceTexto = /\s/.test(skuDoMl);
  for (const candidato of indice.paraBuscaEmTexto) {
    if (!pareceTexto && n.length < candidato.length + 4) continue;
    if (n.includes(candidato)) {
      const original = indice.porNormalizado.get(candidato)!;
      return {
        ...base,
        skuSugerido: original,
        custo: custoDe(original),
        confianca: 'media',
        motivo: `O codigo ${original} aparece dentro do SKU do anuncio — provavelmente titulo colado no campo.`,
      };
    }
  }

  // 4. Parecido, mas nao igual. Sugestao fraca de proposito: serve pra olhar, nao pra aplicar.
  let melhor: { sku: string; score: number } | null = null;
  for (const [norm, original] of indice.porNormalizado) {
    const score = similaridade(n, norm);
    if (score >= 0.85 && (!melhor || score > melhor.score)) melhor = { sku: original, score };
  }
  if (melhor) {
    return {
      ...base,
      skuSugerido: melhor.sku,
      custo: custoDe(melhor.sku),
      confianca: 'baixa',
      motivo: `Parecido com ${melhor.sku} (${Math.round(melhor.score * 100)}% igual). CONFERIR: pode ser outro produto da mesma familia.`,
    };
  }

  return null;
}
