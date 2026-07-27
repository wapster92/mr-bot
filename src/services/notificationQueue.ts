import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest } from '../data/mergeRequestRepository';
import {
  claimNotification,
  listQueuedNotifications,
  markNotificationCancelled,
  markNotificationDelivered,
  markNotificationError,
} from '../data/notificationQueueRepository';
import { getUserByGitlabUsername, getUserByTelegramUsername } from '../data/userStore';
import {
  hasGitlabUserApproved,
  isWithinWorkingHours,
} from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';

let flushInProgress = false;

const recipientAlreadyApprovedFinalReview = async (
  item: {
    eventType?: string;
    mrKey?: string;
    gitlabUsername?: string;
  },
): Promise<boolean> => {
  if (
    item.eventType !== 'mr_final_review' ||
    !item.mrKey ||
    !item.gitlabUsername
  ) {
    return false;
  }
  const [projectIdText, iidText] = item.mrKey.split(':');
  const projectId = Number(projectIdText);
  const iid = Number(iidText);
  if (!Number.isInteger(projectId) || !Number.isInteger(iid)) {
    return false;
  }
  const mr = await findMergeRequest(projectId, iid);
  return hasGitlabUserApproved(mr?.approvedBy ?? [], item.gitlabUsername);
};

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

      if (await recipientAlreadyApprovedFinalReview(item)) {
        if (item._id) {
          await markNotificationCancelled(
            item._id,
            'Лид уже поставил approve этому MR',
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
