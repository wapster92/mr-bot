import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../bot';
import { getUserByTelegramUsername } from '../data/userStore';
import { persistIncomingMessage } from '../data/incomingMessageRepository';
import { getUnauthorizedChatReply } from '../messages/unauthorized';

export const incomingLogMiddleware = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const message = ctx.message;
  if (!message || !('text' in message)) {
    return next();
  }

  const trimmed = message.text.trim();
  if (trimmed.startsWith('/')) {
    return next();
  }

  const telegramUser = ctx.from;
  const allowedUser = await getUserByTelegramUsername(telegramUser?.username);
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
          ...('username' in ctx.chat && ctx.chat.username ? { username: ctx.chat.username } : {}),
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
    await ctx.reply(getUnauthorizedChatReply(ctx.from?.id));
    return;
  }

  return next();
};
