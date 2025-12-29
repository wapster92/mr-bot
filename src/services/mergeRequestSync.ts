import { config } from '../config';
import { listOpenMergeRequests, updateMergeRequest } from '../data/mergeRequestRepository';
import {
  fetchMergeRequest,
  fetchMergeRequestApprovals,
  fetchUserByUsername,
  setMergeRequestReviewers,
} from '../gitlab/api';
import { persistGitlabUserProfiles } from '../gitlab/handlers/common';
import { deliverHtmlMessageToRecipients, deliverHtmlMessage } from '../messages/send';
import { buildFinalReviewMessage, buildMergeReadyForAuthorMessage } from '../messages/templates';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../messages/recipients';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { getGitlabUserIdByUsername, listLeadUsers, upsertGitlabUserProfile } from '../data/userStore';

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
let syncRunning = false;
let syncTimer: NodeJS.Timeout | undefined;
let syncBot: Telegraf<BotContext> | undefined;

const isApiConfigured = (): boolean =>
  Boolean(config.gitlab.api?.baseUrl && config.gitlab.api?.token);

const parseDate = (value?: string): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const resolveReviewerIds = async (usernames: string[]): Promise<number[] | null> => {
  const reviewerIds: number[] = [];
  const missing: string[] = [];

  for (const username of usernames) {
    const storedId = await getGitlabUserIdByUsername(username);
    if (storedId) {
      reviewerIds.push(storedId);
      continue;
    }
    const apiUser = await fetchUserByUsername(username);
    if (apiUser?.id) {
      reviewerIds.push(apiUser.id);
      if (apiUser.username) {
        await upsertGitlabUserProfile(apiUser.username, apiUser.name, apiUser.id);
      }
      continue;
    }
    missing.push(username);
  }

  if (missing.length) {
    console.warn('[sync] Cannot resolve GitLab IDs for reviewers', missing.join(', '));
    return null;
  }

  return reviewerIds;
};

const syncReviewersToGitlab = async (
  projectId: number,
  iid: number,
  reviewerUsernames: string[],
): Promise<{ ok: boolean; error?: string }> => {
  if (!reviewerUsernames.length) {
    return { ok: false, error: 'empty reviewer list' };
  }
  const reviewerIds = await resolveReviewerIds(reviewerUsernames);
  if (!reviewerIds || !reviewerIds.length) {
    return { ok: false, error: 'cannot resolve reviewer ids' };
  }
  const assigned = await setMergeRequestReviewers(projectId, iid, reviewerIds);
  if (!assigned) {
    const error = 'gitlab api returned false';
    console.warn('[sync] Failed to assign reviewers via GitLab API', projectId, iid);
    return { ok: false, error };
  }
  return { ok: true };
};

const maybeNotifyApprovals = async (
  bot: Telegraf<BotContext>,
  mr: {
    projectId: number;
    iid: number;
    title?: string;
    url?: string;
    taskUrl?: string | undefined;
    author?: { gitlabUsername?: string };
  },
  current: {
    approvalsLeft?: number | undefined;
    approvalsRequired?: number | undefined;
    approvedBy?: string[] | undefined;
  },
  existing: {
    finalReviewNotified?: boolean | undefined;
    authorMergeNotified?: boolean | undefined;
  },
): Promise<void> => {
  const approvalsRequiredRaw = current.approvalsRequired;
  const approvalsRequired =
    typeof approvalsRequiredRaw === 'number' && approvalsRequiredRaw > 0
      ? approvalsRequiredRaw
      : config.approvals.defaultRequired;
  const approvalsLeftRaw = current.approvalsLeft;
  const approvalsLeft =
    typeof approvalsLeftRaw === 'number' && approvalsLeftRaw >= 0
      ? approvalsLeftRaw
      : approvalsRequired;
  const approvers = current.approvedBy ?? [];
  const uniqueApprovers = Array.from(new Set(approvers));
  const approversCount = uniqueApprovers.length;
  const approvalTriggered =
    approvalsRequired > 0
      ? approvalsLeft <= 0 || approversCount >= approvalsRequired
      : false;

  if (approvalTriggered && !existing.finalReviewNotified) {
    const message = buildFinalReviewMessage({
      title: mr.title ?? '—',
      url: mr.url ?? '—',
      taskUrl: mr.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
      eventType: 'mr_final_review',
      projectId: mr.projectId,
      mrIid: mr.iid,
    });
    await updateMergeRequest(mr.projectId, mr.iid, { finalReviewNotified: true });
  }

  if (!existing.authorMergeNotified && approversCount >= 3) {
    const leads = await listLeadUsers();
    const leadUsernames = leads
      .map((lead) => lead.gitlabUsername)
      .filter(Boolean)
      .map((name) => name.toLowerCase());
    const lowerApprovers = uniqueApprovers.map((name) => name.toLowerCase());
    const leadApprovers = lowerApprovers.filter((name) => leadUsernames.includes(name));
    const nonLeadApprovers = lowerApprovers.filter((name) => !leadUsernames.includes(name));

    if (leadApprovers.length >= 1 && nonLeadApprovers.length >= 2) {
      const message = buildMergeReadyForAuthorMessage({
        title: mr.title ?? '—',
        url: mr.url ?? '—',
        taskUrl: mr.taskUrl,
      });
      const authorRecipient = mr.author?.gitlabUsername
        ? await getRecipientByGitlabUsername(mr.author.gitlabUsername)
        : undefined;
      if (authorRecipient) {
        await deliverHtmlMessage(bot, authorRecipient, message, {
          eventType: 'mr_ready_to_merge',
          projectId: mr.projectId,
          mrIid: mr.iid,
        });
      } else {
        console.warn('[sync] Cannot notify author about merge readiness');
      }
      await updateMergeRequest(mr.projectId, mr.iid, { authorMergeNotified: true });
    }
  }
};

export const syncOpenMergeRequests = async (): Promise<void> => {
  if (!isApiConfigured()) {
    return;
  }
  if (!syncBot) {
    return;
  }
  if (syncRunning) {
    return;
  }
  syncRunning = true;
  try {
    const mergeRequests = await listOpenMergeRequests();
    if (!mergeRequests.length) {
      return;
    }

    for (const mr of mergeRequests) {
      const [apiMergeRequest, apiApprovals] = await Promise.all([
        fetchMergeRequest(mr.projectId, mr.iid),
        fetchMergeRequestApprovals(mr.projectId, mr.iid),
      ]);
      if (!apiMergeRequest && !apiApprovals) {
        continue;
      }

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

      const update: Record<string, unknown> = {};

      if (apiMergeRequest) {
        const apiReviewerUsernames =
          apiMergeRequest.reviewers
            ?.map((reviewer) => reviewer.username)
            .filter((username): username is string => Boolean(username)) ?? [];
        let reviewersToStore = apiReviewerUsernames;

        if (!apiReviewerUsernames.length && mr.reviewers?.length) {
          const syncResult = await syncReviewersToGitlab(
            mr.projectId,
            mr.iid,
            mr.reviewers,
          );
          if (syncResult.ok) {
            reviewersToStore = mr.reviewers;
            update.reviewersSyncedAt = new Date();
            update.reviewersSyncFailedAt = null;
            update.reviewersSyncError = null;
          } else {
            reviewersToStore = mr.reviewers;
            update.reviewersSyncFailedAt = new Date();
            update.reviewersSyncError = syncResult.error ?? 'unknown error';
          }
        }

        if (typeof apiMergeRequest.title === 'string') {
          update.title = apiMergeRequest.title;
        }
        if (typeof apiMergeRequest.description === 'string') {
          update.description = apiMergeRequest.description;
        }
        if (typeof apiMergeRequest.state === 'string') {
          update.state = apiMergeRequest.state;
        }
        if (typeof apiMergeRequest.source_branch === 'string') {
          update.sourceBranch = apiMergeRequest.source_branch;
        }
        if (typeof apiMergeRequest.target_branch === 'string') {
          update.targetBranch = apiMergeRequest.target_branch;
        }
        if (typeof apiMergeRequest.web_url === 'string') {
          update.url = apiMergeRequest.web_url;
        }
        if (typeof apiMergeRequest.merge_status === 'string') {
          update.mergeStatus = apiMergeRequest.merge_status;
        }
        if (typeof apiMergeRequest.detailed_merge_status === 'string') {
          update.detailedMergeStatus = apiMergeRequest.detailed_merge_status;
        }
        const createdAt = parseDate(apiMergeRequest.created_at);
        if (createdAt) {
          update.createdAt = createdAt;
        }
        const updatedAt = parseDate(apiMergeRequest.updated_at);
        if (updatedAt) {
          update.updatedAt = updatedAt;
        }
        update.reviewers = reviewersToStore;
        if (apiMergeRequest.author) {
          const author = { ...(mr.author ?? {}) };
          let authorChanged = false;
          if (!author.gitlabUsername && apiMergeRequest.author.username) {
            author.gitlabUsername = apiMergeRequest.author.username;
            authorChanged = true;
          }
          if (!author.name && apiMergeRequest.author.name) {
            author.name = apiMergeRequest.author.name;
            authorChanged = true;
          }
          if (authorChanged) {
            update.author = author;
          }
        }
      }

      if (apiApprovals) {
        if (typeof apiApprovals.approvals_required === 'number') {
          update.approvalsRequired = apiApprovals.approvals_required;
        }
        if (typeof apiApprovals.approvals_left === 'number') {
          update.approvalsLeft = apiApprovals.approvals_left;
        }
        if (Array.isArray(apiApprovals.approved_by)) {
          update.approvedBy = apiApprovals.approved_by
            .map((item) => item.user?.username)
            .filter((username): username is string => Boolean(username));
        }
      }

      const normalizedApprovalsRequired =
        typeof update.approvalsRequired === 'number'
          ? update.approvalsRequired
          : typeof mr.approvalsRequired === 'number'
          ? mr.approvalsRequired
          : config.approvals.defaultRequired;
      update.approvalsRequired = normalizedApprovalsRequired;
      if (
        update.approvalsLeft === undefined ||
        update.approvalsLeft === null ||
        typeof update.approvalsLeft !== 'number'
      ) {
        if (typeof mr.approvalsLeft === 'number' && mr.approvalsLeft >= 0) {
          update.approvalsLeft = mr.approvalsLeft;
        } else if (typeof normalizedApprovalsRequired === 'number') {
          update.approvalsLeft = normalizedApprovalsRequired;
        } else {
          update.approvalsLeft = config.approvals.defaultRequired;
        }
      }
      if (typeof update.approvalsLeft === 'number' && update.approvalsLeft < 0) {
        update.approvalsLeft = 0;
      }

      if (Object.keys(update).length) {
        await updateMergeRequest(mr.projectId, mr.iid, update);
      }

      await maybeNotifyApprovals(
        syncBot,
        {
          projectId: mr.projectId,
          iid: mr.iid,
          title: (update.title as string | undefined) ?? mr.title,
          url: (update.url as string | undefined) ?? mr.url,
          taskUrl: mr.taskUrl,
          author: (update.author as { gitlabUsername?: string } | undefined) ?? mr.author,
        },
        {
          approvalsLeft:
            typeof update.approvalsLeft === 'number'
              ? (update.approvalsLeft as number)
              : mr.approvalsLeft,
          approvalsRequired:
            typeof update.approvalsRequired === 'number'
              ? (update.approvalsRequired as number)
              : mr.approvalsRequired,
          approvedBy:
            (update.approvedBy as string[] | undefined) ?? mr.approvedBy,
        },
        {
          finalReviewNotified: mr.finalReviewNotified,
          authorMergeNotified: mr.authorMergeNotified,
        },
      );
    }
  } catch (error) {
    console.warn('[sync] Failed to sync open merge requests', error);
  } finally {
    syncRunning = false;
  }
};

export const startMergeRequestSync = (bot: Telegraf<BotContext>): void => {
  if (syncTimer) {
    return;
  }
  syncBot = bot;
  void syncOpenMergeRequests();
  syncTimer = setInterval(() => {
    void syncOpenMergeRequests();
  }, SYNC_INTERVAL_MS);
};
