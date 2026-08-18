import { Context, Markup, Telegraf } from 'telegraf';
import {
  deleteManagedUser,
  getManagedUserById,
  getReviewerByTelegramUsername,
  getUserByTelegramUsername,
  listActiveReviewers,
  listLeadUsers,
  listUsersForManagement,
  persistUserChatId,
  setManagedUserActive,
  setManagedUserReviewer,
  upsertAllowedUser,
} from './data/userStore';
import { refreshQueue } from './data/reviewerQueue';
import {
  listActiveMergeRequests,
  listActiveMergeRequestsByAuthor,
  listPendingReviewsForReviewer,
} from './data/mergeRequestRepository';
import { incomingLogMiddleware } from './middleware/incomingLog';
import { commandAuthMiddleware } from './middleware/auth';
import { escapeHtml } from './messages/format';
import { buildMergeRequestMessages } from './services/mrSummary';
import { flushNotificationQueue } from './services/notificationQueue';
import { listErroredNotifications } from './data/notificationQueueRepository';
import { buildGameProfileMessage, buildGameTopMessage } from './services/gameStats';
import { needsLeadReview, summarizeApprovals } from './services/approvalPolicy';
import { syncOpenMergeRequests } from './services/mergeRequestSync';
import { UserDeletionConfirmations } from './services/userDeletionConfirmation';

export type BotContext = Context;

const buildMainKeyboard = (
  isLead: boolean,
  isReviewer = true,
): ReturnType<typeof Markup.keyboard> => {
  const rows: string[][] = isLead
    ? [['Мои MR', 'Все MR'], ['Финал', 'Пользователи']]
    : isReviewer
    ? [['На ревью', 'Мои MR'], ['Все MR']]
    : [['Мои MR', 'Все MR']];
  rows.push(['Мой профиль', 'Топ']);
  rows.push(['Помощь']);
  return Markup.keyboard(rows).resize();
};

const helpCommand = async (ctx: BotContext): Promise<any> => {
  const user = await getUserByTelegramUsername(ctx.from?.username);
  const commandLines = [
    'Доступные команды:',
    '/help — показать эту подсказку',
    '/status — базовая проверка доступности бота',
  ];
  if (user && !user.isLead && user.isReviewer !== false) {
    commandLines.push('/review — показать MR, где нужен твой ревью');
  }
  commandLines.push(
    '/my_mrs — показать активные MR, где ты автор',
    '/mrs — показать активные MR и их статус',
    '/profile — показать игровой профиль и XP',
    '/top — показать общий сезонный топ',
    '/top_review — показать топ ревьюеров',
    '/top_author — показать топ авторов',
  );
  if (user?.isLead) {
    commandLines.push(
      '/final — показать MR для финальной проверки',
      '/users — управлять доступностью и участием пользователей в ревью',
      '/allow — добавить пользователя в whitelist',
    );
  }
  return ctx.reply(
    commandLines.join('\n'),
    buildMainKeyboard(Boolean(user?.isLead), user?.isReviewer !== false),
  );
};

const buildUserManagementPanel = async (): Promise<{
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}> => {
  const users = await listUsersForManagement();
  const lines = [
    '👥 <b>Управление пользователями</b>',
    '',
    '🏖 — временно исключить из назначений и уведомлений',
    '▶️ — вернуть после отпуска',
    '🎯 — включить или исключить разработчика из очереди ревьюеров',
    '🗑 — удалить уволившегося пользователя',
    '',
  ];
  const rows = users.map((user, index) => {
    const position = index + 1;
    const active = user.isActive !== false;
    const reviewerEnabled = user.isReviewer !== false;
    const role = user.isLead
      ? 'лид'
      : `разработчик, ${reviewerEnabled ? 'участвует в ревью' : 'без назначений на ревью'}`;
    const telegram = user.telegramUsername
      ? ` · Telegram: @${escapeHtml(user.telegramUsername)}`
      : '';
    lines.push(
      `${position}. <b>${escapeHtml(user.name ?? user.gitlabUsername)}</b> — ` +
        `${active ? '✅ работает' : '🏖 в отпуске'}, ${role}`,
      `   GitLab: <code>${escapeHtml(user.gitlabUsername)}</code>${telegram}`,
    );
    const id = user._id.toHexString();
    const buttons = [
      Markup.button.callback(
        `${active ? '🏖 В отпуск' : '▶️ Вернуть'} · ${position}`,
        `users:${active ? 'pause' : 'resume'}:${id}`,
      ),
    ];
    if (!user.isLead) {
      buttons.push(
        Markup.button.callback(
          `${reviewerEnabled ? '🚫 Не назначать' : '🎯 Назначать'} · ${position}`,
          `users:${reviewerEnabled ? 'review-off' : 'review-on'}:${id}`,
        ),
      );
    }
    buttons.push(
      Markup.button.callback(`🗑 Удалить · ${position}`, `users:delete:${id}`),
    );
    return buttons;
  });
  if (!users.length) {
    lines.push('Разрешённых пользователей пока нет.');
  }
  lines.push(
    '',
    'Добавление: <code>/allow @telegram gitlab.username Имя Фамилия</code>',
    'Без ревью: <code>/allow @telegram gitlab.username --no-review Имя Фамилия</code>',
  );
  return {
    text: lines.join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  };
};

const requestReviewerSynchronization = (): void => {
  void syncOpenMergeRequests().catch((error) => {
    console.warn('[user-management] Failed to start MR synchronization', error);
  });
};

export const createBot = (token: string): Telegraf<BotContext> => {
  const bot = new Telegraf<BotContext>(token);
  const userDeletionConfirmations = new UserDeletionConfirmations();
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
          buildMainKeyboard(
            Boolean(allowedUser.isLead),
            allowedUser.isReviewer !== false,
          ),
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
      await ctx.reply(
        'Формат: /allow @telegramUsername gitlab.username [--no-review] [Имя Фамилия]',
      );
      return;
    }

    const telegramRaw = parts[1] ?? '';
    const gitlabUsername = parts[2];
    const telegramUsername = telegramRaw.startsWith('@') ? telegramRaw.slice(1) : telegramRaw;
    const profileParts = parts.slice(3);
    const withoutReview = profileParts.includes('--no-review');
    const name = profileParts.filter((part) => part !== '--no-review').join(' ') || undefined;

    if (!telegramUsername || !gitlabUsername) {
      await ctx.reply('Нужны @telegramUsername и gitlab.username.');
      return;
    }

    await upsertAllowedUser({
      telegramUsername,
      gitlabUsername,
      ...(name ? { name } : {}),
      ...(withoutReview ? { isReviewer: false } : {}),
    });
    await ctx.reply(
      `Пользователь @${telegramUsername} добавлен в whitelist` +
        `${withoutReview ? ' без назначений на ревью' : ''}.`,
    );
  });

  const sendUserManagementPanel = async (
    ctx: BotContext,
    editExisting = false,
  ): Promise<void> => {
    const panel = await buildUserManagementPanel();
    const options = {
      parse_mode: 'HTML' as const,
      ...panel.keyboard,
    };
    if (editExisting) {
      try {
        await ctx.editMessageText(panel.text, options);
        return;
      } catch (error) {
        console.warn('[user-management] Failed to update panel message', error);
      }
    }
    await ctx.reply(panel.text, options);
  };

  const handleUsers = async (ctx: BotContext): Promise<void> => {
    const actor = await getUserByTelegramUsername(ctx.from?.username);
    if (!actor?.isLead) {
      await ctx.reply('Команда доступна только лидам.');
      return;
    }
    await sendUserManagementPanel(ctx);
  };

  bot.command('users', handleUsers);

  bot.action(
    /^users:(pause|resume|review-on|review-off|delete):([a-f\d]{24})$/,
    async (ctx): Promise<void> => {
      const actor = await getUserByTelegramUsername(ctx.from?.username);
      if (!actor?.isLead) {
        await ctx.answerCbQuery('Команда доступна только лидам.', {
          show_alert: true,
        });
        return;
      }

      const action = ctx.match[1];
      const userId = ctx.match[2];
      if (!action || !userId) {
        await ctx.answerCbQuery('Некорректное действие.', { show_alert: true });
        return;
      }
      const target = await getManagedUserById(userId);
      if (!target) {
        await ctx.answerCbQuery('Пользователь уже удалён или недоступен.', {
          show_alert: true,
        });
        await sendUserManagementPanel(ctx, true);
        return;
      }

      if (action === 'delete') {
        if (target.gitlabUsernameLower === actor.gitlabUsernameLower) {
          await ctx.answerCbQuery('Нельзя удалить собственную учётную запись.', {
            show_alert: true,
          });
          return;
        }
        const pending = userDeletionConfirmations.request(ctx.from.id, {
          userId,
          gitlabUsername: target.gitlabUsername,
          displayName: target.name ?? target.gitlabUsername,
        });
        await ctx.answerCbQuery('Требуется подтверждение удаления.');
        await ctx.reply(
          [
            `⚠️ Удаление <b>${escapeHtml(pending.displayName)}</b> необратимо.`,
            'Скопируйте текст ниже и отправьте его боту отдельным сообщением:',
            '',
            `<code>${escapeHtml(pending.phrase)}</code>`,
            '',
            'Подтверждение действует 10 минут.',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (action === 'review-on' || action === 'review-off') {
        if (target.isLead) {
          await ctx.answerCbQuery('Лиды не участвуют в очереди ревьюеров.', {
            show_alert: true,
          });
          return;
        }
        const isReviewer = action === 'review-on';
        if (!(await setManagedUserReviewer(userId, isReviewer))) {
          await ctx.answerCbQuery('Не удалось изменить участие в ревью.', {
            show_alert: true,
          });
          return;
        }
        console.info(
          `[user-management] ${actor.gitlabUsername} ` +
            `${isReviewer ? 'enabled reviews for' : 'disabled reviews for'} ` +
            target.gitlabUsername,
        );
        await ctx.answerCbQuery(
          isReviewer
            ? 'Пользователь добавлен в очередь ревьюеров.'
            : 'Пользователь исключён из очереди ревьюеров.',
        );
        await sendUserManagementPanel(ctx, true);
        try {
          await refreshQueue();
        } catch (error) {
          console.warn('[user-management] Failed to refresh reviewer queue', error);
        }
        requestReviewerSynchronization();
        return;
      }

      const isActive = action === 'resume';
      if (!(await setManagedUserActive(userId, isActive))) {
        await ctx.answerCbQuery('Не удалось изменить пользователя.', {
          show_alert: true,
        });
        return;
      }
      console.info(
        `[user-management] ${actor.gitlabUsername} ${isActive ? 'resumed' : 'paused'} ${target.gitlabUsername}`,
      );
      await ctx.answerCbQuery(
        isActive ? 'Пользователь вернулся из отпуска.' : 'Пользователь приостановлен.',
      );
      await sendUserManagementPanel(ctx, true);
      requestReviewerSynchronization();
    },
  );

  bot.hears(/^УДАЛИТЬ(?:\s|$)/i, async (ctx): Promise<void> => {
    const actor = await getUserByTelegramUsername(ctx.from?.username);
    if (!actor?.isLead) {
      await ctx.reply('Удалять пользователей могут только лиды.');
      return;
    }
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const confirmation = userDeletionConfirmations.confirm(ctx.from.id, text);
    if (confirmation.status === 'missing') {
      await ctx.reply('Сначала выберите пользователя в разделе «Пользователи».');
      return;
    }
    if (confirmation.status === 'expired') {
      await ctx.reply('Подтверждение истекло. Нажмите «Удалить» ещё раз.');
      return;
    }
    if (confirmation.status === 'mismatch') {
      await ctx.reply(
        [
          'Текст не совпадает. Скопируйте подтверждение без изменений:',
          `<code>${escapeHtml(confirmation.expectedPhrase)}</code>`,
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const target = await getManagedUserById(confirmation.target.userId);
    if (!target) {
      await ctx.reply('Пользователь уже удалён.');
      return;
    }
    if (
      target.gitlabUsernameLower !== confirmation.target.gitlabUsername.toLowerCase()
    ) {
      await ctx.reply('Пользователь изменился после запроса. Удаление отменено.');
      return;
    }
    if (target.gitlabUsernameLower === actor.gitlabUsernameLower) {
      await ctx.reply('Нельзя удалить собственную учётную запись.');
      return;
    }
    if (!(await deleteManagedUser(confirmation.target.userId))) {
      await ctx.reply('Не удалось удалить пользователя. Попробуйте ещё раз.');
      return;
    }
    console.info(
      `[user-management] ${actor.gitlabUsername} deleted ${target.gitlabUsername}`,
    );
    await ctx.reply(
      `Пользователь <b>${escapeHtml(target.name ?? target.gitlabUsername)}</b> удалён. ` +
        'История XP сохранена.',
      { parse_mode: 'HTML' },
    );
    requestReviewerSynchronization();
    await sendUserManagementPanel(ctx);
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

  const handleMyMrs = async (ctx: BotContext): Promise<void> => {
    const user = await getUserByTelegramUsername(ctx.from?.username);
    if (!user) {
      await ctx.reply('Команда доступна только разрешённым пользователям.');
      return;
    }
    if (!user.gitlabUsername) {
      await ctx.reply('Не могу определить твой GitLab username.');
      return;
    }

    const mergeRequests = await listActiveMergeRequestsByAuthor(user.gitlabUsername, 10);
    if (!mergeRequests.length) {
      await ctx.reply('Активных MR, где ты автор, не найдено.');
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

  bot.command('my_mrs', handleMyMrs);

  const handleGameProfile = async (ctx: BotContext): Promise<void> => {
    const user = await getUserByTelegramUsername(ctx.from?.username);
    if (!user || user.isActive === false) {
      await ctx.reply('Команда доступна только разрешённым пользователям.');
      return;
    }
    const message = await buildGameProfileMessage(user.gitlabUsername);
    await ctx.reply(message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  };

  const handleGameTop = async (
    ctx: BotContext,
    category?: 'review' | 'author',
  ): Promise<void> => {
    const user = await getUserByTelegramUsername(ctx.from?.username);
    if (!user || user.isActive === false) {
      await ctx.reply('Команда доступна только разрешённым пользователям.');
      return;
    }
    const message = await buildGameTopMessage(category);
    await ctx.reply(message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  };

  bot.command('profile', handleGameProfile);
  bot.command('top', (ctx) => handleGameTop(ctx));
  bot.command('top_review', (ctx) => handleGameTop(ctx, 'review'));
  bot.command('top_author', (ctx) => handleGameTop(ctx, 'author'));

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

    const [leads, reviewers] = await Promise.all([
      listLeadUsers(),
      listActiveReviewers(),
    ]);
    const leadUsernamesLower = new Set(
      leads.map((lead) => (lead.gitlabUsername ?? '').toLowerCase()).filter(Boolean),
    );
    const reviewerUsernamesLower = new Set(
      reviewers.map((reviewer) => reviewer.toLowerCase()),
    );

    const candidates = mergeRequests.filter((mr) => {
      if (mr.isDraft) return false;
      const approvers = mr.approvedBy ?? [];
      return needsLeadReview(
        summarizeApprovals(approvers, leadUsernamesLower, reviewerUsernamesLower),
      );
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
  bot.hears('Мои MR', handleMyMrs);
  bot.hears('Все MR', handleMrs);
  bot.hears('Мой профиль', handleGameProfile);
  bot.hears('Топ', (ctx) => handleGameTop(ctx));
  bot.hears('Финал', handleFinal);
  bot.hears('Пользователи', handleUsers);
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
