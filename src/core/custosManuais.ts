import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { chaveSku } from './custos';

/**
 * CUSTO DIGITADO NO PAINEL (v54).
 *
 * Quando o Tiny esta sem custo (ou com custo errado) para um produto, o custo pode ser informado na aba
 * Custos. Vale mais que o do Tiny em todo lugar que le custo: margem, ficha de lucro, promocoes, Gerente e
 * Central. Fica guardado SO aqui (data/custos-manuais.json); o Tiny nao e alterado.
 *
 * Por SKU (vale para todos os anuncios do produto) ou por anuncio (para anuncio sem SKU, ou um anuncio que
 * precisa de custo proprio, como um kit vendido com o SKU da unidade). O do anuncio vale mais que o do SKU.
 */

export interface CustoManual {
  tipo: 'sku' | 'anuncio';
  /** SKU normalizado ou id do anuncio (MLB...) */
  chave: string;
  custo: number;
  obs: string | null;
  em: string;
}
export type CustosManuais = Record<string, CustoManual>;

const chaveDoMapa = (tipo: CustoManual['tipo'], chave: string) => `${tipo}:${chave}`;
const caminho = () => path.join(config.dataDir, 'custos-manuais.json');

let cache: CustosManuais | null = null;

export function listarManuais(): CustosManuais {
  if (cache) return cache;
  try {
    cache = fs.existsSync(caminho()) ? JSON.parse(fs.readFileSync(caminho(), 'utf-8')) : {};
  } catch (err: any) {
    logger.warn('[CUSTOS] custos-manuais.json ilegivel; seguindo sem custo manual:', err?.message || err);
    cache = {};
  }
  return cache!;
}

function gravar(m: CustosManuais): void {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = caminho() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1), 'utf-8');
  fs.renameSync(tmp, caminho());
  cache = m;
}

/** Normaliza a chave: SKU como em todo o sistema; anuncio em maiusculas (MLB123). */
export function normalizarChave(tipo: CustoManual['tipo'], chave: string | null | undefined): string | null {
  if (tipo === 'sku') return chaveSku(chave);
  const k = String(chave ?? '').trim().toUpperCase();
  return /^[A-Z]{3}\d+$/.test(k) ? k : null;
}

export function salvarManual(tipo: CustoManual['tipo'], chave: string, custo: number, obs?: string | null): CustoManual {
  const k = normalizarChave(tipo, chave);
  if (!k) throw new Error(tipo === 'sku' ? 'SKU vazio.' : 'Anúncio inválido (use o código MLB...).');
  if (!Number.isFinite(custo) || custo <= 0) throw new Error('Informe um custo maior que zero.');
  const novo: CustoManual = { tipo, chave: k, custo: Math.round(custo * 100) / 100, obs: obs?.trim() ? obs.trim().slice(0, 200) : null, em: new Date().toISOString() };
  gravar({ ...listarManuais(), [chaveDoMapa(tipo, k)]: novo });
  logger.info(`[CUSTOS] custo manual ${tipo} ${k} = ${novo.custo}`);
  return novo;
}

export function removerManual(tipo: CustoManual['tipo'], chave: string): boolean {
  const k = normalizarChave(tipo, chave);
  const m = { ...listarManuais() };
  if (!k || !m[chaveDoMapa(tipo, k)]) return false;
  delete m[chaveDoMapa(tipo, k)];
  gravar(m);
  logger.info(`[CUSTOS] custo manual ${tipo} ${k} removido`);
  return true;
}

/** Custo manual que vale para um anuncio: o do anuncio, senao o do SKU. PURA. */
export function custoManualDe(m: CustosManuais, itemId: string | null | undefined, sku: string | null | undefined): CustoManual | null {
  const id = itemId ? normalizarChave('anuncio', itemId) : null;
  const k = chaveSku(sku);
  return (id ? m[chaveDoMapa('anuncio', id)] : undefined) ?? (k ? m[chaveDoMapa('sku', k)] : undefined) ?? null;
}

/** "1.234,56", "75,5", "75.50" ou 75.5 -> numero. PURA. */
export function lerReais(v: unknown): number {
  if (typeof v === 'number') return v;
  let t = String(v ?? '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}

/** So para testes. */
export function _definirManuais(m: CustosManuais | null): void {
  cache = m;
}
