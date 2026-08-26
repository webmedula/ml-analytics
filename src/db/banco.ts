import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config';
import { logger } from '../logger';

/**
 * BANCO LOCAL (SQLite) — onde tudo fica guardado de verdade.
 *
 * Ate aqui o sistema so tinha caches: retratos do momento, sobrescritos a cada varredura, presos a
 * janela de 30 dias que a API do ML aceita consultar. Isso responde "como estou agora" e nunca
 * "como estava em maio".
 *
 * Com a linha de pedido gravada por (pedido, item), cada varredura ACUMULA em vez de substituir. Em
 * alguns meses existe base pra comparar periodos, medir efeito de promocao e ver sazonalidade —
 * coisas que hoje sao impossiveis, nao por falta de codigo, mas por falta de dado guardado.
 *
 * SQLite nativo do Node: sem dependencia com compilacao nativa, que na imagem alpine seria uma
 * fonte permanente de problema de build.
 */

let db: DatabaseSync | null = null;

/**
 * Carrega o SQLite na HORA DE USAR, e nao no topo do arquivo.
 *
 * `node:sqlite` nao aparece em `module.builtinModules` enquanto e experimental, e por isso o
 * empacotador do vitest tenta resolver como se fosse um pacote no disco — derrubando todo teste que
 * apenas importa este modulo, mesmo sem tocar no banco. Carregar aqui dentro resolve isso e ainda
 * transforma a ausencia numa mensagem util em vez de um erro de resolucao no boot.
 */
function carregarSqlite(): typeof import('node:sqlite') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:sqlite');
  } catch (err: any) {
    throw new Error(
      'Este servico precisa do SQLite nativo do Node (node:sqlite), disponivel a partir do Node 22. ' +
      `Versao em uso: ${process.version}. Atualize a imagem base. Detalhe: ${err?.message || err}`,
    );
  }
}

export function caminhoDoBanco(): string {
  return path.join(config.dataDir, 'analytics.db');
}

/** Cria as tabelas se faltarem. Roda a cada abertura: barato, e deixa o esquema versionado no codigo. */
function migrar(banco: DatabaseSync): void {
  banco.exec(`
    PRAGMA journal_mode = WAL;

    -- Uma linha por (pedido, anuncio). E o registro que nunca deve ser perdido: a partir dele
    -- qualquer agregacao pode ser recalculada.
    CREATE TABLE IF NOT EXISTS vendas (
      order_id       TEXT NOT NULL,
      item_id        TEXT NOT NULL,
      data_criacao   TEXT,
      data           TEXT,              -- YYYY-MM-DD, pra agrupar sem funcao de data
      status         TEXT,
      sku            TEXT,
      titulo         TEXT,
      quantidade     INTEGER,
      preco_unitario REAL,
      sale_fee       REAL,              -- comissao POR UNIDADE, como o ML informa
      bruto          REAL,              -- preco_unitario * quantidade
      comissao       REAL,              -- sale_fee * quantidade
      shipment_id    TEXT,
      frete          REAL,              -- rateado; preenchido quando o envio e resolvido
      registrado_em  TEXT,
      PRIMARY KEY (order_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data);
    CREATE INDEX IF NOT EXISTS idx_vendas_item ON vendas(item_id);
    CREATE INDEX IF NOT EXISTS idx_vendas_sku  ON vendas(sku);

    -- Retrato atual de cada anuncio. Sobrescrito a cada varredura (o historico de vendas mora em vendas).
    CREATE TABLE IF NOT EXISTS anuncios (
      item_id            TEXT PRIMARY KEY,
      titulo             TEXT,
      sku                TEXT,
      origem_do_sku      TEXT,
      permalink          TEXT,
      status             TEXT,
      catalogo           INTEGER,
      catalog_product_id TEXT,
      preco              REAL,
      estoque            INTEGER,
      visitas_30         INTEGER,
      visitas_7          INTEGER,
      nota               REAL,
      avaliacoes         INTEGER,
      classificacao_nota TEXT,
      custo              REAL,
      estado_do_custo    TEXT,
      atualizado_em      TEXT
    );

    -- Custo por SKU, vindo do Tiny.
    CREATE TABLE IF NOT EXISTS custos (
      sku           TEXT PRIMARY KEY,
      custo         REAL,
      atualizado_em TEXT
    );

    -- Uma linha por anuncio por dia: estoque e preco mudam e ninguem guarda o passado deles.
    CREATE TABLE IF NOT EXISTS snapshots_diarios (
      data          TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      preco         REAL,
      estoque       INTEGER,
      visitas_30    INTEGER,
      nota          REAL,
      PRIMARY KEY (data, item_id)
    );

    CREATE TABLE IF NOT EXISTS sincronizacoes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      quando        TEXT,
      vendas_novas  INTEGER,
      vendas_totais INTEGER,
      anuncios      INTEGER,
      custos        INTEGER,
      duracao_ms    INTEGER,
      erro          TEXT
    );
  `);
}

export function abrirBanco(): DatabaseSync {
  if (db) return db;
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  const { DatabaseSync: Banco } = carregarSqlite();
  db = new Banco(caminhoDoBanco());
  migrar(db);
  logger.info(`[BANCO] Aberto em ${caminhoDoBanco()}`);
  return db;
}

/**
 * O banco esta utilizavel? Devolve o motivo quando nao — sem lancar excecao.
 *
 * Existe pra /health poder responder, e pro servidor subir mesmo se o SQLite faltar. Derrubar o
 * boot por causa disso deixaria o servico inteiro fora do ar por um recurso que so parte das rotas
 * usa — e, num painel onde o deploy e manual, trocaria um problema visivel por um servico morto.
 */
export function estadoDoBanco(): { disponivel: boolean; caminho: string; node: string; motivo?: string; vendas?: number } {
  try {
    const banco = abrirBanco();
    const n = banco.prepare('SELECT COUNT(*) AS n FROM vendas').all() as Array<{ n: number }>;
    return { disponivel: true, caminho: caminhoDoBanco(), node: process.version, vendas: n[0]?.n ?? 0 };
  } catch (err: any) {
    return {
      disponivel: false,
      caminho: caminhoDoBanco(),
      node: process.version,
      motivo: err?.message || String(err),
    };
  }
}

export function fecharBanco(): void {
  db?.close();
  db = null;
}

// --------------------------------------------------------------- consulta segura

export class ConsultaInvalida extends Error {}

/** Palavras que mudam dados ou escapam do banco. Uma sozinha ja reprova a consulta. */
const PROIBIDAS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|trigger)\b/i;

/**
 * Valida uma consulta antes de executar.
 *
 * A conexao ja poderia ser somente-leitura, mas a validacao existe alem disso: quem monta o SQL
 * aqui e um modelo de linguagem, e defesa em uma camada so e defesa nenhuma. Vale tambem contra o
 * acidente — um SQL gerado errado que apagaria a base sem nenhuma ma intencao.
 */
export function validarConsulta(sql: string): string {
  const limpo = (sql || '').trim().replace(/;+\s*$/, '');
  if (!limpo) throw new ConsultaInvalida('Consulta vazia.');

  // Mais de um comando: e assim que se esconde um DELETE atras de um SELECT.
  if (limpo.includes(';')) throw new ConsultaInvalida('Apenas um comando por consulta (sem ";" no meio).');
  if (!/^(select|with)\b/i.test(limpo)) throw new ConsultaInvalida('Apenas SELECT (ou WITH ... SELECT).');
  if (PROIBIDAS.test(limpo)) throw new ConsultaInvalida('A consulta contem um comando que altera dados. Somente leitura aqui.');

  return limpo;
}

export interface ResultadoDaConsulta {
  colunas: string[];
  linhas: any[];
  total: number;
  truncado: boolean;
}

/**
 * Executa um SELECT e devolve as linhas, com teto.
 *
 * O teto nao e detalhe: uma consulta sem WHERE numa tabela de vendas devolveria a base inteira pro
 * contexto do modelo — caro, lento, e ainda estouraria o limite de tokens no meio da resposta.
 */
export function consultar(sql: string, limite = 200): ResultadoDaConsulta {
  const limpo = validarConsulta(sql);
  const banco = abrirBanco();

  const stmt = banco.prepare(limpo);
  const todas = stmt.all() as any[];
  const linhas = todas.slice(0, limite);

  return {
    colunas: linhas.length > 0 ? Object.keys(linhas[0]) : [],
    linhas,
    total: todas.length,
    truncado: todas.length > linhas.length,
  };
}

/** O esquema em texto — e o que o modelo precisa ler pra escrever SQL que funcione. */
export function descreverEsquema(): string {
  const banco = abrirBanco();
  const tabelas = banco
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string; sql: string }>;

  return tabelas
    .map((t) => {
      const linhas = banco.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).all() as Array<{ n: number }>;
      return `${t.sql};\n-- ${linhas[0]?.n ?? 0} linha(s)`;
    })
    .join('\n\n');
}
