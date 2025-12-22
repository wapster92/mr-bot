import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { enqueueNotification, markNotificationDelivered } from '../data/notificationQueueRepository';
import type { DeliveryRecipient } from './recipients';

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

export const deliverHtmlMessage = async (
  bot: Telegraf<BotContext>,
  recipient: DeliveryRecipient,
  text: string,
): Promise<void> => {
  const notificationId = await enqueueNotification({
    chatId: recipient.chatId,
    ...(recipient.telegramUsername ? { telegramUsername: recipient.telegramUsername } : {}),
    ...(recipient.gitlabUsername ? { gitlabUsername: recipient.gitlabUsername } : {}),
    text,
    createdAt: new Date(),
  });
  if (!recipient.isWithinHours) {
    return;
  }
  await sendHtmlMessage(bot, recipient.chatId, text);
  await markNotificationDelivered(notificationId);
};

export const deliverHtmlMessageToRecipients = async (
  bot: Telegraf<BotContext>,
  recipients: DeliveryRecipient[],
  text: string,
): Promise<void> => {
  for (const recipient of recipients) {
    await deliverHtmlMessage(bot, recipient, text);
  }
};
