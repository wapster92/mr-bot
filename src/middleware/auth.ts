import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../bot';
import { getUserByTelegramUsername } from '../data/userStore';
import { getUnauthorizedCommandReply } from '../messages/unauthorized';

export const commandAuthMiddleware = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const message = ctx.message;
  if (!message || !('text' in message)) {
    return next();
  }

  const trimmed = message.text.trim();
  if (!trimmed.startsWith('/')) {
    return next();
  }

  const telegramUser = ctx.from;
  const allowedUser = await getUserByTelegramUsername(telegramUser?.username);
  if (!allowedUser) {
    await ctx.reply(getUnauthorizedCommandReply());
    return;
  }

  return next();
};
