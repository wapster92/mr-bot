import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import {
  claimNotification,
  listQueuedNotifications,
  markNotificationCancelled,
  markNotificationDelivered,
  markNotificationError,
} from '../data/notificationQueueRepository';
import { getUserByGitlabUsername, getUserByTelegramUsername } from '../data/userStore';
import { isWithinWorkingHours } from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';

let flushInProgress = false;

export const flushNotificationQueue = async (bot: Telegraf<BotContext>): Promise<void> => {
  if (flushInProgress) {
    return;
  }
  flushInProgress = true;

  try {
    const queued = await listQueuedNotifications(200);
    if (!queued.length) {
      return;
    }

    const now = new Date();
    for (const item of queued) {
      const userRecord =
        (item.telegramUsername
          ? await getUserByTelegramUsername(item.telegramUsername)
          : undefined) ??
        (item.gitlabUsername ? await getUserByGitlabUsername(item.gitlabUsername) : undefined);

      if (!userRecord || userRecord.isAllowed === false || userRecord.isActive === false) {
        if (item._id) {
          await markNotificationCancelled(
            item._id,
            'Пользователь удалён, отключён или ему запрещён доступ',
            now,
          );
        }
        continue;
      }

      if (!isWithinWorkingHours(userRecord, now)) {
        continue;
      }

      if (!item._id || !(await claimNotification(item._id, now))) {
        continue;
      }

      try {
        await sendHtmlMessage(bot, item.chatId, item.text);
        await markNotificationDelivered(item._id);
      } catch (error) {
        await markNotificationError(item._id, String(error));
        console.warn('[notify] Failed to deliver queued message', error);
      }
    }
  } finally {
    flushInProgress = false;
  }
};
