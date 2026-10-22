import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { fetchMergeRequestLatestDiff, fetchMergeRequestNotes } from '../gitlab/api';
import { recordReviewCodeUpdate, recordReviewCommentActivity } from './reviewResponsibility';

const HISTORY_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_RETRY_INTERVAL_MS = 2 * 60 * 1000;

// Caller must hold the MR lock. The separate version marker backfills old
// volunteers; periodic refresh also recovers comments whose webhook was missed.
export const loadReviewCommentHistory = async (
  mr: MergeRequestDocument,
  options: { mergeAudit?: boolean; headSha?: string | undefined } = {},
): Promise<Partial<MergeRequestDocument>> => {
  if (!options.mergeAudit && ['closed', 'merged'].includes(mr.state ?? '')) return {};
  const now = new Date();
  const pending = mr.reviewCommentHistorySyncPending || mr.reviewActivitySyncPending;
  if (!options.mergeAudit && pending && mr.reviewCommentHistoryLastAttemptAt &&
    now.getTime() - mr.reviewCommentHistoryLastAttemptAt.getTime() < HISTORY_RETRY_INTERVAL_MS) return {};
  const newHead = options.headSha && options.headSha !== mr.reviewCodeHeadSha;
  if (!options.mergeAudit && !newHead && mr.reviewActivitySyncedAt && mr.reviewCommentRequirementsSyncedAt && !pending &&
    now.getTime() - mr.reviewCommentRequirementsSyncedAt.getTime() < HISTORY_SYNC_INTERVAL_MS) return {};
  const [notes, diff] = await Promise.all([
    fetchMergeRequestNotes(mr.projectId, mr.iid),
    options.mergeAudit ? undefined : fetchMergeRequestLatestDiff(mr.projectId, mr.iid),
  ]);
  const activity: Partial<MergeRequestDocument> = {};
  if (diff?.createdAt) {
    Object.assign(activity, recordReviewCodeUpdate(mr, diff.headSha, new Date(diff.createdAt)));
  }
  for (const note of notes ?? []) {
    if (note.system || !note.authorUsername || !note.createdAt) continue;
    const date = new Date(note.createdAt);
    if (!Number.isFinite(date.getTime())) continue;
    Object.assign(activity, recordReviewCommentActivity({ ...mr, ...activity }, note.authorUsername, date));
  }
  if (!options.mergeAudit) {
    const complete = Boolean(notes && diff && (!options.headSha || diff.headSha === options.headSha));
    activity.reviewActivitySyncPending = !complete;
    if (complete) activity.reviewActivitySyncedAt = now;
  }
  if (!notes) return { ...activity, reviewCommentHistorySyncPending: true, reviewCommentHistoryLastAttemptAt: now };
  return {
    ...activity,
    reviewCommenters: [...new Set([
      ...(mr.reviewCommenters ?? []),
      ...notes.filter((note) => !note.system && note.authorUsername).map((note) => note.authorUsername!),
    ].map((name) => name.toLowerCase()))],
    reviewCommentsSyncedAt: now,
    reviewCommentRequirementsSyncedAt: now,
    reviewCommentHistorySyncPending: false,
    reviewCommentHistoryLastAttemptAt: now,
  };
};
