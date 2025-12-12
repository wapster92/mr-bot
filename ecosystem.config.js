require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'mr-bot',
      script: 'dist/index.js',
      env: {
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        BOT_MODE: process.env.BOT_MODE || 'webhook',
        PORT: process.env.PORT || 3000,
        TELEGRAM_WEBHOOK_DOMAIN: process.env.TELEGRAM_WEBHOOK_DOMAIN,
        TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook',
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
        GITLAB_WEBHOOK_PATH: process.env.GITLAB_WEBHOOK_PATH || '/gitlab/webhook',
        GITLAB_WEBHOOK_TOKEN: process.env.GITLAB_WEBHOOK_TOKEN,
        MONGODB_URI: process.env.MONGODB_URI,
        MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'mr-bot',
        JIRA_BASE_URL: process.env.JIRA_BASE_URL,
        NODE_ENV: process.env.NODE_ENV || 'production',
      },
    },
  ],
};
