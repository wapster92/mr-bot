import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest } from '../data/mergeRequestRepository';
import {
  claimNotification,
  listQueuedNotifications,
  markNotificationCancelled,
  markNotificationDelivered,
  markNotificationError,
  type NotificationQueueDocument,
} from '../data/notificationQueueRepository';
import {
  getUserByGitlabUsername,
  getUserByTelegramUsername,
  listActiveReviewers,
  listLeadUsers,
} from '../data/userStore';
import type { UserRecord } from '../data/userTypes';
import { isWithinWorkingHours } from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';
import { isApprovalNotificationRelevant } from './approvalNotifications';
import { withMergeRequestLock } from './mergeRequestLock';
import { shouldNotifyReviewUpdate } from './pushReviewNotifications';

let flushInProgress = false;

const parseMrKey = (key?: string): { projectId: number; iid: number } | undefined => {
  const parts = key?.split(':');
  if (parts?.length !== 2) return undefined;
  const projectId = Number(parts[0]);
  const iid = Number(parts[1]);
  return Number.isInteger(projectId) && projectId > 0 && Number.isInteger(iid) && iid > 0
    ? { projectId, iid }
    : undefined;
};

const notificationObsolete = async (
  item: NotificationQueueDocument,
  user: UserRecord,
  leadUsernames: Set<string>,
  reviewerUsernames: Set<string>,
): Promise<boolean> => {
  if (!['mr_final_review', 'mr_ready_to_merge', 'mr_push'].includes(item.eventType ?? '')) return false;
  const key = parseMrKey(item.mrKey);
  if (!key) return true;
  const mr = await findMergeRequest(key.projectId, key.iid);
  if (item.eventType === 'mr_push') return !shouldNotifyReviewUpdate(mr, user);
  return !isApprovalNotificationRelevant(
    item.eventType, mr, user.gitlabUsername, leadUsernames, reviewerUsernames,
  );
};

const deliverQueuedNotification = async (
  bot: Telegraf<BotContext>,
  item: NotificationQueueDocument,
  now: Date,
  leadUsernames: Set<string>,
  reviewerUsernames: Set<string>,
): Promise<void> => {
  const user =
    (item.telegramUsername ? await getUserByTelegramUsername(item.telegramUsername) : undefined) ??
    (item.gitlabUsername ? await getUserByGitlabUsername(item.gitlabUsername) : undefined);

  if (!user || user.isAllowed === false || user.isActive === false) {
    if (item._id) await markNotificationCancelled(
      item._id, 'Пользователь удалён, отключён или ему запрещён доступ', now,
    );
    return;
  }
  if (await notificationObsolete(item, user, leadUsernames, reviewerUsernames)) {
    if (item._id) await markNotificationCancelled(
      item._id, 'Уведомление об обновлении, проверке или готовности MR больше не актуально', now,
    );
    return;
  }
  if (!isWithinWorkingHours(user, now)) return;
  if (!item._id || !(await claimNotification(item._id, now))) return;

  try {
    await sendHtmlMessage(bot, item.chatId, item.text);
    await markNotificationDelivered(item._id);
  } catch (error) {
    await markNotificationError(item._id, String(error));
    console.warn('[notify] Failed to deliver queued message', error);
  }
};

export const flushNotificationQueue = async (bot: Telegraf<BotContext>): Promise<void> => {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const queued = await listQueuedNotifications(200);
    if (!queued.length) return;
    const now = new Date();
    const [leads, reviewers] = await Promise.all([listLeadUsers(), listActiveReviewers()]);
    const leadUsernames = new Set(leads.map((lead) => lead.gitlabUsername.toLowerCase()));
    const reviewerUsernames = new Set(reviewers.map((name) => name.toLowerCase()));
    for (const item of queued) {
      const deliver = (): Promise<void> =>
        deliverQueuedNotification(bot, item, now, leadUsernames, reviewerUsernames);
      const key = item.eventType === 'mr_push' ? parseMrKey(item.mrKey) : undefined;
      if (key) {
        // Approval webhooks and push delivery use the same MR lock. Recheck
        // queued pushes inside the lock immediately before sending.
        await withMergeRequestLock(key.projectId, key.iid, deliver);
      } else {
        await deliver();
      }
    }
  } finally {
    flushInProgress = false;
  }
};
