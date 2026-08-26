import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { logger } from '../logger';
import { listarModelos, perguntar, resolverModelo } from '../assistant/claudeClient';
import { provedorAtivo } from '../assistant/provedores';

/**
 * BOT DO TELEGRAM.
 *
 * Duas travas, porque cada mensagem respondida custa dinheiro e devolve dado financeiro da loja:
 *
 * 1. O caminho do webhook carrega um segredo. Sem ele o Telegram nem alcanca a rota — e o endereco
 *    nao aparece em lugar nenhum.
 * 2. So os chat ids da lista recebem resposta. Qualquer um pode achar um bot pelo nome e mandar
 *    mensagem; sem a lista, um estranho leria o faturamento e ainda gastaria a sua cota de API.
 *
 * Com a lista VAZIA o bot entra em modo de cadastro: responde so o proprio chat id, sem dado
 * nenhum, pra voce descobrir o seu e preencher a variavel. E o unico jeito de descobrir o id sem
 * expor dado por engano.
 */

const ultimosChatIds = new Set<string>();

function permitido(chatId: string): boolean {
  return config.telegramChatIds.length === 0 ? false : config.telegramChatIds.includes(chatId);
}

async function enviar(chatId: string, texto: string): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Sem parse_mode: o texto do modelo pode conter _ ou * soltos, e o Telegram rejeita a
      // mensagem inteira quando o markdown nao fecha. Texto puro sempre entrega.
      body: JSON.stringify({ chat_id: chatId, text: texto.slice(0, 4000) }),
    });
    if (!res.ok) logger.warn('[TELEGRAM] Falha ao enviar:', await res.text());
  } catch (err: any) {
    logger.warn('[TELEGRAM] Erro de rede ao enviar:', err?.message || err);
  }
}

export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Webhook. Responde 200 sempre e processa em background: o Telegram reenvia a mesma mensagem se
   * demorar, e uma pergunta que leva 15s viraria tres perguntas cobradas.
   */
  app.post('/telegram/webhook/:segredo', async (req, reply) => {
    const { segredo } = req.params as { segredo: string };
    if (!config.telegramWebhookSecret || segredo !== config.telegramWebhookSecret) {
      reply.code(404);
      return { mensagem: 'nao encontrado' };
    }

    const update = req.body as any;
    const msg = update?.message ?? update?.edited_message;
    const chatId = String(msg?.chat?.id ?? '');
    const texto = String(msg?.text ?? '').trim();

    reply.code(200).send({ ok: true });
    if (!chatId || !texto) return;

    ultimosChatIds.add(chatId);

    if (!permitido(chatId)) {
      logger.warn(`[TELEGRAM] Mensagem de chat nao autorizado: ${chatId}`);
      if (config.telegramChatIds.length === 0) {
        await enviar(chatId, `Bot ainda nao liberado. Seu chat id e: ${chatId}\n\nColoque esse numero na variavel TELEGRAM_CHAT_IDS do servico e reinicie.`);
      }
      return;
    }

    if (texto === '/start' || texto === '/ajuda') {
      await enviar(chatId,
        'Pode perguntar em portugues sobre a operacao. Exemplos:\n\n' +
        '- qual o produto mais vendido do mes?\n' +
        '- quais anuncios dao mais lucro?\n' +
        '- tem algum anuncio com margem negativa?\n' +
        '- o que preciso comprar essa semana?\n' +
        '- por que a margem do MLB123 nao aparece?\n' +
        '- como estao as notas dos anuncios?\n\n' +
        'Eu so leio dados: nao altero anuncio, preco nem estoque.');
      return;
    }

    try {
      const r = await perguntar(texto);
      logger.info(`[TELEGRAM] "${texto.slice(0, 60)}" -> ${r.passos} passo(s), ferramentas: ${r.ferramentasUsadas.join(', ') || 'nenhuma'}`);
      await enviar(chatId, r.texto);
    } catch (err: any) {
      logger.error('[TELEGRAM] Erro ao responder:', err?.message || err);
      await enviar(chatId, `Nao consegui responder: ${err?.message || 'erro desconhecido'}`);
    }
  });

  /** Estado do assistente: provedor ativo, modelos que servem, e o que ainda falta configurar. */
  app.get('/debug/assistente', async () => {
    const provedor = provedorAtivo();
    const estado: any = {
      provedorAtivo: provedor.nome,
      provedorConfigurado: provedor.configurado(),
      chaves: {
        anthropic: config.anthropicApiKey ? 'configurada' : 'ausente',
        openrouter: config.openrouterApiKey ? 'configurada' : 'ausente',
      },
      modeloFixado: config.assistenteModelo || '(automatico)',
      telegramBotToken: config.telegramBotToken ? 'configurado' : 'FALTANDO',
      telegramWebhookSecret: config.telegramWebhookSecret ? 'configurado' : 'FALTANDO',
      chatIdsLiberados: config.telegramChatIds.length,
      chatIdsVistosRecentemente: [...ultimosChatIds],
    };

    if (provedor.configurado()) {
      try {
        const modelos = await listarModelos();
        estado.modelosQueAceitamFerramenta = modelos.length;
        // Lista longa demais nao ajuda a escolher; 40 ja cobre os conhecidos.
        estado.modelosDisponiveis = modelos.slice(0, 40);
        estado.modeloEmUso = await resolverModelo(true);
      } catch (err: any) {
        estado.erroNaApi = err?.message || String(err);
      }
    }

    estado.webhookParaRegistrar = config.telegramWebhookSecret
      ? `${config.baseUrl}/telegram/webhook/${config.telegramWebhookSecret}`
      : '(defina TELEGRAM_WEBHOOK_SECRET)';
    return estado;
  });

  /** Registra o webhook no Telegram, pra nao ser preciso montar a chamada na mao. */
  app.get('/debug/telegram/registrar', async (_req, reply) => {
    if (!config.telegramBotToken || !config.telegramWebhookSecret) {
      reply.code(409);
      return { mensagem: 'Faltam TELEGRAM_BOT_TOKEN e/ou TELEGRAM_WEBHOOK_SECRET.' };
    }
    const url = `${config.baseUrl}/telegram/webhook/${config.telegramWebhookSecret}`;
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, allowed_updates: ['message'] }),
    });
    return { enviado: url, resposta: await res.json().catch(() => null) };
  });

  /** Pergunta pelo navegador, pra testar o assistente sem depender do Telegram. */
  app.get('/debug/perguntar', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) return { mensagem: 'Use ?q=sua+pergunta&key=SUA_CHAVE' };
    try {
      return await perguntar(q);
    } catch (err: any) {
      reply.code(500);
      return { mensagem: err?.message || 'Erro no assistente' };
    }
  });
}
