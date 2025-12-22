import { Context, Telegraf } from 'telegraf';
import { getUserByTelegramUsername, persistUserChatId } from './data/userStore';
import { listActiveMergeRequests } from './data/mergeRequestRepository';
import { incomingLogMiddleware } from './middleware/incomingLog';
import { commandAuthMiddleware } from './middleware/auth';
import { buildMergeRequestMessages } from './services/mrSummary';
import { flushNotificationQueue } from './services/notificationQueue';

export type BotContext = Context;

export const createBot = (token: string): Telegraf<BotContext> => {
  const bot = new Telegraf<BotContext>(token);
  const queueFlushIntervalMs = 60_000;
  setInterval(() => {
    void flushNotificationQueue(bot).catch((error) => {
      console.error('Failed to flush notification queue', error);
    });
  }, queueFlushIntervalMs);

  bot.use(incomingLogMiddleware());
  bot.use(commandAuthMiddleware());

  bot.start(async (ctx) => {
    const telegramUser = ctx.from;
    if (!telegramUser) {
      await ctx.reply('Не могу определить твой профиль 😕.');
      return;
    }

    const allowedUser = getUserByTelegramUsername(telegramUser.username);
    if (!allowedUser) {
      await ctx.reply('Привет! Похоже, тебя ещё нет в списке разрешённых пользователей.');
      return;
    }

    if (telegramUser.id) {
      try {
        await persistUserChatId(telegramUser.id, ctx.chat.id, telegramUser.username);
        await ctx.reply('Привет! Я запомнил этот чат 📝. Введи /help, чтобы увидеть команды.');
      } catch (error) {
        console.error('Failed to persist chat id', error);
        await ctx.reply('Привет! Я тебя узнал, но не смог сохранить чат. Попробуй позже.');
      }
    } else {
      await ctx.reply('Привет! Я помогу держать команду в курсе состояния CI и MR. Введи /help, чтобы увидеть команды.');
    }
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'Доступные команды:',
        '/help — показать эту подсказку',
        '/status — базовая проверка доступности бота',
        '/review — заглушка: в будущем покажет MR, где нужен ревьюер',
        '/mrs — показать активные MR и их статус',
      ].join('\n'),
    ),
  );

  bot.command('status', (ctx) => ctx.reply('Все системы в норме ✅'));

  bot.command('review', (ctx) => {
    ctx.reply('Пока я только заготовка 🙈. Скоро научусь собирать MR без ревью.');
  });

  bot.command('whoami', (ctx) => {
    const telegramUser = ctx.from;
    const allowedUser = getUserByTelegramUsername(telegramUser?.username);

    if (!telegramUser) {
      ctx.reply('Не могу определить твой профиль 😕.');
      return;
    }

    if (!allowedUser) {
      ctx.reply(`Ты не в списке разрешённых пользователей. Твой username: @${telegramUser.username ?? '—'}`);
      return;
    }

    const info = [
      `ID: ${telegramUser.id}`,
      `Username: @${telegramUser.username ?? '—'}`,
      `Имя: ${telegramUser.first_name ?? '—'}`,
      `Фамилия: ${telegramUser.last_name ?? '—'}`,
      `GitLab email: ${allowedUser.gitlabEmail ?? '—'}`,
      `GitLab username: ${allowedUser.gitlabUsername ?? '—'}`,
    ];

    ctx.reply(['Ты в whitelist ✅', ...info].join('\n'));
  });

  bot.command('mrs', async (ctx) => {
    const user = getUserByTelegramUsername(ctx.from?.username);
    if (!user) {
      await ctx.reply('Команда доступна только разрешённым пользователям.');
      return;
    }

    const mergeRequests = await listActiveMergeRequests(10);
    if (!mergeRequests.length) {
      await ctx.reply('Активных MR не найдено.');
      return;
    }

    const messages = await buildMergeRequestMessages(mergeRequests);
    await ctx.reply(messages.join('\n\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  return bot;
};
