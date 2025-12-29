import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import {
  enqueueNotification,
  markNotificationDelivered,
  markNotificationError,
} from '../data/notificationQueueRepository';
import type { DeliveryRecipient } from './recipients';

export type NotificationMeta = {
  eventType?: string;
  projectId?: number;
  mrIid?: number;
  mrId?: number;
};

const buildMrKey = (meta?: NotificationMeta): string | undefined => {
  if (!meta?.projectId || !meta?.mrIid) {
    return undefined;
  }
  return `${meta.projectId}:${meta.mrIid}`;
};

const buildDedupeKey = (
  chatId: number,
  meta?: NotificationMeta,
): string | undefined => {
  if (!meta?.eventType) {
    return undefined;
  }
  const mrKey = buildMrKey(meta);
  if (!mrKey) {
    return undefined;
  }
  return `${chatId}:${mrKey}:${meta.eventType}`;
};

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
  meta?: NotificationMeta,
): Promise<void> => {
  const mrKey = buildMrKey(meta);
  const dedupeKey = buildDedupeKey(recipient.chatId, meta);
  const notificationId = await enqueueNotification({
    chatId: recipient.chatId,
    ...(recipient.telegramUsername ? { telegramUsername: recipient.telegramUsername } : {}),
    ...(recipient.gitlabUsername ? { gitlabUsername: recipient.gitlabUsername } : {}),
    ...(meta?.eventType ? { eventType: meta.eventType } : {}),
    ...(mrKey ? { mrKey } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    text,
    createdAt: new Date(),
  });
  if (!recipient.isWithinHours) {
    return;
  }
  try {
    await sendHtmlMessage(bot, recipient.chatId, text);
    await markNotificationDelivered(notificationId);
  } catch (error) {
    await markNotificationError(notificationId, String(error));
    console.warn('[notify] Failed to deliver message', error);
  }
};

export const deliverHtmlMessageToRecipients = async (
  bot: Telegraf<BotContext>,
  recipients: DeliveryRecipient[],
  text: string,
  meta?: NotificationMeta,
): Promise<void> => {
  for (const recipient of recipients) {
    await deliverHtmlMessage(bot, recipient, text, meta);
  }
};
