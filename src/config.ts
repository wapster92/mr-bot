import dotenv from 'dotenv';

dotenv.config();

type BotMode = 'webhook' | 'long-polling';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
}

const BOT_MODE = (process.env.BOT_MODE ?? 'long-polling').toLowerCase() as BotMode;

const normalizePath = (value: string | undefined, fallback: string): string => {
  const fallbackPath = fallback.startsWith('/') ? fallback : `/${fallback}`;

  if (!value) {
    return fallbackPath;
  }

  let normalized = value.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  const sanitized = normalized.replace(/\/+$/, '');
  return sanitized || fallbackPath;
};

const TELEGRAM_WEBHOOK_PATH = normalizePath(process.env.TELEGRAM_WEBHOOK_PATH, '/telegram/webhook');
const GITLAB_WEBHOOK_PATH = normalizePath(process.env.GITLAB_WEBHOOK_PATH, '/gitlab/webhook');

const TELEGRAM_WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN;

if (BOT_MODE === 'webhook' && !TELEGRAM_WEBHOOK_DOMAIN) {
  throw new Error('BOT_MODE is webhook but TELEGRAM_WEBHOOK_DOMAIN is missing.');
}

const parseBoolean = (value: string | undefined): boolean => {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME ?? 'mr-bot';
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;

export const config = {
  botToken: BOT_TOKEN,
  mode: BOT_MODE,
  port: Number(process.env.PORT ?? 3000),
  webhook: {
    domain: TELEGRAM_WEBHOOK_DOMAIN,
    path: TELEGRAM_WEBHOOK_PATH,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
  },
  gitlab: {
    path: GITLAB_WEBHOOK_PATH,
    token: process.env.GITLAB_WEBHOOK_TOKEN,
  },
  mongo: {
    uri: MONGODB_URI,
    dbName: MONGODB_DB_NAME,
  },
  jira: {
    baseUrl: JIRA_BASE_URL,
  },
  logGitlabEvents: parseBoolean(process.env.LOG_GITLAB_EVENTS),
  logGitlabMaxMb: parseNumber(process.env.LOG_GITLAB_MAX_MB, 20),
} as const;

console.log(config.mode)

export type Config = typeof config;
