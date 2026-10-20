import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { updateMergeRequest, type MergeRequestDocument } from '../data/mergeRequestRepository';
import { listActiveReviewers, listLeadUsers } from '../data/userStore';
import { ensureLeadReviewReminder } from '../data/reviewReminderRepository';
import { getRecipientByGitlabUsername } from '../messages/recipients';
import { deliverHtmlMessage } from '../messages/send';
import { buildFinalReviewMessage, buildMergeReadyForAuthorMessage } from '../messages/templates';
import {
  hasRequiredMergeApprovals,
  needsLeadReview,
  summarizeMergeRequestApprovals,
} from './approvalPolicy';

export const isApprovalNotificationRelevant = (
  eventType: string | undefined,
  mr: MergeRequestDocument | null,
  recipientUsername: string,
  leads: Set<string>,
  reviewers: Set<string>,
): boolean => {
  if (eventType !== 'mr_final_review' && eventType !== 'mr_ready_to_merge') return true;
  if (!mr || mr.isDraft || ['closed', 'merged'].includes(mr.state ?? '')) return false;
  const summary = summarizeMergeRequestApprovals(mr, leads, reviewers);
  return eventType === 'mr_final_review'
    ? needsLeadReview(summary) && summary.pendingLeadUsernames.includes(recipientUsername.toLowerCase())
    : hasRequiredMergeApprovals(summary);
};

export const notifyMergeRequestApprovals = async (
  bot: Telegraf<BotContext>,
  mr: MergeRequestDocument,
): Promise<void> => {
  if (mr.isDraft || ['closed', 'merged'].includes(mr.state ?? '')) return;
  const [leads, reviewers] = await Promise.all([listLeadUsers(), listActiveReviewers()]);
  const summary = summarizeMergeRequestApprovals(
    mr,
    new Set(leads.map((lead) => lead.gitlabUsername.toLowerCase())),
    new Set(reviewers.map((name) => name.toLowerCase())),
  );
  const notified = new Set((mr.finalReviewNotifiedFor ?? []).map((name) => name.toLowerCase()));
  if (needsLeadReview(summary)) {
    for (const username of summary.pendingLeadUsernames) {
      if (!notified.has(username)) {
        const recipient = await getRecipientByGitlabUsername(username);
        if (!recipient) continue;
        await deliverHtmlMessage(bot, recipient, buildFinalReviewMessage(mr), {
          eventType: 'mr_final_review',
          projectId: mr.projectId,
          mrIid: mr.iid,
          dedupeId: 'both-leads-v2',
        });
        notified.add(username);
      }
      // Start at the final-review invitation, never at MR creation. Existing
      // reminders are preserved so periodic sync does not reset the timer.
      await ensureLeadReviewReminder(mr.projectId, mr.iid, username);
    }
  }
  const ready = hasRequiredMergeApprovals(summary);
  let authorNotified = mr.authorMergeNotified ?? false;
  if (!ready) {
    authorNotified = false;
  } else if (!authorNotified && mr.author.gitlabUsername) {
    const recipient = await getRecipientByGitlabUsername(mr.author.gitlabUsername);
    if (recipient) {
      await deliverHtmlMessage(bot, recipient, buildMergeReadyForAuthorMessage(mr), {
        eventType: 'mr_ready_to_merge',
        projectId: mr.projectId,
        mrIid: mr.iid,
        dedupeId: 'both-leads-v2',
      });
      authorNotified = true;
    }
  }
  if (notified.size !== (mr.finalReviewNotifiedFor ?? []).length || authorNotified !== mr.authorMergeNotified) {
    await updateMergeRequest(mr.projectId, mr.iid, {
      finalReviewNotifiedFor: [...notified],
      authorMergeNotified: authorNotified,
    });
  }
};
