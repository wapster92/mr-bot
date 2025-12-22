import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { listQueuedNotifications, markNotificationDelivered } from '../data/notificationQueueRepository';
import { getUserByGitlabUsername, getUserByTelegramUsername } from '../data/userStore';
import { isWithinWorkingHours } from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';

export const flushNotificationQueue = async (bot: Telegraf<BotContext>): Promise<void> => {
  const queued = await listQueuedNotifications(200);
  if (!queued.length) {
    return;
  }

  const now = new Date();
  for (const item of queued) {
    const userRecord =
      (item.telegramUsername
        ? getUserByTelegramUsername(item.telegramUsername)
        : undefined) ??
      (item.gitlabUsername ? getUserByGitlabUsername(item.gitlabUsername) : undefined);

    if (userRecord && !isWithinWorkingHours(userRecord, now)) {
      continue;
    }

    await sendHtmlMessage(bot, item.chatId, item.text);
    if (item._id) {
      await markNotificationDelivered(item._id);
    }
  }
};
