import {
  upsertMergeRequest,
  type MergeRequestDocument,
  findMergeRequest,
  updateMergeRequest,
} from '../../data/mergeRequestRepository';
import { getUserByGitlabUsername } from '../../data/userStore';
import { formatGitlabUserLabel } from '../../messages/format';
import {
  buildFinalReviewMessage,
  buildMergeRequestClosedMessage,
  buildMergeRequestCreatedMessage,
} from '../../messages/templates';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../../messages/send';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../../messages/recipients';
import { persistGitlabUserProfileFromPayload } from './common';
import { pullReviewers } from '../../data/reviewerQueue';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { config } from '../../config';

const ISSUE_KEY_REGEX = /([A-Z]+-\d+)/;

const extractTaskInfo = (sourceBranch?: string): { taskKey?: string; taskUrl?: string } => {
  if (!sourceBranch) {
    return {};
  }

  const match = sourceBranch.match(ISSUE_KEY_REGEX);
  const taskKey = match?.[1];
  if (!taskKey) {
    return {};
  }

  const result: { taskKey?: string; taskUrl?: string } = { taskKey };

  if (config.jira.baseUrl) {
    const base = config.jira.baseUrl.replace(/\/$/, '');
    result.taskUrl = `${base}/${taskKey}`;
  }

  return result;
};

const parseDate = (value?: string): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const isDraft = (attrs: any): boolean => {
  if (attrs.work_in_progress) {
    return true;
  }
  const title: string = attrs.title ?? '';
  return /^draft[: ]/i.test(title.trim());
};

export const handleMergeRequestEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const project = payload.project ?? {};
  const attrs = payload.object_attributes ?? {};
  await persistGitlabUserProfileFromPayload(payload);
  const { taskKey, taskUrl } = extractTaskInfo(attrs.source_branch);
  const existingDoc = await findMergeRequest(project.id, attrs.iid);

  let author = existingDoc?.author ?? {};
  let gitlabAuthorUsername: string | undefined;

  if (!existingDoc?.author && attrs.action === 'open') {
    gitlabAuthorUsername =
      payload.object_attributes?.author?.username ?? payload.user?.username;
    const userRecord = await getUserByGitlabUsername(gitlabAuthorUsername);
    author = {
      ...(gitlabAuthorUsername ? { gitlabUsername: gitlabAuthorUsername } : {}),
      ...(userRecord?.telegramUsername ? { telegramUsername: userRecord.telegramUsername } : {}),
      ...(payload.object_attributes?.author?.name
        ? { name: payload.object_attributes.author.name }
        : payload.user?.name
        ? { name: payload.user.name }
        : {}),
    };
  }

  const doc: MergeRequestDocument = {
    projectId: project.id,
    projectPath: project.path_with_namespace,
    mrId: attrs.id,
    iid: attrs.iid,
    title: attrs.title,
    sourceBranch: attrs.source_branch,
    targetBranch: attrs.target_branch,
    url: attrs.url,
    author,
    action: attrs.action,
  };

  if (attrs.description) {
    doc.description = attrs.description;
  }
  if (attrs.state) {
    doc.state = attrs.state;
  }
  if (attrs.merge_status) {
    doc.mergeStatus = attrs.merge_status;
  }
  if (attrs.detailed_merge_status) {
    doc.detailedMergeStatus = attrs.detailed_merge_status;
  }

  if (typeof attrs.approvals_required === 'number') {
    doc.approvalsRequired = attrs.approvals_required;
  }
  if (typeof attrs.approvals_left === 'number') {
    doc.approvalsLeft = attrs.approvals_left;
  }
  if (doc.approvalsRequired === undefined) {
    const fallbackRequired =
      existingDoc?.approvalsRequired ?? config.approvals.defaultRequired;
    if (Number.isFinite(fallbackRequired)) {
      doc.approvalsRequired = fallbackRequired;
    }
  }
  if (taskKey) {
    doc.taskKey = taskKey;
  }
  if (taskUrl) {
    doc.taskUrl = taskUrl;
  }
  const createdAt = parseDate(attrs.created_at);
  if (createdAt) {
    doc.createdAt = createdAt;
  }
  const updatedAt = parseDate(attrs.updated_at);
  if (updatedAt) {
    doc.updatedAt = updatedAt;
  }

  if (attrs.action === 'open' && !isDraft(attrs)) {
    const reviewerSource = author.gitlabUsername ?? gitlabAuthorUsername ?? '';
    const reviewers = await pullReviewers([reviewerSource].filter(Boolean) as string[]);
    if (reviewers.length) {
      doc.reviewers = reviewers;
      const reviewerLabels = await Promise.all(
        reviewers.map((reviewer) => formatGitlabUserLabel(reviewer)),
      );
      const reviewerList = reviewerLabels.join(', ');
      const authorLabel = await formatGitlabUserLabel(author.gitlabUsername, author.name);
      const message = buildMergeRequestCreatedMessage({
        title: doc.title ?? '—',
        authorLabel,
        reviewerList,
        url: doc.url ?? '—',
        taskUrl: doc.taskUrl,
      });
      await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message);
      const authorRecipient = doc.author.gitlabUsername
        ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
        : undefined;
      if (authorRecipient) {
        await deliverHtmlMessage(bot, authorRecipient, message);
      }
    }
  }

  await upsertMergeRequest(doc);

  let nextApprovers: string[] | undefined;
  if (attrs.action === 'approved' || attrs.action === 'unapproved') {
    const actorUsername = payload.user?.username;
    if (actorUsername) {
      const currentApprovers = existingDoc?.approvedBy ?? [];
      nextApprovers =
        attrs.action === 'approved'
          ? Array.from(new Set([...currentApprovers, actorUsername]))
          : currentApprovers.filter((username) => username !== actorUsername);
      await updateMergeRequest(doc.projectId, doc.iid, { approvedBy: nextApprovers });
    }
  }

  if (attrs.action === 'close' || attrs.action === 'merge') {
    const closerName = await formatGitlabUserLabel(payload.user?.username, payload.user?.name);
    const originalAuthorName = await formatGitlabUserLabel(
      doc.author.gitlabUsername,
      doc.author.name,
    );
    const actionText = attrs.action === 'merge' ? 'слит' : 'закрыт';
    const message = buildMergeRequestClosedMessage({
      title: doc.title ?? '—',
      actionText,
      authorLabel: originalAuthorName,
      closerLabel: closerName,
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message);
    const authorRecipient = doc.author.gitlabUsername
      ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
      : undefined;
    if (authorRecipient) {
      await deliverHtmlMessage(bot, authorRecipient, message);
    }
    return;
  }

  const approvalsLeft =
    typeof attrs.approvals_left === 'number'
      ? attrs.approvals_left
      : existingDoc?.approvalsLeft;
  const approvalsRequired =
    typeof doc.approvalsRequired === 'number'
      ? doc.approvalsRequired
      : existingDoc?.approvalsRequired ?? config.approvals.defaultRequired;
  const approversCount =
    nextApprovers?.length ?? existingDoc?.approvedBy?.length ?? 0;
  // Notify only when the MR has zero approvals left or enough approvals were collected.
  const approvalTriggered =
    typeof approvalsLeft === 'number'
      ? approvalsLeft <= 0
      : approvalsRequired > 0
      ? approversCount >= approvalsRequired
      : false;
  if (approvalTriggered && !existingDoc?.finalReviewNotified) {
    const message = buildFinalReviewMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message);
    await updateMergeRequest(doc.projectId, doc.iid, { finalReviewNotified: true });
  }
};
