import {
  upsertMergeRequest,
  type MergeRequestDocument,
  findMergeRequest,
  updateMergeRequest,
  clearMergeRequestGameReady,
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
import {
  filterRecipientsWithoutApproval,
  getLeadRecipients,
  getRecipientByGitlabUsername,
} from '../../messages/recipients';
import { persistGitlabUserProfileFromPayload, persistGitlabUserProfiles } from './common';
import { fetchMergeRequest, fetchMergeRequestApprovals } from '../api';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { config } from '../../config';
import {
  markAllRemindersInactiveForMr,
  markReviewCompletedForApprovers,
  syncReviewRemindersForMr,
} from '../../services/reviewReminderService';
import { reconcileReviewersForMr } from '../../services/reviewerAssignment';
import { withMergeRequestLock } from '../../services/mergeRequestLock';
import {
  recordMergedMrScore,
  recordReviewApprovalScore,
  recordReviewUnapprovalScore,
  runGameAction,
} from '../../services/gameScoring';
import { syncMergeRequestGameReadiness } from '../../services/mergeReadiness';

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

  if (existingDoc?.reviewers) {
    doc.reviewers = existingDoc.reviewers;
  }
  if (existingDoc?.reviewerLabels) {
    doc.reviewerLabels = existingDoc.reviewerLabels;
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
  const actionedAt = parseDate(attrs.actioned_at) ?? updatedAt;
  if (attrs.action === 'open' && !existingDoc?.gameStartedAt) {
    doc.gameStartedAt = createdAt ?? updatedAt ?? new Date();
  }

  if (attrs.action === 'open' || attrs.action === 'update') {
    const reviewerState = await reconcileReviewersForMr(
      doc,
      apiMergeRequest?.labels,
    );
    doc.reviewers = reviewerState.reviewers;
    doc.reviewerLabels = reviewerState.reviewerLabels;
    if (reviewerState.labelsSyncOk) {
      doc.reviewersSyncedAt = new Date();
    } else {
      doc.reviewersSyncFailedAt = new Date();
      doc.reviewersSyncError = reviewerState.labelsSyncError ?? 'GitLab label sync failed';
      console.warn(
        `[merge-request] Failed to sync reviewer labels for MR ${doc.projectId}/${doc.iid}: ${doc.reviewersSyncError}`,
      );
    }
  }

  await upsertMergeRequest(doc);

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
    const authorRecipient = doc.author.gitlabUsername
      ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
      : undefined;
    const recipients = [
      ...(await getLeadRecipients()),
      ...(authorRecipient ? [authorRecipient] : []),
    ];
    const notificationId = attrs.created_at ?? attrs.updated_at;
    await deliverHtmlMessageToRecipients(bot, recipients, message, {
      eventType: 'mr_created',
      projectId: doc.projectId,
      mrIid: doc.iid,
      ...(notificationId ? { dedupeId: String(notificationId) } : {}),
    });
  }

  // GitLab uses approval/unapproval for individual actions and can additionally
  // report approved/unapproved when the MR-wide approval state changes.
  const isApprovalAction =
    attrs.action === 'approval' || attrs.action === 'approved';
  const isUnapprovalAction =
    attrs.action === 'unapproval' || attrs.action === 'unapproved';
  const isSystemApprovalReset = isUnapprovalAction && attrs.system === true;
  let nextApprovers: string[] | undefined;
  const actorUsername = payload.user?.username;
  if (isApprovalAction || isUnapprovalAction) {
    if (!apiApprovals && actorUsername && !isSystemApprovalReset) {
      const currentApprovers = existingDoc?.approvedBy ?? [];
      nextApprovers =
        isApprovalAction
          ? Array.from(new Set([...currentApprovers, actorUsername]))
          : currentApprovers.filter((username) => username !== actorUsername);
      await updateMergeRequest(doc.projectId, doc.iid, { approvedBy: nextApprovers });
    }
    const scoreApprovers = doc.approvedBy ?? nextApprovers ?? existingDoc?.approvedBy;
    const scoreMr: MergeRequestDocument = {
      ...existingDoc,
      ...doc,
      ...(scoreApprovers ? { approvedBy: scoreApprovers } : {}),
    };
    await runGameAction(`approval ${doc.projectId}/${doc.iid}`, async () => {
      if (isApprovalAction && actorUsername) {
        await recordReviewApprovalScore({
          mr: scoreMr,
          username: actorUsername,
          occurredAt: actionedAt ?? new Date(),
        });
        return;
      }
      if (isUnapprovalAction && actorUsername && !isSystemApprovalReset) {
        await recordReviewUnapprovalScore({
          mr: scoreMr,
          username: actorUsername,
          occurredAt: actionedAt ?? new Date(),
        });
        return;
      }
      if (isSystemApprovalReset && apiApprovals) {
        const currentApprovers = new Set(
          (doc.approvedBy ?? []).map((username) => username.toLowerCase()),
        );
        const removedApprovers = (existingDoc?.approvedBy ?? []).filter(
          (username) => !currentApprovers.has(username.toLowerCase()),
        );
        for (const username of removedApprovers) {
          await recordReviewUnapprovalScore({
            mr: scoreMr,
            username,
            occurredAt: actionedAt ?? new Date(),
          });
        }
      }
    });
  }

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
    const authorRecipient = doc.author.gitlabUsername
      ? await getRecipientByGitlabUsername(doc.author.gitlabUsername)
      : undefined;
    const recipients = [
      ...(await getLeadRecipients()),
      ...(authorRecipient ? [authorRecipient] : []),
    ];
    const notificationId = `${attrs.action}:${attrs.updated_at ?? ''}`;
    await deliverHtmlMessageToRecipients(bot, recipients, message, {
      eventType: 'mr_closed',
      projectId: doc.projectId,
      mrIid: doc.iid,
      dedupeId: notificationId,
    });
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
    const recipients = filterRecipientsWithoutApproval(
      await getLeadRecipients(),
      uniqueApprovers,
    );
    await deliverHtmlMessageToRecipients(bot, recipients, message, {
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
