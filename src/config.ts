import 'dotenv/config';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';

export const config = {
  /** Versao — atualize a cada release. Exibida no cabecalho e em /health, sempre vinda do SERVIDOR. */
  appVersion: 'analytics v31 (2026-08-27)',

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

  // --- Tiny (API v3, OAuth2) ---
  // APLICATIVO PROPRIO deste servico, separado do que o tiny-pedidos-nf usa: se o Tiny invalidar
  // o refresh token anterior a cada renovacao, servicos compartilhando o app se derrubam — e um
  // deles emite nota fiscal.
  tinyClientId: process.env.TINY_CLIENT_ID || '',
  tinyClientSecret: process.env.TINY_CLIENT_SECRET || '',
  tinyRedirectUri: process.env.TINY_REDIRECT_URI || 'http://localhost:3010/oauth/tiny/callback',
  /** URLs configuraveis: nao consegui confirmar na documentacao (o Tiny bloqueia leitura
   * automatizada). Se o portal do Tiny mostrar endereços diferentes, ajuste por variavel. */
  tinyAuthUrl: process.env.TINY_AUTH_URL || 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth',
  tinyTokenUrl: process.env.TINY_TOKEN_URL || 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token',
  tinyApiBaseUrl: (process.env.TINY_API_BASE_URL || 'https://api.tiny.com.br/public-api/v3').replace(/\/+$/, ''),
  /** Por quanto tempo o custo lido do Tiny e considerado valido. Custo muda pouco; cada consulta
   * e uma chamada ao ERP, e menos renovacao de token = menos risco de conflito. */
  custosValidadeHoras: Number(process.env.CUSTOS_VALIDADE_HORAS || 24),

  // --- assistente (Telegram) ---
  /** 'anthropic' | 'openrouter'. Vazio = usa a chave que estiver configurada. */
  assistenteProvedor: process.env.ASSISTENTE_PROVEDOR || '',
  /** Id do modelo. Vazio funciona na Anthropic (ela pergunta a API); no OpenRouter e obrigatorio,
   * porque o catalogo tem centenas de modelos com precos e capacidades muito diferentes. */
  assistenteModelo: process.env.ASSISTENTE_MODELO || process.env.ANTHROPIC_MODEL || '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',

  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  /** Teto de idas e voltas com ferramentas numa pergunta. Segura pergunta que nao converge. */
  assistenteMaxPassos: Number(process.env.ASSISTENTE_MAX_PASSOS || 6),
  assistenteMaxTokens: Number(process.env.ASSISTENTE_MAX_TOKENS || 1500),

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  /** Segredo no CAMINHO do webhook: sem ele o Telegram nem alcanca a rota. */
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  /** Quem pode conversar com o bot. VAZIO = ninguem (o bot so informa o proprio chat id). */
  telegramChatIds: (process.env.TELEGRAM_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Endereco publico deste servico — usado pra registrar o webhook no Telegram. */
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),

  /** De quanto em quanto tempo a base local e alimentada com o que as varreduras acharam. */
  sincronizacaoIntervaloHoras: Number(process.env.SINCRONIZACAO_INTERVALO_HORAS || 6),

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
  tinyTokenStorePath: path.join(dataDir, 'tiny-token.json'),
  custosCachePath: path.join(dataDir, 'custos.json'),
};
