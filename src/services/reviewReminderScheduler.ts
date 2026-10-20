import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest, updateMergeRequest } from '../data/mergeRequestRepository';
import {
  claimReviewReminder,
  findReviewReminderForReviewer,
  incrementReminder,
  listPendingReviewReminders,
  markEscalated,
  markReminderInactive,
  markReviewCompleted,
  releaseReviewReminderClaim,
  type ReviewReminderDocument,
} from '../data/reviewReminderRepository';
import { getUserByGitlabUsername, listActiveReviewers, listLeadUsers } from '../data/userStore';
import { hasReviewFeedbackScore } from '../data/scoreEventRepository';
import { isReviewerEnabled } from '../data/userTypes';
import { fetchMergeRequestNotes } from '../gitlab/api';
import { formatGitlabUserLabel } from '../messages/format';
import { getLeadRecipients, isWithinWorkingHours, getRecipientByGitlabUsername } from '../messages/recipients';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../messages/send';
import { buildReviewEscalationMessage, buildReviewReminderMessage } from '../messages/templates';
import { addWorkingMinutes, getWorkdayMinutes } from './workingHours';
import { recordReviewOverdueScore } from './gameScoring';
import { hasRequiredMergeApprovals, summarizeMergeRequestApprovals } from './approvalPolicy';
import { withMergeRequestLock } from './mergeRequestLock';

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
    const [leads, activeReviewers] = await Promise.all([listLeadUsers(), listActiveReviewers()]);
    const leadUsernames = new Set(leads.map((lead) => lead.gitlabUsername.toLowerCase()));
    const reviewerUsernames = new Set(activeReviewers.map((name) => name.toLowerCase()));
    const processCandidate = async (candidate: ReviewReminderDocument): Promise<void> => {
      let claimedAt: Date | undefined;
      try {
        // A comment/approve may arrive after the initial scan. Read the
        // reminder again under the same lock as the webhook handlers.
        const reminder = await findReviewReminderForReviewer(
          candidate.projectId, candidate.iid, candidate.reviewerUsername,
        );
        if (!reminder || reminder.reviewCompletedAt || reminder.inactiveAt || reminder.escalatedAt) return;
        const mr = await findMergeRequest(reminder.projectId, reminder.iid);
        if (!mr || ['merged', 'closed'].includes(mr.state ?? '')) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          return;
        }
        if (mr.isDraft || isDraftTitle(mr.title)) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          return;
        }

        const reviewerUsername = reminder.reviewerUsername.toLowerCase();
        const summary = summarizeMergeRequestApprovals(mr, leadUsernames, reviewerUsernames);
        const isLeadReview = reminder.isLeadReview === true;
        const stillRequired = isLeadReview
          ? summary.developerApprovers.length > 0 && summary.pendingLeadUsernames.includes(reviewerUsername)
          : mr.reviewers?.some((username) => username.toLowerCase() === reviewerUsername);
        if (hasRequiredMergeApprovals(summary) || !stillRequired) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          return;
        }
        if (mr.approvedBy?.some((username) => username.toLowerCase() === reviewerUsername) ||
          (isLeadReview && (
            mr.reviewCommenters?.some((username) => username.toLowerCase() === reviewerUsername) ||
            await hasReviewFeedbackScore(mr.projectId, mr.iid, reviewerUsername)
          ))) {
          await markReviewCompleted(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          return;
        }

        const reviewer = await getUserByGitlabUsername(reminder.reviewerUsername);
        const available = reviewer && reviewer.isActive !== false && reviewer.isAllowed !== false;
        if (!available || (isLeadReview ? !reviewer.isLead : !isReviewerEnabled(reviewer))) {
          await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
          return;
        }

        if (isLeadReview && !mr.reviewCommentsSyncedAt) {
          // Older versions did not track all lead comments. Verify ordinary
          // and inline discussions once before charging a lead for silence.
          const notes = await fetchMergeRequestNotes(mr.projectId, mr.iid);
          if (!notes) return; // An unavailable API is not evidence of silence.
          const commenters = [...new Set([
            ...(mr.reviewCommenters ?? []),
            ...notes.filter((note) => !note.system && note.authorUsername)
              .map((note) => note.authorUsername!),
          ].map((name) => name.toLowerCase()))];
          await updateMergeRequest(mr.projectId, mr.iid, {
            reviewCommenters: commenters, reviewCommentsSyncedAt: now,
          });
          if (commenters.includes(reviewerUsername)) {
            await markReviewCompleted(reminder.projectId, reminder.iid, reminder.reviewerUsername);
            return;
          }
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

        const firstPenaltyAt = addWorkingMinutes(reviewer, trackingStartedAt, workdayMinutes);
        if (now >= firstPenaltyAt) {
          await recordReviewOverdueScore(reminder, firstPenaltyAt, 1);
        }

        if (isLeadReview) {
          // Leads already have final-review invitations. Only score these
          // timers; do not send developer reminders or an escalation to self.
          if (now >= escalationAt) {
            await recordReviewOverdueScore(reminder, escalationAt, 2);
            await markEscalated(reminder.projectId, reminder.iid, reminder.reviewerUsername, now);
          }
          return;
        }

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
            return;
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
          return;
        }

        const nextReminderAt = addWorkingMinutes(
          reviewer,
          reminder.assignedAt,
          REMINDER_INTERVAL_MINUTES * (reminder.reminderCount + 1),
        );

        if (now < nextReminderAt) {
          return;
        }

        if (!isWithinWorkingHours(reviewer, now)) {
          return;
        }

        const recipient = await getRecipientByGitlabUsername(reminder.reviewerUsername);
        if (!recipient) {
          return;
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
          return;
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
            candidate.projectId,
            candidate.iid,
            candidate.reviewerUsername,
            claimedAt,
          ).catch((releaseError) => {
            console.warn('[review-reminder] Failed to release claim', releaseError);
          });
        }
        console.warn('[review-reminder] Failed to process reminder', error);
      }
    };
    for (const candidate of reminders) {
      await withMergeRequestLock(candidate.projectId, candidate.iid, () => processCandidate(candidate));
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
