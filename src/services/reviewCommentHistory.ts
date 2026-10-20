import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { fetchMergeRequestNotes } from '../gitlab/api';

const HISTORY_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_RETRY_INTERVAL_MS = 2 * 60 * 1000;

// Caller must hold the MR lock. The separate version marker backfills old
// volunteers; periodic refresh also recovers comments whose webhook was missed.
export const loadReviewCommentHistory = async (
  mr: MergeRequestDocument,
  options: { mergeAudit?: boolean } = {},
): Promise<Partial<MergeRequestDocument>> => {
  if (!options.mergeAudit && ['closed', 'merged'].includes(mr.state ?? '')) return {};
  const now = new Date();
  if (!options.mergeAudit && mr.reviewCommentHistorySyncPending && mr.reviewCommentHistoryLastAttemptAt &&
    now.getTime() - mr.reviewCommentHistoryLastAttemptAt.getTime() < HISTORY_RETRY_INTERVAL_MS) return {};
  if (!options.mergeAudit && mr.reviewCommentRequirementsSyncedAt && !mr.reviewCommentHistorySyncPending &&
    now.getTime() - mr.reviewCommentRequirementsSyncedAt.getTime() < HISTORY_SYNC_INTERVAL_MS) return {};
  const notes = await fetchMergeRequestNotes(mr.projectId, mr.iid);
  if (!notes) return { reviewCommentHistorySyncPending: true, reviewCommentHistoryLastAttemptAt: now };
  return {
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
