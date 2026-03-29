import {
  upsertMergeRequest,
  type MergeRequestDocument,
  findMergeRequest,
  updateMergeRequest,
} from '../../data/mergeRequestRepository';
import { getUserByGitlabUsername, listLeadUsers } from '../../data/userStore';
import { formatGitlabUserLabel } from '../../messages/format';
import {
  buildFinalReviewMessage,
  buildMergeReadyForAuthorMessage,
  buildMergeRequestClosedMessage,
  buildMergeRequestCreatedMessage,
} from '../../messages/templates';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../../messages/send';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../../messages/recipients';
import { persistGitlabUserProfileFromPayload, persistGitlabUserProfiles } from './common';
import { fetchMergeRequest, fetchMergeRequestApprovals } from '../api';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { config } from '../../config';
import { pullReviewers } from '../../data/reviewerQueue';
import {
  markAllRemindersInactiveForMr,
  markReviewCompletedForApprovers,
  syncReviewRemindersForMr,
} from '../../services/reviewReminderService';
import { syncReviewersAndLabelsToGitlab } from '../../services/reviewerLabelSync';

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

const isDraftTitle = (title?: string): boolean =>
  /^draft[: ]/i.test((title ?? '').trim());

const isDraft = (attrs: any): boolean => {
  if (attrs.work_in_progress || attrs.draft) {
    return true;
  }
  return isDraftTitle(attrs.title);
};

const assignReviewersIfNeeded = async (
  doc: MergeRequestDocument,
): Promise<string[] | undefined> => {
  const existing = doc.reviewers ?? [];
  const needed = Math.max(0, 2 - existing.length);
  if (needed === 0) {
    return existing;
  }
  const authorUsername = doc.author.gitlabUsername;
  const exclude = [...existing, ...(authorUsername ? [authorUsername] : [])]
    .filter(Boolean)
    .map((name) => name.toLowerCase());
  const baseReviewers = await pullReviewers(exclude);
  const assignedReviewers = [...existing, ...baseReviewers.slice(0, needed)];
  return assignedReviewers.length ? assignedReviewers : undefined;
};

export const handleMergeRequestEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const project = payload.project ?? {};
  const attrs = payload.object_attributes ?? {};
  await persistGitlabUserProfileFromPayload(payload);
  const projectId = project.id;
  const mrIid = attrs.iid;
  const [apiMergeRequest, apiApprovals] =
    typeof projectId === 'number' && typeof mrIid === 'number'
      ? await Promise.all([
          fetchMergeRequest(projectId, mrIid),
          fetchMergeRequestApprovals(projectId, mrIid),
        ])
      : [undefined, undefined];
  if (apiMergeRequest || apiApprovals) {
    const apiUsers = [
      apiMergeRequest?.author,
      ...(apiMergeRequest?.reviewers ?? []),
      ...(apiApprovals?.approved_by ?? []).map((item) => item.user ?? {}),
    ];
    await persistGitlabUserProfiles(
      apiUsers.filter(Boolean) as Array<{ username?: string; name?: string; id?: number }>,
    );
  }
  const { taskKey, taskUrl } = extractTaskInfo(attrs.source_branch);
  const existingDoc = await findMergeRequest(project.id, attrs.iid);
  const wasDraft = existingDoc?.isDraft ?? false;

  const author = existingDoc?.author ? { ...existingDoc.author } : {};
  const apiAuthor = apiMergeRequest?.author;
  const apiAuthorUsername = apiAuthor?.username;
  let gitlabAuthorUsername = author.gitlabUsername;

  if (!gitlabAuthorUsername && apiAuthorUsername) {
    gitlabAuthorUsername = apiAuthorUsername;
    author.gitlabUsername = apiAuthorUsername;
  }

  if (!author.name && apiAuthor?.name) {
    author.name = apiAuthor.name;
  }

  if (!author.gitlabUsername && attrs.action === 'open') {
    gitlabAuthorUsername =
      payload.object_attributes?.author?.username ?? payload.user?.username;
    if (gitlabAuthorUsername) {
      author.gitlabUsername = gitlabAuthorUsername;
    }
    const payloadAuthorName =
      payload.object_attributes?.author?.name ?? payload.user?.name;
    if (!author.name && payloadAuthorName) {
      author.name = payloadAuthorName;
    }
  }

  if (author.gitlabUsername && !author.telegramUsername) {
    const userRecord = await getUserByGitlabUsername(author.gitlabUsername);
    if (userRecord?.telegramUsername) {
      author.telegramUsername = userRecord.telegramUsername;
    }
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
    isDraft: isDraft(attrs),
  };
  const draftEnded = wasDraft && !doc.isDraft;
  if (draftEnded) {
    console.info(`[merge-request] Draft ended for MR ${doc.projectId}/${doc.iid}`);
  }

  if (existingDoc?.reviewers?.length) {
    doc.reviewers = existingDoc.reviewers;
  }

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

  if (apiApprovals) {
    if (typeof apiApprovals.approvals_required === 'number') {
      doc.approvalsRequired = apiApprovals.approvals_required;
    }
    if (typeof apiApprovals.approvals_left === 'number') {
      doc.approvalsLeft = apiApprovals.approvals_left;
    }
    doc.approvedBy = Array.isArray(apiApprovals.approved_by)
      ? (apiApprovals.approved_by
          .map((item) => item.user?.username)
          .filter(Boolean) as string[])
      : [];
  }

  if (!apiApprovals) {
    if (typeof attrs.approvals_required === 'number') {
      doc.approvalsRequired = attrs.approvals_required;
    }
    if (typeof attrs.approvals_left === 'number') {
      doc.approvalsLeft = attrs.approvals_left;
    }
  }
  if (doc.approvalsRequired === undefined) {
    const fallbackRequired =
      existingDoc?.approvalsRequired ?? config.approvals.defaultRequired;
    if (Number.isFinite(fallbackRequired)) {
      doc.approvalsRequired = fallbackRequired;
    }
  }
  if (
    doc.approvalsLeft === undefined ||
    doc.approvalsLeft === null ||
    typeof doc.approvalsLeft !== 'number'
  ) {
    const fallbackLeft =
      typeof attrs.approvals_left === 'number'
        ? attrs.approvals_left
        : existingDoc?.approvalsLeft;
    if (typeof fallbackLeft === 'number') {
      doc.approvalsLeft = fallbackLeft;
    } else if (typeof doc.approvalsRequired === 'number') {
      doc.approvalsLeft = doc.approvalsRequired;
    } else {
      doc.approvalsLeft = config.approvals.defaultRequired;
    }
  }
  if (typeof doc.approvalsLeft === 'number' && doc.approvalsLeft < 0) {
    doc.approvalsLeft = 0;
  }
  if (
    typeof doc.approvalsRequired === 'number' &&
    typeof doc.approvalsLeft === 'number' &&
    doc.approvalsRequired > 0 &&
    doc.approvalsLeft === 0
  ) {
    const approversCount = (doc.approvedBy ?? []).length;
    if (approversCount < doc.approvalsRequired) {
      doc.approvalsLeft = Math.max(doc.approvalsRequired - approversCount, 0);
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

  if (
    (attrs.action === 'open' || attrs.action === 'update') &&
    !doc.isDraft &&
    !doc.reviewers?.length
  ) {
    const assignedReviewers = await assignReviewersIfNeeded(doc);
    if (assignedReviewers?.length) {
      doc.reviewers = assignedReviewers;
    }
  }

  if ((attrs.action === 'open' || attrs.action === 'update') && !doc.isDraft && doc.reviewers?.length) {
    const syncResult = await syncReviewersAndLabelsToGitlab(
      doc.projectId,
      doc.iid,
      doc.reviewers,
    );
    if (!syncResult.ok) {
      console.warn(
        `[merge-request] Failed to sync reviewer labels for MR ${doc.projectId}/${doc.iid}: ${syncResult.error}`,
      );
    }
  }

  await syncReviewRemindersForMr(
    { projectId: doc.projectId, iid: doc.iid },
    doc.reviewers ?? [],
    new Date(),
    doc.isDraft,
    draftEnded,
  );

  if (attrs.action === 'open' && !doc.isDraft) {
    const reviewerLabels = doc.reviewers?.length
      ? await Promise.all(doc.reviewers.map((reviewer) => formatGitlabUserLabel(reviewer)))
      : [];
    const reviewerList = reviewerLabels.length ? reviewerLabels.join(', ') : 'не назначены';
    const authorLabel = await formatGitlabUserLabel(author.gitlabUsername, author.name);
    const message = buildMergeRequestCreatedMessage({
      title: doc.title ?? '—',
      authorLabel,
      reviewerList,
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
      eventType: 'mr_created',
      projectId: doc.projectId,
      mrIid: doc.iid,
    });
    const authorRecipient = doc.author.gitlabUsername
      ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
      : undefined;
    if (authorRecipient) {
      await deliverHtmlMessage(bot, authorRecipient, message, {
        eventType: 'mr_created',
        projectId: doc.projectId,
        mrIid: doc.iid,
      });
    }
  }

  await upsertMergeRequest(doc);

  let nextApprovers: string[] | undefined;
  if (!apiApprovals && (attrs.action === 'approved' || attrs.action === 'unapproved')) {
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
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
      eventType: 'mr_closed',
      projectId: doc.projectId,
      mrIid: doc.iid,
    });
    const authorRecipient = doc.author.gitlabUsername
      ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
      : undefined;
    if (authorRecipient) {
      await deliverHtmlMessage(bot, authorRecipient, message, {
        eventType: 'mr_closed',
        projectId: doc.projectId,
        mrIid: doc.iid,
      });
    }
    await markAllRemindersInactiveForMr({ projectId: doc.projectId, iid: doc.iid });
    return;
  }

  const approvers =
    doc.approvedBy ?? nextApprovers ?? existingDoc?.approvedBy ?? [];
  const uniqueApprovers = Array.from(new Set(approvers));
  const approversCount = uniqueApprovers.length;
  if (doc.reviewers?.length && uniqueApprovers.length) {
    await markReviewCompletedForApprovers(
      { projectId: doc.projectId, iid: doc.iid },
      doc.reviewers,
      uniqueApprovers,
    );
  }
  const leads = await listLeadUsers();
  const leadUsernames = leads
    .map((lead) => lead.gitlabUsername)
    .filter(Boolean)
    .map((name) => name.toLowerCase());
  const lowerApprovers = uniqueApprovers.map((name) => name.toLowerCase());
  const leadApprovers = lowerApprovers.filter((name) => leadUsernames.includes(name));
  const nonLeadApprovers = lowerApprovers.filter((name) => !leadUsernames.includes(name));

  const approvalTriggered = nonLeadApprovers.length >= 2;
  if (approvalTriggered && approversCount > 0 && !existingDoc?.finalReviewNotified) {
    const message = buildFinalReviewMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
      eventType: 'mr_final_review',
      projectId: doc.projectId,
      mrIid: doc.iid,
    });
    await updateMergeRequest(doc.projectId, doc.iid, { finalReviewNotified: true });
  }

  if (!existingDoc?.authorMergeNotified && approversCount >= 3) {
    if (leadApprovers.length >= 1 && nonLeadApprovers.length >= 2) {
      const message = buildMergeReadyForAuthorMessage({
        title: doc.title ?? '—',
        url: doc.url ?? '—',
        taskUrl: doc.taskUrl,
      });
      const authorRecipient = doc.author.gitlabUsername
        ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
        : undefined;
      if (authorRecipient) {
        await deliverHtmlMessage(bot, authorRecipient, message, {
          eventType: 'mr_ready_to_merge',
          projectId: doc.projectId,
          mrIid: doc.iid,
        });
      } else {
        console.warn('[merge-request] Cannot notify author about merge readiness');
      }
      await updateMergeRequest(doc.projectId, doc.iid, { authorMergeNotified: true });
    }
  }
};
