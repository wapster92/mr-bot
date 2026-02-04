import { Context, Markup, Telegraf } from 'telegraf';
import {
  getReviewerByTelegramUsername,
  getUserByTelegramUsername,
  listLeadUsers,
  persistUserChatId,
  upsertAllowedUser,
} from './data/userStore';
import { listActiveMergeRequests, listPendingReviewsForReviewer } from './data/mergeRequestRepository';
import { incomingLogMiddleware } from './middleware/incomingLog';
import { commandAuthMiddleware } from './middleware/auth';
import { buildMergeRequestMessages } from './services/mrSummary';
import { flushNotificationQueue } from './services/notificationQueue';
import { listErroredNotifications } from './data/notificationQueueRepository';

export type BotContext = Context;

const buildMainKeyboard = (isLead: boolean): ReturnType<typeof Markup.keyboard> => {
  const rows: string[][] = [['На ревью', 'Все MR']];
  if (isLead) {
    rows.push(['Финал']);
  }
  rows.push(['Помощь']);
  return Markup.keyboard(rows).resize();
};

const helpCommand = async (ctx: BotContext): Promise<any> => {
  const user = await getUserByTelegramUsername(ctx.from?.username);
  return ctx.reply(
    [
      'Доступные команды:',
      '/help — показать эту подсказку',
      '/status — базовая проверка доступности бота',
      '/review — показать MR, где нужен твой ревью',
      '/mrs — показать активные MR и их статус',
      '/final — показать MR для финальной проверки (только лиды)',
      '/allow — добавить пользователя в whitelist (только лиды)',
    ].join('\n'),
    buildMainKeyboard(Boolean(user?.isLead)),
  );
};

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

    const allowedUser = await getUserByTelegramUsername(telegramUser.username);
    if (!allowedUser) {
      await ctx.reply('Привет! Похоже, тебя ещё нет в списке разрешённых пользователей.');
      return;
    }

    if (telegramUser.id) {
      try {
        await persistUserChatId(telegramUser.id, ctx.chat.id, telegramUser.username);
        await ctx.reply(
          'Привет! Я запомнил этот чат 📝. Введи /help, чтобы увидеть команды.',
          buildMainKeyboard(Boolean(allowedUser.isLead)),
        );
      } catch (error) {
        console.error('Failed to persist chat id', error);
        await ctx.reply('Привет! Я тебя узнал, но не смог сохранить чат. Попробуй позже.');
      }
    } else {
      await ctx.reply('Привет! Я помогу держать команду в курсе состояния CI и MR. Введи /help, чтобы увидеть команды.');
    }
  });

  bot.command('help', helpCommand);

  bot.command('status', (ctx) => ctx.reply('Все системы в норме ✅'));

  const handleReview = async (ctx: BotContext): Promise<void> => {
    const user = await getReviewerByTelegramUsername(ctx.from?.username);
    if (!user) {
      await ctx.reply('Команда доступна только разрешённым пользователям.');
      return;
    }
    if (!user.gitlabUsername) {
      await ctx.reply('Не могу определить твой GitLab username.');
      return;
    }

    const mergeRequests = await listPendingReviewsForReviewer(user.gitlabUsername, 10);
    if (!mergeRequests.length) {
      await ctx.reply('MR для ревью не найдено. Можно отдохнуть 🙂');
      return;
    }

    const messages = await buildMergeRequestMessages(mergeRequests);
    for (const message of messages) {
      await ctx.reply(message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  };

  bot.command('review', handleReview);

  bot.command('allow', async (ctx) => {
    const actor = await getUserByTelegramUsername(ctx.from?.username);
    if (!actor?.isLead) {
      await ctx.reply('Команда доступна только лидам.');
      return;
    }

    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const parts = text.split(' ').filter(Boolean);
    if (parts.length < 3) {
      await ctx.reply('Формат: /allow @telegramUsername gitlab.username [Имя Фамилия]');
      return;
    }

    const telegramRaw = parts[1] ?? '';
    const gitlabUsername = parts[2];
    const telegramUsername = telegramRaw.startsWith('@') ? telegramRaw.slice(1) : telegramRaw;
    const name = parts.slice(3).join(' ') || undefined;

    if (!telegramUsername || !gitlabUsername) {
      await ctx.reply('Нужны @telegramUsername и gitlab.username.');
      return;
    }

    await upsertAllowedUser({
      telegramUsername,
      gitlabUsername,
      ...(name ? { name } : {}),
    });
    await ctx.reply(`Пользователь @${telegramUsername} добавлен в whitelist.`);
  });

  bot.command('whoami', async (ctx) => {
    const telegramUser = ctx.from;
    const allowedUser = await getUserByTelegramUsername(telegramUser?.username);

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
      `GitLab username: ${allowedUser.gitlabUsername ?? '—'}`,
      `GitLab name: ${allowedUser.name ?? '—'}`,
    ];

    ctx.reply(['Ты в whitelist ✅', ...info].join('\n'));
  });

  const handleMrs = async (ctx: BotContext): Promise<void> => {
    const user = await getUserByTelegramUsername(ctx.from?.username);
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
    for (const message of messages) {
      await ctx.reply(message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  };

  bot.command('mrs', handleMrs);

  const handleFinal = async (ctx: BotContext): Promise<void> => {
    const actor = await getUserByTelegramUsername(ctx.from?.username);
    if (!actor?.isLead) {
      await ctx.reply('Команда доступна только лидам.');
      return;
    }

    const mergeRequests = await listActiveMergeRequests(50);
    if (!mergeRequests.length) {
      await ctx.reply('Активных MR не найдено.');
      return;
    }

    const leads = await listLeadUsers();
    const leadUsernamesLower = new Set(
      leads.map((lead) => (lead.gitlabUsername ?? '').toLowerCase()).filter(Boolean),
    );

    const candidates = mergeRequests.filter((mr) => {
      if (mr.isDraft) return false;
      const approvers = mr.approvedBy ?? [];
      const nonLeadApprovers = approvers.filter(
        (name) => !leadUsernamesLower.has(name.toLowerCase()),
      );
      return nonLeadApprovers.length >= 2;
    });

    if (!candidates.length) {
      await ctx.reply('MR для финальной проверки не найдено.');
      return;
    }

    const messages = await buildMergeRequestMessages(candidates);
    for (const message of messages) {
      await ctx.reply(message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  };

  bot.command('final', handleFinal);

  bot.hears('На ревью', handleReview);
  bot.hears('Все MR', handleMrs);
  bot.hears('Финал', handleFinal);
  bot.hears('Помощь', helpCommand);

  bot.command('queue_errors', async (ctx) => {
    const actor = await getUserByTelegramUsername(ctx.from?.username);
    if (!actor?.isLead) {
      await ctx.reply('Команда доступна только лидам.');
      return;
    }
    const errors = await listErroredNotifications(20);
    if (!errors.length) {
      await ctx.reply('Ошибок очереди нет.');
      return;
    }
    const lines = errors.map((item) => {
      const ts = item.errorAt?.toISOString() ?? '—';
      const who =
        item.telegramUsername ??
        item.gitlabUsername ??
        `chat:${item.chatId}`;
      return `${ts} | ${who} | ${item.eventType ?? 'event'} | ${item.errorMessage ?? 'unknown error'}`;
    });
    await ctx.reply(['Ошибки доставки (последние 20):', ...lines].join('\n'));
  });

  return bot;
};
