import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { config } from '../../config';
import {
  clearMergeRequestGameReady,
  findMergeRequest,
  upsertMergeRequest,
  type MergeRequestDocument,
} from '../../data/mergeRequestRepository';
import { getUserByGitlabUsername } from '../../data/userStore';
import { notifyMergeRequestApprovals } from '../../services/approvalNotifications';
import { recordMergedMrScore, runGameAction } from '../../services/gameScoring';
import { auditMergeApprovals } from '../../services/mergeApprovalAudit';
import { syncMergeRequestGameReadiness } from '../../services/mergeReadiness';
import {
  recordMergeRequestApprovalEvent,
  resolveMergeRequestApprovals,
} from '../../services/mergeRequestApprovalEvents';
import {
  notifyMergeRequestClosed,
  notifyMergeRequestCreated,
} from '../../services/mergeRequestLifecycleNotifications';
import { withMergeRequestLock } from '../../services/mergeRequestLock';
import { getMergeRequestFinishedAt } from '../../services/mergeRequestRetention';
import { loadReviewCommentHistory } from '../../services/reviewCommentHistory';
import {
  markAllRemindersInactiveForMr,
  markReviewCompletedForApprovers,
  syncReviewRemindersForMr,
} from '../../services/reviewReminderService';
import { reconcileReviewersForMr } from '../../services/reviewerAssignment';
import { fetchMergeRequest, fetchMergeRequestApprovals } from '../api';
import { persistGitlabUserProfileFromPayload, persistGitlabUserProfiles } from './common';

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

const handleMergeRequestEventUnlocked = async (
  payload: any,
  bot: Telegraf<BotContext>,
): Promise<void> => {
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
      apiMergeRequest?.merge_user,
      apiMergeRequest?.merged_by,
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
    ...existingDoc,
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
    isDraft: isDraft(apiMergeRequest ?? attrs),
  };
  const draftEnded = wasDraft && !doc.isDraft;
  if (draftEnded) {
    console.info(`[merge-request] Draft ended for MR ${doc.projectId}/${doc.iid}`);
  }

  if (attrs.description) {
    doc.description = attrs.description;
  }
  if (attrs.state) {
    doc.state = attrs.state;
  }
  if (apiMergeRequest?.state) doc.state = apiMergeRequest.state;
  if (attrs.action === 'close') doc.state = 'closed';
  if (attrs.action === 'merge') doc.state = 'merged';
  if (attrs.merge_status) {
    doc.mergeStatus = attrs.merge_status;
  }
  if (attrs.detailed_merge_status) {
    doc.detailedMergeStatus = attrs.detailed_merge_status;
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
  const actionedAt = parseDate(attrs.actioned_at) ?? updatedAt;
  const terminalDate = parseDate(
    doc.state === 'merged'
      ? apiMergeRequest?.merged_at ?? attrs.merged_at
      : apiMergeRequest?.closed_at ?? attrs.closed_at,
  ) ?? ((attrs.action === 'close' || attrs.action === 'merge') ? actionedAt : undefined);
  doc.finishedAt = getMergeRequestFinishedAt(doc, existingDoc, terminalDate);
  if (attrs.action === 'open' && !existingDoc?.gameStartedAt) {
    doc.gameStartedAt = createdAt ?? updatedAt ?? new Date();
  }

  const approvalEvent = {
    action: attrs.action, system: attrs.system, actorUsername: payload.user?.username,
    approvalsRequired: attrs.approvals_required, approvalsLeft: attrs.approvals_left,
  };
  Object.assign(doc, resolveMergeRequestApprovals(
    existingDoc, apiApprovals, approvalEvent, config.approvals.defaultRequired,
  ));

  Object.assign(doc, await loadReviewCommentHistory(doc));
  if (attrs.action === 'merge') {
    // merge_user identifies the person responsible for an auto-merge as well.
    // Older GitLab versions expose only merged_by; the webhook actor is the fallback.
    const merger = apiMergeRequest?.merge_user ?? apiMergeRequest?.merged_by ?? payload.user ?? {};
    doc.mergeApprovalAudit = await auditMergeApprovals(doc, merger, Array.isArray(apiApprovals?.approved_by));
  }
  const reviewerState = await reconcileReviewersForMr(doc, apiMergeRequest?.labels);
  doc.reviewers = reviewerState.reviewers;
  doc.reviewerLabels = reviewerState.reviewerLabels;
  doc.approvalRequestedAt = reviewerState.approvalRequestedAt;
  doc.reviewerLabelsCleanupPending =
    ['closed', 'merged'].includes(doc.state ?? '') && !reviewerState.labelsSyncOk;
  if (reviewerState.labelsSyncOk) {
    doc.reviewersSyncedAt = new Date();
  } else {
    doc.reviewersSyncFailedAt = new Date();
    doc.reviewersSyncError = reviewerState.labelsSyncError ?? 'GitLab label sync failed';
    console.warn(
      `[merge-request] Failed to sync reviewer labels for MR ${doc.projectId}/${doc.iid}: ${doc.reviewersSyncError}`,
    );
  }

  await upsertMergeRequest(doc);

  await syncReviewRemindersForMr(
    { projectId: doc.projectId, iid: doc.iid },
    doc.reviewers ?? [],
    new Date(),
    doc.isDraft || ['closed', 'merged'].includes(doc.state ?? '') || reviewerState.approvalsComplete,
    draftEnded,
  );

  if (attrs.action === 'open' && !doc.isDraft) {
    const notificationId = attrs.created_at ?? attrs.updated_at;
    await notifyMergeRequestCreated(bot, doc, notificationId ? String(notificationId) : undefined);
  }

  await recordMergeRequestApprovalEvent(doc, existingDoc, approvalEvent, Boolean(apiApprovals), actionedAt);

  if (attrs.action === 'close' || attrs.action === 'merge') {
    if (attrs.action === 'merge') {
      const scoreMr: MergeRequestDocument = { ...existingDoc, ...doc };
      await runGameAction(`merge ${doc.projectId}/${doc.iid}`, () =>
        recordMergedMrScore(
          scoreMr,
          parseDate(attrs.merged_at) ?? actionedAt ?? new Date(),
        ),
      );
    }
    await clearMergeRequestGameReady(doc.projectId, doc.iid);
    await notifyMergeRequestClosed(bot, doc, {
      action: attrs.action, actorUsername: payload.user?.username,
      actorName: payload.user?.name, updatedAt: attrs.updated_at,
    });
    await markAllRemindersInactiveForMr({ projectId: doc.projectId, iid: doc.iid });
    return;
  }

  const approvers =
    doc.approvedBy ?? existingDoc?.approvedBy ?? [];
  const uniqueApprovers = Array.from(new Set(approvers));
  if (doc.reviewers?.length && uniqueApprovers.length) {
    await markReviewCompletedForApprovers(
      { projectId: doc.projectId, iid: doc.iid },
      doc.reviewers,
      uniqueApprovers,
    );
  }
  await notifyMergeRequestApprovals(bot, doc);

  await runGameAction(`readiness ${doc.projectId}/${doc.iid}`, async () => {
    await syncMergeRequestGameReadiness(
      doc.projectId,
      doc.iid,
      updatedAt ?? new Date(),
    );
  });
};

export const handleMergeRequestEvent = async (
  payload: any,
  bot: Telegraf<BotContext>,
): Promise<void> => {
  const projectId = payload.project?.id;
  const iid = payload.object_attributes?.iid;
  if (typeof projectId !== 'number' || typeof iid !== 'number') {
    await handleMergeRequestEventUnlocked(payload, bot);
    return;
  }
  await withMergeRequestLock(projectId, iid, () =>
    handleMergeRequestEventUnlocked(payload, bot),
  );
};
