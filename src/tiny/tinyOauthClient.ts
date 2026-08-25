import crypto from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { clearTinyToken, loadTinyToken, saveTinyToken, StoredTinyToken } from './tinyTokenStore';

/**
 * OAuth2 do Tiny (API v3, baseada em Keycloak).
 *
 * Mesmo desenho do cliente do Mercado Livre, com uma diferenca importante de politica: este
 * servico usa um APLICATIVO PROPRIO do Tiny, separado do que o tiny-pedidos-nf usa. Se os dois
 * compartilhassem o app e o Tiny invalidasse o refresh token anterior a cada renovacao, o servico
 * que emite nota fiscal poderia parar — nao e um risco que valha economizar alguns cliques.
 *
 * As URLs sao configuraveis porque nao consegui confirma-las na documentacao (o Tiny bloqueia
 * leitura automatizada). Os padroes sao os valores conhecidos; se o portal mostrar outros, e so
 * ajustar as variaveis de ambiente sem mexer no codigo.
 */

export class TinyNotAuthenticatedError extends Error {
  constructor() {
    super('Tiny ainda nao autorizado. Acesse /oauth/tiny/login para conectar.');
    this.name = 'TinyNotAuthenticatedError';
  }
}

const pendingStates = new Set<string>();

export function tinyConfigurado(): boolean {
  return !!(config.tinyClientId && config.tinyClientSecret);
}

export function buildTinyAuthorizationUrl(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref();

  const url = new URL(config.tinyAuthUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.tinyClientId);
  url.searchParams.set('redirect_uri', config.tinyRedirectUri);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', state);
  return url.toString();
}

export function isValidTinyState(state: string | undefined): boolean {
  if (!state) return false;
  const ok = pendingStates.has(state);
  if (ok) pendingStates.delete(state);
  return ok;
}

function persistir(data: any): StoredTinyToken {
  const now = Date.now();
  const token: StoredTinyToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: now + Number(data.expires_in ?? 3600) * 1000,
    obtainedAt: now,
  };
  saveTinyToken(token);
  return token;
}

async function pedirToken(body: URLSearchParams): Promise<any> {
  const res = await fetch(config.tinyTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const texto = await res.text();
  let dados: any;
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { raw: texto };
  }
  if (!res.ok) {
    const detalhe = dados?.error_description || dados?.error || texto || `HTTP ${res.status}`;
    throw new Error(`Tiny recusou o token (${res.status}): ${detalhe}`);
  }
  return dados;
}

export async function exchangeTinyCodeForToken(code: string): Promise<StoredTinyToken> {
  return persistir(
    await pedirToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.tinyClientId,
        client_secret: config.tinyClientSecret,
        redirect_uri: config.tinyRedirectUri,
        code,
      }),
    ),
  );
}

/**
 * Devolve um access token valido, renovando so quando falta pouco pra expirar.
 *
 * A margem e curta (2 min) de proposito: quanto menos renovacoes, menor a chance de conflito com
 * qualquer outro cliente do mesmo usuario no Tiny.
 */
export async function ensureValidTinyToken(): Promise<string> {
  const atual = loadTinyToken();
  if (!atual) throw new TinyNotAuthenticatedError();

  if (Date.now() < atual.accessExpiresAt - 2 * 60 * 1000) return atual.accessToken;

  try {
    const novo = persistir(
      await pedirToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.tinyClientId,
          client_secret: config.tinyClientSecret,
          refresh_token: atual.refreshToken,
        }),
      ),
    );
    return novo.accessToken;
  } catch (err: any) {
    // invalid_grant aqui quase sempre significa que o refresh token foi invalidado — por expiracao
    // ou por outro cliente ter renovado no mesmo app. Limpa e pede reconexao explicita, em vez de
    // ficar tentando em silencio.
    logger.warn('[TINY] Falha ao renovar o token:', err?.message || err);
    if (/invalid_grant/i.test(String(err?.message || ''))) {
      clearTinyToken();
      throw new Error(
        'O token do Tiny foi invalidado (invalid_grant). Reconecte em /oauth/tiny/login. ' +
        'Se isso passar a acontecer com frequencia, o app do Tiny pode estar sendo compartilhado com outro servico.',
      );
    }
    throw err;
  }
}

export function getTinyAuthStatus(): { configurado: boolean; authenticated: boolean; expiraEm: string | null } {
  const t = loadTinyToken();
  return {
    configurado: tinyConfigurado(),
    authenticated: !!t,
    expiraEm: t ? new Date(t.accessExpiresAt).toISOString() : null,
  };
}
