import { config } from './config';
import { logger } from './logger';
import { buildServer } from './server';
import { startCatalogLoop } from './core/catalogCompetition';
import { startConversionLoop } from './core/conversion';

async function main(): Promise<void> {
  const app = buildServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`tiny-analytics ${config.appVersion} rodando em http://localhost:${config.port}`);
  logger.info(`Painel: http://localhost:${config.port}/`);
  logger.info(`Para conectar ao Mercado Livre: http://localhost:${config.port}/oauth/ml/login`);

  startCatalogLoop();
  startConversionLoop();
}

main().catch((err) => {
  logger.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
