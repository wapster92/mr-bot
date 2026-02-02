import { config } from '../config';
import {
  listOpenMergeRequests,
  updateMergeRequest,
  upsertMergeRequest,
  listProjectIds,
} from '../data/mergeRequestRepository';
import {
  fetchMergeRequest,
  fetchMergeRequestApprovals,
  fetchUserByUsername,
  fetchProjectMergeRequests,
} from '../gitlab/api';
import { persistGitlabUserProfiles } from '../gitlab/handlers/common';
import { deliverHtmlMessageToRecipients, deliverHtmlMessage } from '../messages/send';
import { buildFinalReviewMessage, buildMergeReadyForAuthorMessage } from '../messages/templates';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../messages/recipients';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { getGitlabUserIdByUsername, upsertGitlabUserProfile } from '../data/userStore';
import { pullReviewers } from '../data/reviewerQueue';

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
  return { ok: true };
};

const backfillMissingMergeRequests = async (): Promise<void> => {
  const allowedProjectIds =
    config.gitlab.api.allowedProjectIds && config.gitlab.api.allowedProjectIds.length
      ? config.gitlab.api.allowedProjectIds
      : await listProjectIds();
  if (!allowedProjectIds.length) {
    return;
  }

  const existing = await listOpenMergeRequests();
  const existingKeys = new Set(existing.map((mr) => `${mr.projectId}:${mr.iid}`));

  for (const projectId of allowedProjectIds) {
    const mrs = await fetchProjectMergeRequests(projectId, 'opened');
    if (!mrs?.length) {
      continue;
    }
    for (const mr of mrs) {
      if (typeof mr.iid !== 'number' || typeof mr.project_id !== 'number') {
        continue;
      }
      const key = `${mr.project_id}:${mr.iid}`;
      if (existingKeys.has(key)) {
        continue;
      }
      const author = mr.author?.username
        ? { gitlabUsername: mr.author.username, name: mr.author.name }
        : {};
      const doc = {
        projectId: mr.project_id,
        projectPath: mr.project_path ?? '',
        mrId: mr.id ?? 0,
        iid: mr.iid,
        title: mr.title ?? '—',
        description: mr.description ?? '',
        sourceBranch: mr.source_branch ?? '',
        targetBranch: mr.target_branch ?? '',
        url: mr.web_url ?? '',
        author,
        state: mr.state,
        mergeStatus: mr.merge_status,
        detailedMergeStatus: mr.detailed_merge_status,
        createdAt: parseDate(mr.created_at) ?? new Date(),
        updatedAt: parseDate(mr.updated_at) ?? new Date(),
      };
      await upsertMergeRequest(doc as any);
    }
  }
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
    typeof approvalsRequiredRaw === 'number' && approvalsRequiredRaw >= 0
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
      ? (approvalsLeft <= 0 || approversCount >= approvalsRequired) && approversCount > 0
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
    await backfillMissingMergeRequests();
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
        const reviewersToStore = mr.reviewers ?? apiReviewerUsernames;

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
        update.approvedBy = Array.isArray(apiApprovals.approved_by)
          ? apiApprovals.approved_by
              .map((item) => item.user?.username)
              .filter((username): username is string => Boolean(username))
          : [];
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
      if (
        typeof update.approvalsRequired === 'number' &&
        typeof update.approvalsLeft === 'number' &&
        update.approvalsRequired > 0 &&
        update.approvalsLeft === 0
      ) {
        const approversCount = Array.isArray(update.approvedBy)
          ? update.approvedBy.length
          : 0;
        if (approversCount < update.approvalsRequired) {
          update.approvalsLeft = Math.max(update.approvalsRequired - approversCount, 0);
        }
      }

      if (Object.keys(update).length) {
        await updateMergeRequest(mr.projectId, mr.iid, update);
      }

      // Назначаем ревьюеров, если их нет или только один (используем очередь разработчиков).
      const currentReviewers =
        (update.reviewers as string[] | undefined) ?? mr.reviewers ?? [];
      const neededDev = Math.max(0, 2 - currentReviewers.length);
      if (neededDev > 0) {
        const exclude = [
          ...currentReviewers,
          mr.author?.gitlabUsername ?? '',
        ]
          .filter(Boolean)
          .map((r) => r.toLowerCase());
        const picked = await pullReviewers(exclude);
        const addDevs = picked.slice(0, neededDev);

        const assignedSet = new Set<string>(currentReviewers);
        for (const dev of addDevs) {
          assignedSet.add(dev);
        }
        const assigned = Array.from(assignedSet);
        if (assigned.length) {
          const updateReviewers: Record<string, unknown> = {
            reviewers: assigned,
            reviewersSyncedAt: new Date(),
          };
          updateReviewers.reviewersSyncFailedAt = undefined;
          updateReviewers.reviewersSyncError = undefined;
          await updateMergeRequest(mr.projectId, mr.iid, updateReviewers);
        }
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
