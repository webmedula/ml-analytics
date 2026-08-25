import 'dotenv/config';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';

export const config = {
  /** Versao — atualize a cada release. Exibida no cabecalho e em /health, sempre vinda do SERVIDOR. */
  appVersion: 'analytics v17 (2026-08-25)',

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

  // Analise de conversao (visitas x vendas)
  conversionMaxItems: Number(process.env.CONVERSION_MAX_ITEMS || 500),

  // Diagnostico de notas / candidatos a recriacao de anuncio
  ratingsScanMaxItems: Number(process.env.RATINGS_SCAN_MAX_ITEMS || 500),
  ratingsScanIntervalHours: Number(process.env.RATINGS_SCAN_INTERVAL_HOURS || 12),
  /** Nota minima aceitavel: abaixo disso o anuncio vira candidato. */
  ratingsMinScore: Number(process.env.RATINGS_MIN_SCORE || 4.5),
  /** Minimo de opinioes pra levar a nota a serio (evita agir por causa de 1 review ruim). */
  ratingsMinReviews: Number(process.env.RATINGS_MIN_REVIEWS || 3),

  // --- serie diaria (historico) ---
  /** Quantos dias de historico manter. 400 cobre um ano e a comparacao com o mesmo mes anterior. */
  historyRetencaoDias: Number(process.env.HISTORY_RETENCAO_DIAS || 400),

  /** Teto de envios novos consultados por varredura. A primeira execucao nao deve comer a cota
   * inteira do ML: pega os mais recentes e as proximas varreduras completam o passado. */
  fretesPorVarredura: Number(process.env.FRETES_POR_VARREDURA || 300),

  // --- reposicao de estoque ---
  /** Dias entre fazer o pedido e a mercadoria estar disponivel pra vender. */
  prazoEntregaDias: Number(process.env.PRAZO_ENTREGA_DIAS || 15),
  /** De quanto em quanto tempo voce faz pedido (7 = semanal, 15 = quinzenal). */
  cicloCompraDias: Number(process.env.CICLO_COMPRA_DIAS || 15),
  /** Nivel de servico em z-score: 1.65 ~ 95%. Maior = menos ruptura e mais capital parado. */
  nivelServicoZ: Number(process.env.NIVEL_SERVICO_Z || 1.65),

  dataDir,
  mlTokenStorePath: path.join(dataDir, 'ml-token.json'),
  catalogCompetitionCachePath: path.join(dataDir, 'catalog-competition-cache.json'),
  conversionCachePath: path.join(dataDir, 'conversion-cache.json'),
  ratingsCachePath: path.join(dataDir, 'listing-ratings-cache.json'),
  historyDir: path.join(dataDir, 'history'),
};
