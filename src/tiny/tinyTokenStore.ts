import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface StoredTinyToken {
  accessToken: string;
  refreshToken: string;
  /** epoch ms em que o access token expira */
  accessExpiresAt: number;
  obtainedAt: number;
}

let cached: StoredTinyToken | null = null;
let cachedMtimeMs = 0;

function ensureDir(): void {
  const dir = path.dirname(config.tinyTokenStorePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadTinyToken(): StoredTinyToken | null {
  try {
    if (!fs.existsSync(config.tinyTokenStorePath)) {
      cached = null;
      cachedMtimeMs = 0;
      return null;
    }
    const mtime = fs.statSync(config.tinyTokenStorePath).mtimeMs;
    if (cached && mtime === cachedMtimeMs) return cached;
    cached = JSON.parse(fs.readFileSync(config.tinyTokenStorePath, 'utf-8')) as StoredTinyToken;
    cachedMtimeMs = mtime;
    return cached;
  } catch {
    return cached;
  }
}

export function saveTinyToken(token: StoredTinyToken): void {
  ensureDir();
  cached = token;
  const tmp = config.tinyTokenStorePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), 'utf-8');
  fs.renameSync(tmp, config.tinyTokenStorePath);
  try {
    cachedMtimeMs = fs.statSync(config.tinyTokenStorePath).mtimeMs;
  } catch {
    cachedMtimeMs = 0;
  }
}

export function clearTinyToken(): void {
  cached = null;
  cachedMtimeMs = 0;
  try {
    if (fs.existsSync(config.tinyTokenStorePath)) fs.unlinkSync(config.tinyTokenStorePath);
  } catch {
    // ignore
  }
}
