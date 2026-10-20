import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import type { MergeApprovalAudit, MergeRequestDocument } from '../data/mergeRequestRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import { formatGitlabUserLabel } from '../messages/format';
import {
  getLeadRecipients,
  getRecipientByGitlabUsername,
  type DeliveryRecipient,
} from '../messages/recipients';
import { deliverHtmlMessageToRecipients } from '../messages/send';
import {
  buildMergeApprovalAlertMessage,
  buildMergeApprovalWarningForMergerMessage,
  buildMergeRequestClosedMessage,
  buildMergeRequestCreatedMessage,
} from '../messages/templates';

type ClosingEvent = {
  action: 'close' | 'merge';
  actorUsername?: string | undefined;
  actorName?: string | undefined;
  updatedAt?: string | undefined;
};

const isSameRecipient = (left: DeliveryRecipient, right: DeliveryRecipient): boolean =>
  (left.chatId !== undefined && left.chatId === right.chatId) ||
  Boolean(left.gitlabUsername && left.gitlabUsername.toLowerCase() === right.gitlabUsername?.toLowerCase());

const getMergerWarningRecipient = async (
  audit: MergeApprovalAudit | undefined,
): Promise<DeliveryRecipient | undefined> => {
  // An unavailable API is not a proven violation. Use the saved actual merger,
  // never the author or the actor of a repeated webhook.
  if (audit?.status !== 'missing_approvals' || !audit.mergerUsername) return undefined;
  const user = await getUserByGitlabUsername(audit.mergerUsername);
  if (!user || user.isLead === true) return undefined;
  return getRecipientByGitlabUsername(audit.mergerUsername);
};

export const notifyMergeRequestCreated = async (
  bot: Telegraf<BotContext>,
  mr: MergeRequestDocument,
  notificationId?: string,
): Promise<void> => {
  const reviewers = await Promise.all((mr.reviewers ?? []).map((name) => formatGitlabUserLabel(name)));
  const authorLabel = await formatGitlabUserLabel(mr.author.gitlabUsername, mr.author.name);
  const message = buildMergeRequestCreatedMessage({
    title: mr.title ?? '—', authorLabel, reviewerList: reviewers.join(', ') || 'не назначены',
    url: mr.url ?? '—', taskUrl: mr.taskUrl,
  });
  const author = mr.author.gitlabUsername
    ? await getRecipientByGitlabUsername(mr.author.gitlabUsername) : undefined;
  await deliverHtmlMessageToRecipients(bot, [
    ...(await getLeadRecipients()), ...(author ? [author] : []),
  ], message, {
    eventType: 'mr_created', projectId: mr.projectId, mrIid: mr.iid,
    ...(notificationId ? { dedupeId: notificationId } : {}),
  });
};

// Caller holds the MR lock and has already persisted the audit. Delivery keys,
// recipient overlap and work-hours exceptions belong here, not in the webhook.
export const notifyMergeRequestClosed = async (
  bot: Telegraf<BotContext>,
  mr: MergeRequestDocument,
  event: ClosingEvent,
): Promise<void> => {
  const audit = event.action === 'merge' ? mr.mergeApprovalAudit : undefined;
  const closerLabel = await formatGitlabUserLabel(
    audit?.mergerUsername ?? event.actorUsername, audit?.mergerName ?? event.actorName,
  );
  const leads = await getLeadRecipients();
  const needsAlert = audit?.status === 'missing_approvals' || audit?.status === 'unverified';
  const alertedRecipients = needsAlert ? [...leads] : [];
  const urgentMeta = {
    projectId: mr.projectId, mrIid: mr.iid, dedupeId: 'merge-audit-v1', ignoreWorkHours: true,
  };
  if (needsAlert) {
    await deliverHtmlMessageToRecipients(bot, leads, buildMergeApprovalAlertMessage({
      title: mr.title ?? '—', url: mr.url ?? '—', taskUrl: mr.taskUrl,
      mergerLabel: closerLabel, missingApprovals: audit.missingApprovals,
      unverified: audit.status === 'unverified',
    }), { ...urgentMeta, eventType: 'mr_merged_without_approval' });
  }
  const merger = await getMergerWarningRecipient(audit);
  if (merger && audit) {
    await deliverHtmlMessageToRecipients(bot, [merger], buildMergeApprovalWarningForMergerMessage({
      title: mr.title ?? '—', url: mr.url ?? '—', taskUrl: mr.taskUrl,
      missingApprovals: audit.missingApprovals,
    }), { ...urgentMeta, eventType: 'mr_merge_policy_warning' });
    alertedRecipients.push(merger);
  }

  const authorLabel = await formatGitlabUserLabel(mr.author.gitlabUsername, mr.author.name);
  const message = buildMergeRequestClosedMessage({
    title: mr.title ?? '—', actionText: event.action === 'merge' ? 'слит' : 'закрыт',
    authorLabel, closerLabel, url: mr.url ?? '—', taskUrl: mr.taskUrl,
  });
  const author = mr.author.gitlabUsername
    ? await getRecipientByGitlabUsername(mr.author.gitlabUsername) : undefined;
  const authorAlreadyAlerted = author && alertedRecipients.some((recipient) => isSameRecipient(recipient, author));
  await deliverHtmlMessageToRecipients(bot, [
    ...(needsAlert ? [] : leads), ...(author && !authorAlreadyAlerted ? [author] : []),
  ], message, {
    eventType: 'mr_closed', projectId: mr.projectId, mrIid: mr.iid,
    dedupeId: event.action === 'merge' ? 'merge' : `close:${event.updatedAt ?? ''}`,
  });
};
