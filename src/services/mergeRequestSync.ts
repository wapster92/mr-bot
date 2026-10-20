import { config } from '../config';
import {
  findMergeRequest,
  listOpenMergeRequests,
  listProjectIds,
  updateMergeRequest,
  upsertMergeRequest,
  type MergeRequestDocument,
} from '../data/mergeRequestRepository';
import { fetchMergeRequest, fetchMergeRequestApprovals, fetchProjectMergeRequests } from '../gitlab/api';
import { persistGitlabUserProfiles } from '../gitlab/handlers/common';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { notifyMergeRequestApprovals } from './approvalNotifications';
import { markReviewCompletedForApprovers, syncReviewRemindersForMr } from './reviewReminderService';
import { reconcileReviewersForMr } from './reviewerAssignment';
import { withMergeRequestLock } from './mergeRequestLock';
import { runGameAction } from './gameScoring';
import { syncMergeRequestGameReadiness } from './mergeReadiness';

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const BACKFILL_INTERVAL_MS = 60 * 60 * 1000;
let lastBackfillAt = 0;
let syncRunning = false;
let syncRequested = false;
let syncTimer: NodeJS.Timeout | undefined;
let syncBot: Telegraf<BotContext> | undefined;

const isApiConfigured = (): boolean =>
  Boolean(config.gitlab.api?.baseUrl && config.gitlab.api?.token);

const parseDate = (value?: string): Date | undefined => {
  if (!value) return undefined;
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

export const syncMergeRequestFromGitlab = async (
  bot: Telegraf<BotContext>,
  projectId: number,
  iid: number,
): Promise<void> => {
  // Fetch inside the same lock as webhook handlers: an older periodic snapshot
  // must not restore labels or approvals after a newer webhook has completed.
  await withMergeRequestLock(projectId, iid, async () => {
    const stored = await findMergeRequest(projectId, iid);
    if (!stored || (['closed', 'merged'].includes(stored.state ?? '') && !stored.reviewerLabelsCleanupPending)) return;
    const [apiMr, approvals] = await Promise.all([
      fetchMergeRequest(projectId, iid),
      fetchMergeRequestApprovals(projectId, iid),
    ]);
    if (!apiMr && !approvals) return;
    const mr: MergeRequestDocument = { ...stored };
    if (apiMr) {
      if (apiMr.title !== undefined) mr.title = apiMr.title;
      if (apiMr.description !== undefined) mr.description = apiMr.description;
      if (apiMr.state !== undefined) mr.state = apiMr.state;
      if (apiMr.source_branch !== undefined) mr.sourceBranch = apiMr.source_branch;
      if (apiMr.target_branch !== undefined) mr.targetBranch = apiMr.target_branch;
      if (apiMr.web_url !== undefined) mr.url = apiMr.web_url;
      if (apiMr.merge_status !== undefined) mr.mergeStatus = apiMr.merge_status;
      if (apiMr.detailed_merge_status !== undefined) mr.detailedMergeStatus = apiMr.detailed_merge_status;
      mr.isDraft = Boolean(apiMr.work_in_progress || apiMr.draft || isDraftTitle(apiMr.title ?? mr.title));
      const createdAt = parseDate(apiMr.created_at);
      const updatedAt = parseDate(apiMr.updated_at);
      if (createdAt) mr.createdAt = createdAt;
      if (updatedAt) mr.updatedAt = updatedAt;
      mr.author = { ...stored.author };
      if (apiMr.author?.username) mr.author.gitlabUsername = apiMr.author.username;
      if (apiMr.author?.name) mr.author.name = apiMr.author.name;
    }
    if (approvals) {
      mr.approvedBy = (approvals.approved_by ?? [])
        .map((item) => item.user?.username)
        .filter((username): username is string => Boolean(username));
      if (approvals.approvals_required !== undefined) mr.approvalsRequired = approvals.approvals_required;
      if (approvals.approvals_left !== undefined) mr.approvalsLeft = approvals.approvals_left;
    }
    await persistGitlabUserProfiles([
      ...(apiMr?.author ? [apiMr.author] : []),
      ...(approvals?.approved_by ?? []).flatMap((item) => item.user ? [item.user] : []),
    ]);
    const now = new Date();
    const state = await reconcileReviewersForMr(mr, apiMr?.labels, now);
    mr.reviewers = state.reviewers;
    mr.reviewerLabels = state.reviewerLabels;
    mr.approvalRequestedAt = state.approvalRequestedAt;
    mr.reviewerLabelsCleanupPending = ['closed', 'merged'].includes(mr.state ?? '') && !state.labelsSyncOk;
    if (state.labelsSyncOk) {
      mr.reviewersSyncedAt = now;
    } else {
      mr.reviewersSyncFailedAt = now;
      mr.reviewersSyncError = state.labelsSyncError ?? 'GitLab label sync failed';
      console.warn(`[sync] Labels deferred for MR ${projectId}/${iid}: ${mr.reviewersSyncError}`);
    }
    await updateMergeRequest(projectId, iid, mr);
    await syncReviewRemindersForMr(
      { projectId, iid }, state.reviewers, now,
      mr.isDraft || ['closed', 'merged'].includes(mr.state ?? '') || state.approvalsComplete,
      Boolean(stored.isDraft && !mr.isDraft),
    );
    await markReviewCompletedForApprovers({ projectId, iid }, state.reviewers, mr.approvedBy ?? []);
    await notifyMergeRequestApprovals(bot, mr);
    await runGameAction(`periodic readiness ${projectId}/${iid}`, async () => {
      await syncMergeRequestGameReadiness(projectId, iid, now);
    });
  });
};

export const syncOpenMergeRequests = async (): Promise<void> => {
  if (!isApiConfigured() || !syncBot) return;
  if (syncRunning) {
    syncRequested = true;
    return;
  }
  syncRunning = true;
  try {
    if (Date.now() - lastBackfillAt >= BACKFILL_INTERVAL_MS) {
      await backfillMissingMergeRequests();
      lastBackfillAt = Date.now();
    }
    const mergeRequests = await listOpenMergeRequests();
    for (const mr of mergeRequests) {
      await syncMergeRequestFromGitlab(syncBot, mr.projectId, mr.iid).catch((error) => {
        console.warn(`[sync] Failed MR ${mr.projectId}/${mr.iid}`, error);
      });
    }
  } catch (error) {
    console.warn('[sync] Failed to sync open merge requests', error);
  } finally {
    syncRunning = false;
    if (syncRequested) {
      syncRequested = false;
      void syncOpenMergeRequests();
    }
  }
};

export const startMergeRequestSync = (bot: Telegraf<BotContext>): void => {
  if (syncTimer) return;
  syncBot = bot;
  void syncOpenMergeRequests();
  syncTimer = setInterval(() => { void syncOpenMergeRequests(); }, SYNC_INTERVAL_MS);
};
