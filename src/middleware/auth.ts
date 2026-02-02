import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../bot';
import { getReviewerByTelegramUsername, getUserByTelegramUsername } from '../data/userStore';
import { getUnauthorizedCommandReply } from '../messages/unauthorized';

const getCommandName = (text: string): string => {
  const firstToken = text.trim().split(/\s+/, 1)[0] ?? '';
  const command = firstToken.startsWith('/') ? firstToken.slice(1) : firstToken;
  return command.split('@')[0]?.toLowerCase() ?? '';
};

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
  const commandName = getCommandName(trimmed);
  const allowedUser =
    commandName === 'review'
      ? await getReviewerByTelegramUsername(telegramUser?.username)
      : await getUserByTelegramUsername(telegramUser?.username);
  if (!allowedUser) {
    await ctx.reply(getUnauthorizedCommandReply());
    return;
  }

  return next();
};
