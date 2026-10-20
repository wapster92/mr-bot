import type { MergeRequestDocument } from '../data/mergeRequestRepository';

export type ApprovalSummary = {
  leadApprovers: string[];
  developerApprovers: string[];
  pendingLeadUsernames: string[];
  requiredLeadCount: number;
  requiredCommenterUsernames: string[];
  pendingCommenterUsernames: string[];
  commentHistoryReady: boolean;
};

export const summarizeApprovals = (
  approvedBy: string[],
  leadUsernames: Set<string>,
  reviewerUsernames?: Set<string>,
  authorUsername?: string,
): ApprovalSummary => {
  const normalizedLeads = new Set(
    [...leadUsernames].map((username) => username.toLowerCase()),
  );
  const normalizedReviewers = reviewerUsernames
    ? new Set(
        [...reviewerUsernames].map((username) => username.toLowerCase()),
      )
    : undefined;
  const uniqueApprovers = Array.from(
    new Set(approvedBy.map((username) => username.toLowerCase())),
  );
  const author = authorUsername?.toLowerCase();
  const requiredLeads = [...normalizedLeads].filter((username) => username !== author);
  return {
    requiredCommenterUsernames: [],
    pendingCommenterUsernames: [],
    commentHistoryReady: true,
    leadApprovers: uniqueApprovers.filter(
      (username) => normalizedLeads.has(username) && username !== author,
    ),
    developerApprovers: uniqueApprovers.filter(
      (username) =>
        username !== author && !normalizedLeads.has(username) &&
        (!normalizedReviewers || normalizedReviewers.has(username)),
    ),
    pendingLeadUsernames: requiredLeads.filter((username) => !uniqueApprovers.includes(username)),
    requiredLeadCount: Math.max(
      author && normalizedLeads.has(author) ? 1 : 2,
      requiredLeads.length,
    ),
  };
};

export const needsLeadReview = (summary: ApprovalSummary): boolean =>
  summary.developerApprovers.length >= 1 && summary.pendingLeadUsernames.length > 0;

export const hasRequiredMergeApprovals = (summary: ApprovalSummary): boolean =>
  summary.developerApprovers.length >= 1 &&
  summary.pendingLeadUsernames.length === 0 &&
  summary.pendingCommenterUsernames.length === 0 && summary.commentHistoryReady &&
  summary.leadApprovers.length >= summary.requiredLeadCount;

export const summarizeMergeRequestApprovals = (
  mr: Pick<MergeRequestDocument, 'approvedBy' | 'reviewers' | 'author' | 'reviewCommenters' | 'reviewCommentHistorySyncPending'>,
  leadUsernames: Set<string>,
  activeReviewers: Set<string>,
  activeCommenters: Set<string> = new Set([...activeReviewers, ...leadUsernames]),
): ApprovalSummary => {
  const normalizedReviewers = new Set([...activeReviewers].map((name) => name.toLowerCase()));
  const assignedReviewers = new Set(
    (mr.reviewers ?? [])
      .map((name) => name.toLowerCase())
      .filter((name) => normalizedReviewers.has(name)),
  );
  const summary = summarizeApprovals(
    mr.approvedBy ?? [],
    leadUsernames,
    assignedReviewers,
    mr.author.gitlabUsername,
  );
  const available = new Set([...activeCommenters].map((name) => name.toLowerCase()));
  const author = mr.author.gitlabUsername?.toLowerCase();
  const approved = new Set((mr.approvedBy ?? []).map((name) => name.toLowerCase()));
  const requiredCommenterUsernames = [...new Set((mr.reviewCommenters ?? [])
    .map((name) => name.toLowerCase()))].filter((name) => name !== author && available.has(name));
  return {
    ...summary, requiredCommenterUsernames,
    pendingCommenterUsernames: requiredCommenterUsernames.filter((name) => !approved.has(name)),
    commentHistoryReady: mr.reviewCommentHistorySyncPending !== true,
  };
};
