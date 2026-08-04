import { config } from '../config';
import {
  findMergeRequest,
  listOpenMergeRequests,
  updateMergeRequest,
  upsertMergeRequest,
  listProjectIds,
} from '../data/mergeRequestRepository';
import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import {
  fetchMergeRequest,
  fetchMergeRequestApprovals,
  fetchProjectMergeRequests,
} from '../gitlab/api';
import { persistGitlabUserProfiles } from '../gitlab/handlers/common';
import { deliverHtmlMessageToRecipients, deliverHtmlMessage } from '../messages/send';
import { buildFinalReviewMessage, buildMergeReadyForAuthorMessage } from '../messages/templates';
import {
  getLeadRecipients,
  getRecipientByGitlabUsername,
} from '../messages/recipients';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { listLeadUsers } from '../data/userStore';
import { markReviewCompletedForApprovers, syncReviewRemindersForMr } from './reviewReminderService';
import { reconcileReviewersForMr } from './reviewerAssignment';
import { withMergeRequestLock } from './mergeRequestLock';
import { runGameAction } from './gameScoring';
import { syncMergeRequestGameReadiness } from './mergeReadiness';
import {
  hasRequiredMergeApprovals,
  needsLeadReview,
  summarizeApprovals,
} from './approvalPolicy';

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

const isDraftTitle = (title?: string): boolean =>
  /^draft[: ]/i.test((title ?? '').trim());

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
          isDraft: Boolean(mr.work_in_progress || mr.draft || isDraftTitle(mr.title ?? '')),
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
  const approvers = current.approvedBy ?? [];
  const uniqueApprovers = Array.from(new Set(approvers));
  const leads = await listLeadUsers();
  const leadUsernames = leads
    .map((lead) => lead.gitlabUsername)
    .filter(Boolean)
    .map((name) => name.toLowerCase());
  const approvalSummary = summarizeApprovals(
    uniqueApprovers,
    new Set(leadUsernames),
  );

  if (needsLeadReview(approvalSummary) && !existing.finalReviewNotified) {
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

  if (
    !existing.authorMergeNotified &&
    hasRequiredMergeApprovals(approvalSummary)
  ) {
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
          ...(apiApprovals?.approved_by ?? []).map((item) => item.user ?? {}),
        ];
        await persistGitlabUserProfiles(
          apiUsers.filter(Boolean) as Array<{ username?: string; name?: string; id?: number }>,
        );
      }

      const update: Record<string, unknown> = {};

      if (apiMergeRequest) {
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
        if (
          apiMergeRequest.work_in_progress !== undefined ||
          apiMergeRequest.draft !== undefined ||
          typeof apiMergeRequest.title === 'string'
        ) {
          const draftFlag = Boolean(
            apiMergeRequest.work_in_progress ||
              apiMergeRequest.draft ||
              isDraftTitle(apiMergeRequest.title),
          );
          update.isDraft = draftFlag;
        }
        const createdAt = parseDate(apiMergeRequest.created_at);
        if (createdAt) {
          update.createdAt = createdAt;
        }
        const updatedAt = parseDate(apiMergeRequest.updated_at);
        if (updatedAt) {
          update.updatedAt = updatedAt;
        }
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

      const previousDraft = mr.isDraft ?? isDraftTitle(mr.title);
      const apiIsDraft = (update.isDraft as boolean | undefined) ?? previousDraft;
      const reviewerSync = await withMergeRequestLock(
        mr.projectId,
        mr.iid,
        async () => {
          const latestApiMergeRequest = await fetchMergeRequest(mr.projectId, mr.iid);
          const effectiveIsDraft = latestApiMergeRequest
            ? Boolean(
                latestApiMergeRequest.work_in_progress ||
                  latestApiMergeRequest.draft ||
                  isDraftTitle(latestApiMergeRequest.title),
              )
            : apiIsDraft;
          const storedMr = (await findMergeRequest(mr.projectId, mr.iid)) ?? mr;
          const state = await reconcileReviewersForMr(
            {
              ...storedMr,
              ...(update.author
                ? { author: update.author as MergeRequestDocument['author'] }
                : {}),
              isDraft: effectiveIsDraft,
            },
            latestApiMergeRequest?.labels,
          );
          const reviewerUpdate: Partial<MergeRequestDocument> = {
            isDraft: effectiveIsDraft,
            reviewers: state.reviewers,
            reviewerLabels: state.reviewerLabels,
          };
          if (state.labelsSyncOk) {
            reviewerUpdate.reviewersSyncedAt = new Date();
          } else {
            reviewerUpdate.reviewersSyncFailedAt = new Date();
            reviewerUpdate.reviewersSyncError =
              state.labelsSyncError ?? 'GitLab label sync failed';
            console.warn(
              `[sync] Failed to sync reviewer labels for MR ${mr.projectId}/${mr.iid}: ${reviewerUpdate.reviewersSyncError}`,
            );
          }
          await updateMergeRequest(mr.projectId, mr.iid, reviewerUpdate);
          return { state, isDraft: effectiveIsDraft };
        },
      );
      const reviewerState = reviewerSync.state;
      const isDraft = reviewerSync.isDraft;
      if (previousDraft && !isDraft) {
        console.info(`[sync] Draft ended for MR ${mr.projectId}/${mr.iid}`);
      }
      const currentReviewers = reviewerState.reviewers;

      await syncReviewRemindersForMr(
        { projectId: mr.projectId, iid: mr.iid },
        currentReviewers,
        new Date(),
        isDraft,
        previousDraft && !isDraft,
      );

      const approvers =
        (update.approvedBy as string[] | undefined) ?? mr.approvedBy ?? [];
      if (currentReviewers.length && approvers.length) {
        await markReviewCompletedForApprovers(
          { projectId: mr.projectId, iid: mr.iid },
          currentReviewers,
          approvers,
        );
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
      await runGameAction(`periodic readiness ${mr.projectId}/${mr.iid}`, async () => {
        await syncMergeRequestGameReadiness(mr.projectId, mr.iid, new Date());
      });
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
