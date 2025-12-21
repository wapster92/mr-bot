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
    // ИРОНИЧНЫЕ / ДОБРЫЕ
    "Кажется, мы не знакомы 🤔 Доступ не выдан. Но вы держитесь! 💪",
    "Я бы пустил… но лид сказал «ни-ни» 😅",
    "Уровень допуска: низкий 📉 Настроение: высокое 😌 Итог: отказ 🚫",
    "Вы пытаетесь войти туда, где вам не рады… но с хорошими намерениями! 🤷‍♂️✨",
    "Для доступа нужен пропуск, харизма и одобрение лида 😎 Пока есть только харизма.",
    "Если вы мой будущий хозяин — простите 🙇 Если нет — тоже простите.",
    "Увы, моя любовь ❤️ к вам недостаточна для авторизации 🚫",

    // ДЕРЗКИЕ
    "Доступа нет 🚫 Но упорство похвально 😏",
    "Я бы дал, но… ты кто вообще? 👀",
    "Ошибка 403: ты слишком красив, чтобы войти сюда 😳",
    "Вот бы разрешить… но потом лид меня перепишет 🛠️😬",
    "Может, ты просто забыл, что тебе нельзя? 🤨",
    "Мне сказали: «Не пускать подозрительных» 😶‍🌫️ Извини…",
    "В списке доступа вас нет 📜 В списке симпатий тоже 😐",

    // БОТСКИЕ
    "Авторизация провалена ❌ Но я верю, что в другой жизни ты войдёшь! 🔮",
    "Проверяю права… проверяю… всё, проверил — их нет 😇",
    "Запрашиваем доступ у сервера… сервер ржёт 😂 Отказ.",
    "Ваш запрос обрабатывается… Error: NO 🖥️⚠️",
    "Если бы доступ выдавали за настойчивость… всё равно нет 😌",
    "Мой код говорит «нет» 🧬 А код, как известно, не обманет.",
    "Аутентификация провалена 🔐 Это не личное… хотя кто знает 🤫",

    // «ЛИД НЕ РАЗРЕШИЛ»
    "Лид сказал не пускать 🚷 А спорить с лидом запрещено протоколом 📘",
    "Хочешь доступ — договаривайся с лидом 🤝 Я всего лишь бот… но послушный 🤖",
    "Нет доступа. Лид следит 👀",
    "Если лид спросит — ты сам сюда пришёл 😳",
    "Лид сказал «нельзя» ❌ А я просто повторяю, я же воспитанный бот 🙂",

    // МЯГКОЕ ОТШИВАНИЕ
    "Не сегодня 😌",
    "Вот бы я мог пускать всех… но у меня строгий график «нет» 🗓️🚫",
    "Похоже, это не твой бот 😅 Но ты держись!",
    "Закрыто… но искренне спасибо, что попытался 🙏",
    "Твой доступ в другом замке 🏰🔑, брат."
  ];
  const unauthorizedChatReplies = [
    // ЛЁГКИЕ ЗАБАВНЫЕ
    "Сообщение получено 📩 Но я всё ещё не знаю, кто ты 😅",
    "Прикольно! 👍 Не уверен, что это было для меня… но я сохранил.",
    "Спасибо за сообщение! Я его бережно положил в папку «???» 🤔",
    "Это звучит важно 🧐 Жаль, что я всё равно не понял.",
    "Ваше сообщение ушло в специальный отдел… ну, туда, где непонятные штуки лежат 😄",

    // ИРОНИЧНЫЕ
    "О, загадочный незнакомец что-то пишет… люблю такую драму ✨",
    "Записываю 📝 Вдруг потом пригодится 👀",
    "Не знаю, кто вы, но пишете вы уверенно 😌",
    "Если это было секретно — я обещаю, что никому не скажу 🤫 (я бот, со мной безопасно)",
    "Сообщение получено. Вопросов больше, чем ответов 😄",

    // ЧУТЬ ТРОЛЛИНГА
    "Спасибо! Добавил это в коллекцию странных сообщений 🤖✨",
    "Подожди… пытаюсь понять… нет, всё ещё не понял 😅",
    "Если это был код — он не скомпилировался 🔧",
    "Сообщение сохранено! Теперь оно будет жить здесь вечно 👁️",
    "Я не уверен, что это было, но выглядит смешно 😄",

    // БОТСКИЕ / ТЕХНО
    "Пакет данных получен 📡 Обработка… Обработка завершена ✔️",
    "Ваше сообщение успешно отправлено в лог 📜",
    "Ошибка человеческости: слишком мало информации 🤖",
    "Инициализация… анализ… готово: это сообщение.",
    "Ваше сообщение было классифицировано как «интересное» 😎",

    // ДУШЕВНЫЕ / МЯГКИЕ
    "Спасибо, что написали 🌿",
    "Я внимательно прочитал. И даже задумался 🤔",
    "Круто! Всегда любопытно читать такие сообщения 🙂",
    "Если хотите, напишите ещё — мне не скучно 😉",
    "Хм… неожиданно. Но приятно!)",

    // «МАЛЕНЬКИЙ ХАОС» (редкие и весёлые)
    "Ваше сообщение было успешно доставлено… куда-то 😄",
    "Я будто почувствовал эмоции… но это баг, не обращайте внимания 😳",
    "Ваше сообщение передано в отдел «магии и случайностей» ✨",
    "Если это была просьба — я её, кажется, не понял 😅",
    "Сохранил! Теперь учёные будущего будут ломать голову, что это значит 🧠🌀"
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
        const incomingMessage = {
          messageId: message.message_id,
          text: trimmed,
          receivedAt: new Date(),
          isAuthorized: Boolean(allowedUser),
          ...(from ? { from } : {}),
          ...(chat ? { chat } : {}),
        };
        await persistIncomingMessage(incomingMessage);
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
