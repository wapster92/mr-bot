import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest } from '../data/mergeRequestRepository';
import {
  claimReviewReminder,
  incrementReminder,
  listPendingReviewReminders,
  markEscalated,
  markReminderInactive,
  releaseReviewReminderClaim,
} from '../data/reviewReminderRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import { isReviewerEnabled } from '../data/userTypes';
import { formatGitlabUserLabel } from '../messages/format';
import { getLeadRecipients, isWithinWorkingHours, getRecipientByGitlabUsername } from '../messages/recipients';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../messages/send';
import { buildReviewEscalationMessage, buildReviewReminderMessage } from '../messages/templates';
import { addWorkingMinutes, getWorkdayMinutes } from './workingHours';
import { recordReviewOverdueScore } from './gameScoring';

const REMINDER_INTERVAL_MINUTES = 180;
const ESCALATION_DAYS = 2;
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
let schedulerRunning = false;

const isDraftTitle = (title?: string): boolean =>
  /^draft[: ]/i.test((title ?? '').trim());

const getReminderLevel = (reminderCount: number): 1 | 2 | 3 => {
  if (reminderCount <= 0) return 1;
  if (reminderCount === 1) return 2;
  return 3;
};

export const runReviewReminderScheduler = async (bot: Telegraf<BotContext>): Promise<void> => {
  if (schedulerRunning) {
    return;
  }
  schedulerRunning = true;

  try {
    const reminders = await listPendingReviewReminders(200);
    if (!reminders.length) {
      return;
    }

    const now = new Date();
    for (const reminder of reminders) {
      let claimedAt: Date | undefined;
      try {
        const mr = await findMergeRequest(reminder.projectId, reminder.iid);
        if (!mr || ['merged', 'closed'].includes(mr.state ?? '')) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          continue;
        }
        if (mr.isDraft || isDraftTitle(mr.title)) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          continue;
        }

        const reviewer = await getUserByGitlabUsername(reminder.reviewerUsername);
        if (!reviewer || !isReviewerEnabled(reviewer)) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          continue;
        }

        const workdayMinutes = getWorkdayMinutes(reviewer);
        const trackingStartedAt =
          reminder.gameStartedAt && reminder.gameStartedAt > reminder.assignedAt
            ? reminder.gameStartedAt
            : reminder.assignedAt;
        const escalationAt = addWorkingMinutes(
          reviewer,
          trackingStartedAt,
          workdayMinutes * ESCALATION_DAYS,
        );

        if (now >= escalationAt) {
          claimedAt = new Date();
          const claimed = await claimReviewReminder(
            reminder.projectId,
            reminder.iid,
            reminder.reviewerUsername,
            claimedAt,
          );
          if (!claimed) {
            claimedAt = undefined;
            continue;
          }
          const reviewerLabel = await formatGitlabUserLabel(
            reviewer.gitlabUsername,
            reviewer.name,
          );
          const message = buildReviewEscalationMessage({
            title: mr.title ?? '—',
            url: mr.url ?? '—',
            taskUrl: mr.taskUrl,
            reviewerLabel,
          });
          await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
            eventType: 'mr_review_escalation',
            projectId: mr.projectId,
            mrIid: mr.iid,
            dedupeId:
              `${reminder.reviewerUsername}:` +
              `${reminder.assignedAt.toISOString()}:escalation`,
          });
          await recordReviewOverdueScore(reminder, escalationAt);
          await markEscalated(
            reminder.projectId,
            reminder.iid,
            reminder.reviewerUsername,
            now,
            claimedAt,
          );
          claimedAt = undefined;
          continue;
        }

        const nextReminderAt = addWorkingMinutes(
          reviewer,
          reminder.assignedAt,
          REMINDER_INTERVAL_MINUTES * (reminder.reminderCount + 1),
        );

        if (now < nextReminderAt) {
          continue;
        }

        if (!isWithinWorkingHours(reviewer, now)) {
          continue;
        }

        const recipient = await getRecipientByGitlabUsername(reminder.reviewerUsername);
        if (!recipient) {
          continue;
        }

        claimedAt = new Date();
        const claimed = await claimReviewReminder(
          reminder.projectId,
          reminder.iid,
          reminder.reviewerUsername,
          claimedAt,
        );
        if (!claimed) {
          claimedAt = undefined;
          continue;
        }

        const level = getReminderLevel(reminder.reminderCount);
        const message = buildReviewReminderMessage({
          title: mr.title ?? '—',
          url: mr.url ?? '—',
          taskUrl: mr.taskUrl,
          level,
        });
        await deliverHtmlMessage(bot, recipient, message, {
          eventType: 'mr_review_reminder',
          projectId: mr.projectId,
          mrIid: mr.iid,
          dedupeId:
            `${reminder.reviewerUsername}:${reminder.assignedAt.toISOString()}:` +
            `${reminder.reminderCount + 1}`,
        });
        await incrementReminder(
          reminder.projectId,
          reminder.iid,
          reminder.reviewerUsername,
          now,
          claimedAt,
        );
        claimedAt = undefined;
      } catch (error) {
        if (claimedAt) {
          await releaseReviewReminderClaim(
            reminder.projectId,
            reminder.iid,
            reminder.reviewerUsername,
            claimedAt,
          ).catch((releaseError) => {
            console.warn('[review-reminder] Failed to release claim', releaseError);
          });
        }
        console.warn('[review-reminder] Failed to process reminder', error);
      }
    }
  } finally {
    schedulerRunning = false;
  }
};

export const startReviewReminderScheduler = (bot: Telegraf<BotContext>): void => {
  const run = (): void => {
    void runReviewReminderScheduler(bot).catch((error) => {
      console.error('[review-reminder] Scheduler failed', error);
    });
  };
  run();
  setInterval(() => {
    run();
  }, SCHEDULER_INTERVAL_MS);
};
