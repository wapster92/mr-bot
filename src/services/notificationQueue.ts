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
import {
  getUserByGitlabUsername,
  getUserByTelegramUsername,
  listLeadUsers,
} from '../data/userStore';
import { isWithinWorkingHours } from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';
import { hasLeadApproval, summarizeApprovals } from './approvalPolicy';

let flushInProgress = false;

const finalReviewAlreadyCompleted = async (
  item: {
    eventType?: string;
    mrKey?: string;
  },
  leadUsernames: Set<string>,
): Promise<boolean> => {
  if (
    item.eventType !== 'mr_final_review' ||
    !item.mrKey
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
  return hasLeadApproval(
    summarizeApprovals(mr?.approvedBy ?? [], leadUsernames),
  );
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
    const leads = await listLeadUsers();
    const leadUsernames = new Set(
      leads.map((lead) => lead.gitlabUsername.toLowerCase()),
    );
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

      if (await finalReviewAlreadyCompleted(item, leadUsernames)) {
        if (item._id) {
          await markNotificationCancelled(
            item._id,
            'Финальная проверка уже выполнена другим лидом',
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
