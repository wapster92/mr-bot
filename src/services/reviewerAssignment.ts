import { pullReviewers } from '../data/reviewerQueue';
import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { getUserByGitlabUsername, listLeadUsers } from '../data/userStore';
import { isReviewerEnabled } from '../data/userTypes';
import {
  buildReviewerLabels,
  syncReviewerLabelsToGitlab,
} from './reviewerLabelSync';
import { buildReviewLabelPlan, MERGE_READY_LABEL } from './reviewLabelPlan';

const REQUIRED_REVIEWERS = 2;

const uniqueUsernames = (usernames: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const username of usernames) {
    const normalized = username.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(username.trim());
  }
  return result;
};

const areSameReviewers = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((reviewer, index) => reviewer.toLowerCase() === right[index]?.toLowerCase());

const filterAvailableReviewers = async (reviewers: string[]): Promise<string[]> => {
  const available: string[] = [];
  for (const reviewer of uniqueUsernames(reviewers)) {
    const user = await getUserByGitlabUsername(reviewer);
    if (user && isReviewerEnabled(user)) {
      available.push(reviewer);
    }
  }
  return available;
};

export type ReviewerReconciliation = {
  reviewers: string[];
  reviewerLabels: string[];
  approvalRequestedAt: Record<string, Date>;
  approvalsComplete: boolean;
  reviewersChanged: boolean;
  labelsSyncOk: boolean;
  labelsSyncError?: string;
};

export const reconcileReviewersForMr = async (
  mr: MergeRequestDocument,
  currentGitlabLabels: string[] | undefined,
  now = new Date(),
): Promise<ReviewerReconciliation> => {
  const previousReviewers = uniqueUsernames(mr.reviewers ?? []);
  const previousReviewerLabels =
    mr.reviewerLabels ?? (await buildReviewerLabels(previousReviewers));

  let reviewers: string[] = ['closed', 'merged'].includes(mr.state ?? '')
    ? previousReviewers
    : [];
  if (!mr.isDraft && !['closed', 'merged'].includes(mr.state ?? '')) {
    reviewers = await filterAvailableReviewers(previousReviewers.filter(
      (username) => username.toLowerCase() !== mr.author.gitlabUsername?.toLowerCase(),
    ));
    const needed = Math.max(0, REQUIRED_REVIEWERS - reviewers.length);
    if (needed > 0) {
      const exclude = [
        ...reviewers,
        mr.author.gitlabUsername ?? '',
      ]
        .filter(Boolean)
        .map((username) => username.toLowerCase());
      const selected = await pullReviewers(exclude);
      reviewers = uniqueUsernames([...reviewers, ...selected.slice(0, needed)]);
    }
  }

  const [leads, reviewerUsers] = await Promise.all([
    listLeadUsers(),
    Promise.all(uniqueUsernames([...reviewers, ...(mr.reviewCommenters ?? [])])
      .map((username) => getUserByGitlabUsername(username))),
  ]);
  const plan = buildReviewLabelPlan(
    { ...mr, reviewers },
    [...leads, ...reviewerUsers.filter((user) => user !== undefined)],
    now,
  );
  const reviewerLabels = plan.labels.map((label) => label.name);
  const labelsSync = await syncReviewerLabelsToGitlab(
    mr.projectId,
    mr.iid,
    currentGitlabLabels,
    previousReviewerLabels,
    reviewerLabels,
    plan.labels,
  );
  const reviewersChanged = !areSameReviewers(previousReviewers, reviewers);
  if (reviewersChanged) {
    console.info(
      `[reviewer-assignment] ${mr.projectId}/${mr.iid} previous=${previousReviewers.join(',')} next=${reviewers.join(',')} draft=${Boolean(mr.isDraft)}`,
    );
  }

  return {
    reviewers,
    // Retain ownership of both targets after a failed/uncertain edit so a retry
    // can remove obsolete labels without touching unrelated project labels.
    reviewerLabels: labelsSync.ok
      ? reviewerLabels
      : [...new Set([...previousReviewerLabels, ...reviewerLabels])],
    approvalRequestedAt: plan.approvalRequestedAt,
    approvalsComplete: plan.labels.some((label) => label.name === MERGE_READY_LABEL.name),
    reviewersChanged,
    labelsSyncOk: labelsSync.ok,
    ...(labelsSync.error ? { labelsSyncError: labelsSync.error } : {}),
  };
};
