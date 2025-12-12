import express from 'express';
import type { Server } from 'http';
import { config } from './config';
import { createBot } from './bot';
import { createGitLabWebhookHandler } from './gitlab/webhook';
import { ensureMongoConnection } from './db/mongo';

const bot = createBot(config.botToken);

const app = express();
app.use(express.json());
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.post('/debug/ping', (req, res) => {
  res.json({
    message: 'pong',
    body: req.body ?? null,
  });
});
app.post(config.gitlab.path, createGitLabWebhookHandler(bot));

let server: Server | undefined;

const start = async (): Promise<void> => {
  await ensureMongoConnection();

  if (config.mode === 'webhook') {
    const { domain, path, secretToken } = config.webhook;
    if (!domain) {
      throw new Error('Cannot start webhook mode without TELEGRAM_WEBHOOK_DOMAIN');
    }

    const webhookUrl = `${domain}${path}`;
    const secretOptions = secretToken ? { secret_token: secretToken } : undefined;

    await bot.telegram.setWebhook(webhookUrl, secretOptions);

    const webhookMiddleware = bot.webhookCallback(path, secretToken ? { secretToken } : undefined);
    app.use(webhookMiddleware);

    server = app.listen(config.port, () => {
      console.log(`Webhook server listening on port ${config.port}`);
      console.log(`Telegram will call: ${webhookUrl}`);
    });
  } else {
    await bot.launch();
    console.log('Bot started in long-polling mode');
  }
};

start().catch((error) => {
  console.error('Failed to boot bot', error);
  process.exit(1);
});

const cleanup = (signal: string): void => {
  console.log(`Received ${signal}, shutting down...`);
  server?.close();
  bot.stop(signal);
};

process.once('SIGINT', () => cleanup('SIGINT'));
process.once('SIGTERM', () => cleanup('SIGTERM'));
