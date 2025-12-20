import { Context, Telegraf } from 'telegraf';
import { getUserByGitlabUsername, getUserByTelegramUsername, persistUserChatId } from './data/userStore';
import { listActiveMergeRequests } from './data/mergeRequestRepository';

export type BotContext = Context;

export const createBot = (token: string): Telegraf<BotContext> => {
  const bot = new Telegraf<BotContext>(token);

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

    const messages = mergeRequests.map((mr) => {
      const reviewerNames = mr.reviewers?.length ? mr.reviewers.join(', ') : 'не назначены';
      const authorName = mr.author.name ?? mr.author.gitlabUsername ?? '—';
      const reviewers = mr.reviewers ?? [];
      const approvedBy = mr.approvedBy ?? [];
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
      const formatUser = (username: string): string => {
        const mapped = getUserByGitlabUsername(username);
        return mapped?.telegramUsername ? `@${mapped.telegramUsername}` : username;
      };
      const approvedUsers = approvedBy.map(formatUser);
      const pendingUsers = reviewers.filter((reviewer) => !approvedBy.includes(reviewer)).map(formatUser);
      const approvedLine = approvedUsers.length ? `Апрувнули: ${approvedUsers.join(', ')}` : 'Апрувнули: —';
      const pendingLine = pendingUsers.length
        ? `Ревьюеры без апрува: ${pendingUsers.join(', ')}`
        : reviewers.length
        ? 'Ревьюеры без апрува: —'
        : 'Ревьюеры без апрува: нет данных';
      const parts = [
        `#${mr.iid}: ${mr.title}`,
        `Автор: ${authorName}`,
        approvalsLine,
        approvedLine,
        pendingLine,
        `Ревьюеры: ${reviewerNames}`,
        `Линт: ${mr.lastLintStatus ?? 'не запускался'}`,
        mr.url,
      ];
      if (mr.taskUrl) {
        parts.push(`Задача: ${mr.taskUrl}`);
      }
      return parts.filter(Boolean).join('\n');
    });

    await ctx.reply(messages.join('\n\n'));
  });

  return bot;
};
