import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest, updateMergeRequest } from '../data/mergeRequestRepository';
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
  listActiveUsernames,
  listLeadUsers,
} from '../data/userStore';
import type { UserRecord } from '../data/userTypes';
import { isWithinWorkingHours } from '../messages/recipients';
import { sendHtmlMessage } from '../messages/send';
import { isApprovalNotificationRelevant } from './approvalNotifications';
import { withMergeRequestLock } from './mergeRequestLock';
import { shouldNotifyReviewUpdate } from './pushReviewNotifications';
import { loadReviewCommentHistory } from './reviewCommentHistory';

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
  commenterUsernames: Set<string>,
  verifyHistory: boolean,
): Promise<boolean | 'defer'> => {
  if (!['mr_final_review', 'mr_ready_to_merge', 'mr_push'].includes(item.eventType ?? '')) return false;
  const key = parseMrKey(item.mrKey);
  if (!key) return true;
  const mr = await findMergeRequest(key.projectId, key.iid);
  if (item.eventType === 'mr_push') return !shouldNotifyReviewUpdate(mr, user);
  if (mr && item.eventType === 'mr_ready_to_merge') {
    const version = item.dedupeKey?.match(/:comment-approvers-v1:(\d+)$/)?.[1];
    if (Number(version ?? 0) !== (mr.authorMergeNotificationVersion ?? 0)) return true;
    if (verifyHistory) {
      const history = await loadReviewCommentHistory(mr);
      if (Object.keys(history).length) {
        Object.assign(mr, history);
        await updateMergeRequest(key.projectId, key.iid, history);
      }
    }
    const knownReady = isApprovalNotificationRelevant(item.eventType,
      { ...mr, reviewCommentHistorySyncPending: false }, user.gitlabUsername,
      leadUsernames, reviewerUsernames, commenterUsernames);
    if (knownReady && mr.reviewCommentHistorySyncPending) return 'defer';
    if (!knownReady && mr.authorMergeNotified) {
      // History may discover a missed comment before periodic sync does.
      // Invalidate this delivery cycle now so a later approve can notify again.
      await updateMergeRequest(key.projectId, key.iid, {
        authorMergeNotified: false,
        authorMergeNotificationVersion: (mr.authorMergeNotificationVersion ?? 0) + 1,
      });
    }
  }
  return !isApprovalNotificationRelevant(
    item.eventType, mr, user.gitlabUsername, leadUsernames, reviewerUsernames, commenterUsernames,
  );
};

const deliverQueuedNotification = async (
  bot: Telegraf<BotContext>,
  item: NotificationQueueDocument,
  now: Date,
  leadUsernames: Set<string>,
  reviewerUsernames: Set<string>,
  commenterUsernames: Set<string>,
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
  if (item.eventType === 'mr_merged_without_approval' && user.isLead !== true) {
    if (item._id) await markNotificationCancelled(item._id, 'Пользователь больше не является лидом', now);
    return;
  }
  if (item.eventType === 'mr_merge_policy_warning' && user.isLead === true) {
    if (item._id) await markNotificationCancelled(item._id, 'Исполнитель слияния теперь является лидом', now);
    return;
  }
  const withinHours = item.ignoreWorkHours === true || isWithinWorkingHours(user, now);
  const obsolete = await notificationObsolete(item, user, leadUsernames, reviewerUsernames, commenterUsernames, withinHours);
  if (obsolete === 'defer') return;
  if (obsolete) {
    if (item._id) await markNotificationCancelled(
      item._id, 'Уведомление об обновлении, проверке или готовности MR больше не актуально', now,
    );
    return;
  }
  if (!withinHours) return;
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
    const [leads, reviewers, users] = await Promise.all([listLeadUsers(), listActiveReviewers(), listActiveUsernames()]);
    const leadUsernames = new Set(leads.map((lead) => lead.gitlabUsername.toLowerCase()));
    const reviewerUsernames = new Set(reviewers.map((name) => name.toLowerCase()));
    const commenterUsernames = new Set(users.map((name) => name.toLowerCase()));
    for (const item of queued) {
      const deliver = (): Promise<void> =>
        deliverQueuedNotification(bot, item, now, leadUsernames, reviewerUsernames, commenterUsernames);
      const key = ['mr_push', 'mr_final_review', 'mr_ready_to_merge'].includes(item.eventType ?? '')
        ? parseMrKey(item.mrKey) : undefined;
      if (key) {
        // Comments, approvals and queued MR notifications share the lock.
        // Recheck relevance immediately before sending, not before waiting.
        await withMergeRequestLock(key.projectId, key.iid, deliver);
      } else {
        await deliver();
      }
    }
  } finally {
    flushInProgress = false;
  }
};
