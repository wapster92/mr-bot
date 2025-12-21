import { Context, Telegraf } from 'telegraf';
import {
  escapeHtml,
  formatGitlabUserLabel,
  getUserByTelegramUsername,
  persistUserChatId,
} from './data/userStore';
import { listActiveMergeRequests } from './data/mergeRequestRepository';
import { persistIncomingMessage } from './data/incomingMessageRepository';

export type BotContext = Context;

export const createBot = (token: string): Telegraf<BotContext> => {
  const bot = new Telegraf<BotContext>(token);

  const unauthorizedReplies = [
    'Кажется, я тебя не знаю 😅 Напиши лиду, чтобы добавили в whitelist.',
    'Тут вход по спискам. Попроси доступ у лида 🙌',
    'Я бы рад помочь, но тебя нет в списке разрешённых 🤖',
    'Секретный клуб. Доступ выдаёт лид команды.',
    'Команды доступны только своим. Проверь доступ у лида.',
  ];
  const unauthorizedChatReplies = [
    'Привет! Я вижу сообщение, но отвечать могу только своим 🙂',
    'Я пока не знаю тебя. Доступ выдаёт лид команды.',
    'Это закрытый бот. Попроси доступ у лида 👍',
    'Сообщение получено. Дальше нужен доступ через whitelist.',
    'Хм, тебя нет в списке. Напиши лиду, и я отвечу по делу 😉',
  ];

  const pickRandom = (items: string[], fallback: string): string => {
    if (!items.length) {
      return fallback;
    }
    return items[Math.floor(Math.random() * items.length)] ?? fallback;
  };

  const replyUnauthorized = async (ctx: BotContext): Promise<void> => {
    const message = pickRandom(
      unauthorizedReplies,
      'Доступ закрыт. Попроси доступ у лида.',
    );
    await ctx.reply(message);
  };
  const replyUnauthorizedChat = async (ctx: BotContext): Promise<void> => {
    const message = pickRandom(
      unauthorizedChatReplies,
      'Я тебя вижу, но отвечаю только своим.',
    );
    await ctx.reply(message);
  };

  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message || !('text' in message)) {
      return next();
    }
    const text = message.text;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      const telegramUser = ctx.from;
      const allowedUser = getUserByTelegramUsername(telegramUser?.username);
      try {
        const from = telegramUser
          ? {
              id: telegramUser.id,
              ...(telegramUser.username ? { username: telegramUser.username } : {}),
              ...(telegramUser.first_name ? { firstName: telegramUser.first_name } : {}),
              ...(telegramUser.last_name ? { lastName: telegramUser.last_name } : {}),
              ...(telegramUser.is_bot !== undefined ? { isBot: telegramUser.is_bot } : {}),
            }
          : undefined;
        const chat = ctx.chat
          ? {
              id: ctx.chat.id,
              type: ctx.chat.type,
              ...('title' in ctx.chat && ctx.chat.title ? { title: ctx.chat.title } : {}),
              ...('username' in ctx.chat && ctx.chat.username
                ? { username: ctx.chat.username }
                : {}),
            }
          : undefined;
        await persistIncomingMessage({
          messageId: message.message_id,
          text: trimmed,
          receivedAt: new Date(),
          isAuthorized: Boolean(allowedUser),
          from,
          chat,
        });
      } catch (error) {
        console.error('Failed to persist incoming message', error);
      }
      if (!allowedUser) {
        await replyUnauthorizedChat(ctx);
        return;
      }
    }
    return next();
  });

  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message || !('text' in message)) {
      return next();
    }
    const trimmed = message.text.trim();
    if (trimmed.startsWith('/')) {
      const telegramUser = ctx.from;
      const allowedUser = getUserByTelegramUsername(telegramUser?.username);
      if (!allowedUser) {
        await replyUnauthorized(ctx);
        return;
      }
    }
    return next();
  });

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

    const buildUserLabel = (gitlabUsername: string): Promise<string> =>
      formatGitlabUserLabel(gitlabUsername);

    const messages: string[] = [];
    for (const mr of mergeRequests) {
      const reviewers = mr.reviewers ?? [];
      const approvedBy = mr.approvedBy ?? [];
      const reviewerLabels = reviewers.length
        ? await Promise.all(reviewers.map((reviewer) => buildUserLabel(reviewer)))
        : [];
      const approvedLabels = approvedBy.length
        ? await Promise.all(approvedBy.map((approver) => buildUserLabel(approver)))
        : [];
      const pendingReviewers = reviewers.filter((reviewer) => !approvedBy.includes(reviewer));
      const pendingLabels = pendingReviewers.length
        ? await Promise.all(pendingReviewers.map((reviewer) => buildUserLabel(reviewer)))
        : [];
      const reviewerNames = reviewerLabels.length ? reviewerLabels.join(', ') : 'не назначены';

      const authorLabel = await formatGitlabUserLabel(
        mr.author.gitlabUsername,
        mr.author.name,
      );

      const approvalsRequired =
        typeof mr.approvalsRequired === 'number' ? mr.approvalsRequired : undefined;
      const approvalsLeft = typeof mr.approvalsLeft === 'number' ? mr.approvalsLeft : undefined;
      const approvalsGiven =
        approvalsRequired !== undefined && approvalsLeft !== undefined
          ? Math.max(approvalsRequired - approvalsLeft, 0)
          : undefined;
      const approvalsFromReviewers =
        approvalsRequired === undefined && approvalsLeft === undefined && reviewers.length
          ? `${Math.min(approvedBy.length, reviewers.length)}/${reviewers.length}`
          : undefined;
      const approvalsLine =
        approvalsRequired !== undefined && approvalsLeft !== undefined
          ? `Апрувы: ${approvalsGiven}/${approvalsRequired} (осталось ${Math.max(
              approvalsLeft,
              0,
            )})`
          : approvalsFromReviewers
          ? `Апрувы: ${approvalsFromReviewers}`
          : 'Апрувы: нет данных';
      const approvedLine = approvedLabels.length
        ? `Апрувнули: ${approvedLabels.join(', ')}`
        : 'Апрувнули: —';
      const pendingLine = pendingLabels.length
        ? `Ревьюеры без апрува: ${pendingLabels.join(', ')}`
        : reviewers.length
        ? 'Ревьюеры без апрува: —'
        : 'Ревьюеры без апрува: нет данных';
      const parts = [
        `#${mr.iid}: ${escapeHtml(mr.title ?? '—')}`,
        `Автор: ${authorLabel}`,
        approvalsLine,
        approvedLine,
        pendingLine,
        `Ревьюеры: ${reviewerNames}`,
        `Линт: ${escapeHtml(mr.lastLintStatus ?? 'не запускался')}`,
        escapeHtml(mr.url),
      ];
      if (mr.taskUrl) {
        parts.push(`Задача: ${escapeHtml(mr.taskUrl)}`);
      }
      messages.push(parts.filter(Boolean).join('\n'));
    }

    await ctx.reply(messages.join('\n\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  return bot;
};
