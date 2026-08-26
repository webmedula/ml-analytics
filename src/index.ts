import { config } from './config';
import { logger } from './logger';
import { buildServer } from './server';
import { startCatalogLoop } from './core/catalogCompetition';
import { startConversionLoop } from './core/conversion';
import { startRatingsLoop } from './core/listingRatings';
import { abrirBanco } from './db/banco';
import { startSincronizacaoLoop } from './db/ingestao';

async function main(): Promise<void> {
  // Antes do servidor: se o esquema nao puder ser criado, e melhor falhar no boot que na consulta.
  abrirBanco();
  const app = buildServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`tiny-analytics ${config.appVersion} rodando em http://localhost:${config.port}`);
  logger.info(`Painel: http://localhost:${config.port}/`);
  logger.info(`Para conectar ao Mercado Livre: http://localhost:${config.port}/oauth/ml/login`);

  startCatalogLoop();
  startConversionLoop();
  startRatingsLoop();
  startSincronizacaoLoop();
}

main().catch((err) => {
  logger.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
