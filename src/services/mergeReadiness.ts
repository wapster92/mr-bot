import {
  clearMergeRequestGameReady,
  findMergeRequest,
  startMergeRequestGameReady,
  updateMergeRequest,
} from '../data/mergeRequestRepository';
import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { listActiveReviewers, listActiveUsernames, listLeadUsers } from '../data/userStore';
import { hasRequiredMergeApprovals, summarizeMergeRequestApprovals } from './approvalPolicy';
import { loadReviewCommentHistory } from './reviewCommentHistory';

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
  activeCommenters: Set<string> = activeUsernames,
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

  const activeLeads = new Set([...leadUsernames].filter((name) => activeUsernames.has(name)));
  return hasRequiredMergeApprovals(
    summarizeMergeRequestApprovals(mr, activeLeads, activeUsernames, activeCommenters),
  );
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
  const history = await loadReviewCommentHistory(mr);
  if (Object.keys(history).length) {
    Object.assign(mr, history);
    await updateMergeRequest(projectId, iid, history);
  }
  const [leads, activeReviewers, users] = await Promise.all([
    listLeadUsers(),
    listActiveReviewers(),
    listActiveUsernames(),
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
  const ready = isMergeRequestGameReady(mr, leadUsernames, activeUsernames,
    new Set(users.map((name) => name.toLowerCase())));
  if (!ready) {
    await clearMergeRequestGameReady(projectId, iid);
    return { ready: false, started: false };
  }
  const started = await startMergeRequestGameReady(projectId, iid, changedAt);
  return { ready: true, started };
};
