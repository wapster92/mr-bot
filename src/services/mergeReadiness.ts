import {
  clearMergeRequestGameReady,
  findMergeRequest,
  startMergeRequestGameReady,
} from '../data/mergeRequestRepository';
import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { listActiveReviewers, listLeadUsers } from '../data/userStore';

const BLOCKING_MERGE_STATUSES = new Set(['cannot_be_merged']);
const BLOCKING_DETAILED_STATUSES = new Set([
  'blocked_status',
  'ci_must_pass',
  'ci_still_running',
  'conflict',
  'discussions_not_resolved',
  'draft_status',
  'need_rebase',
  'not_approved',
  'not_open',
  'requested_changes',
]);

export const isMergeRequestGameReady = (
  mr: MergeRequestDocument,
  leadUsernames: Set<string>,
  activeUsernames: Set<string>,
): boolean => {
  if (mr.isDraft || ['merged', 'closed'].includes(mr.state ?? '')) {
    return false;
  }
  if (mr.lastLintStatus !== 'success') {
    return false;
  }
  if (mr.mergeStatus && BLOCKING_MERGE_STATUSES.has(mr.mergeStatus)) {
    return false;
  }
  if (
    mr.detailedMergeStatus &&
    BLOCKING_DETAILED_STATUSES.has(mr.detailedMergeStatus)
  ) {
    return false;
  }

  const approvers = Array.from(
    new Set((mr.approvedBy ?? []).map((username) => username.toLowerCase())),
  ).filter((username) => activeUsernames.has(username));
  const leadApprovals = approvers.filter((username) => leadUsernames.has(username));
  const reviewerApprovals = approvers.filter((username) => !leadUsernames.has(username));
  return leadApprovals.length >= 1 && reviewerApprovals.length >= 2;
};

export const syncMergeRequestGameReadiness = async (
  projectId: number,
  iid: number,
  changedAt = new Date(),
): Promise<{ ready: boolean; started: boolean }> => {
  const mr = await findMergeRequest(projectId, iid);
  if (!mr) {
    return { ready: false, started: false };
  }
  const [leads, activeReviewers] = await Promise.all([
    listLeadUsers(),
    listActiveReviewers(),
  ]);
  const leadUsernames = new Set(
    leads
      .map((lead) => lead.gitlabUsername?.toLowerCase())
      .filter((username): username is string => Boolean(username)),
  );
  const activeUsernames = new Set([
    ...activeReviewers.map((username) => username.toLowerCase()),
    ...leadUsernames,
  ]);
  const ready = isMergeRequestGameReady(mr, leadUsernames, activeUsernames);
  if (!ready) {
    await clearMergeRequestGameReady(projectId, iid);
    return { ready: false, started: false };
  }
  const started = await startMergeRequestGameReady(projectId, iid, changedAt);
  return { ready: true, started };
};
