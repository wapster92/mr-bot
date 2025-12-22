import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';

export const sendHtmlMessage = async (
  bot: Telegraf<BotContext>,
  chatId: number,
  text: string,
): Promise<void> => {
  await bot.telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
};

export const sendHtmlMessageToChats = async (
  bot: Telegraf<BotContext>,
  chatIds: number[],
  text: string,
): Promise<void> => {
  for (const chatId of chatIds) {
    await sendHtmlMessage(bot, chatId, text);
  }
};
