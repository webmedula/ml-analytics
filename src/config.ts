import 'dotenv/config';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';

export const config = {
  /** Versao — atualize a cada release. Exibida no cabecalho e em /health, sempre vinda do SERVIDOR. */
  appVersion: 'analytics v3 (2026-07-24)',

  port: Number(process.env.PORT || 3010),
  serviceApiKey: process.env.SERVICE_API_KEY || '',

  // Aplicativo PROPRIO deste servico no Mercado Livre (separado do tiny-pedidos-nf).
  mlClientId: process.env.ML_CLIENT_ID || '',
  mlClientSecret: process.env.ML_CLIENT_SECRET || '',
  mlRedirectUri: process.env.ML_REDIRECT_URI || 'http://localhost:3010/oauth/ml/callback',
  mlAuthUrl: 'https://auth.mercadolivre.com.br/authorization',
  mlTokenUrl: 'https://api.mercadolibre.com/oauth/token',
  mlApiBaseUrl: 'https://api.mercadolibre.com',

  // Analise de catalogo / Buy Box
  catalogScanMaxItems: Number(process.env.CATALOG_SCAN_MAX_ITEMS || 500),
  catalogScanIntervalHours: Number(process.env.CATALOG_SCAN_INTERVAL_HOURS || 6),

  dataDir,
  mlTokenStorePath: path.join(dataDir, 'ml-token.json'),
  catalogCompetitionCachePath: path.join(dataDir, 'catalog-competition-cache.json'),
};
