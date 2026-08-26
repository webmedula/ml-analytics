import { config } from './config';
import { logger } from './logger';
import { buildServer } from './server';
import { startCatalogLoop } from './core/catalogCompetition';
import { startConversionLoop } from './core/conversion';
import { startRatingsLoop } from './core/listingRatings';
import { estadoDoBanco } from './db/banco';
import { startSincronizacaoLoop } from './db/ingestao';

async function main(): Promise<void> {
  // O banco e util, mas nao e condicao pro servico existir: painel, OAuth e varreduras funcionam
  // sem ele. Falhar aqui deixaria tudo fora do ar por causa de uma parte — e num deploy manual isso
  // aparece como "a versao nova nao sobe", sem dizer por que. Avisa e segue; /health conta o resto.
  const banco = estadoDoBanco();
  if (banco.disponivel) logger.info(`[BANCO] Pronto (${banco.vendas} venda(s) guardadas).`);
  else logger.warn(`[BANCO] Indisponivel, o servico segue sem ele: ${banco.motivo}`);

  const app = buildServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`tiny-analytics ${config.appVersion} rodando em http://localhost:${config.port}`);
  logger.info(`Painel: http://localhost:${config.port}/`);
  logger.info(`Para conectar ao Mercado Livre: http://localhost:${config.port}/oauth/ml/login`);

  startCatalogLoop();
  startConversionLoop();
  startRatingsLoop();
  // Sem banco nao ha o que sincronizar; ligar o loop so encheria o log de erro repetido.
  if (banco.disponivel) startSincronizacaoLoop();
}

main().catch((err) => {
  logger.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
