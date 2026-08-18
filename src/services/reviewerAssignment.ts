import { pullReviewers } from '../data/reviewerQueue';
import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import { isReviewerEnabled } from '../data/userTypes';
import {
  buildReviewerLabels,
  syncReviewerLabelsToGitlab,
} from './reviewerLabelSync';

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
  reviewersChanged: boolean;
  labelsSyncOk: boolean;
  labelsSyncError?: string;
};

export const reconcileReviewersForMr = async (
  mr: MergeRequestDocument,
  currentGitlabLabels: string[] | undefined,
): Promise<ReviewerReconciliation> => {
  const previousReviewers = uniqueUsernames(mr.reviewers ?? []);
  const previousReviewerLabels =
    mr.reviewerLabels ?? (await buildReviewerLabels(previousReviewers));

  let reviewers: string[] = [];
  if (!mr.isDraft) {
    reviewers = await filterAvailableReviewers(previousReviewers);
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

  const reviewerLabels = await buildReviewerLabels(reviewers);
  const labelsSync = await syncReviewerLabelsToGitlab(
    mr.projectId,
    mr.iid,
    currentGitlabLabels,
    previousReviewerLabels,
    reviewerLabels,
  );
  const reviewersChanged = !areSameReviewers(previousReviewers, reviewers);
  if (reviewersChanged) {
    console.info(
      `[reviewer-assignment] ${mr.projectId}/${mr.iid} previous=${previousReviewers.join(',')} next=${reviewers.join(',')} draft=${Boolean(mr.isDraft)}`,
    );
  }

  return {
    reviewers,
    reviewerLabels: labelsSync.ok ? reviewerLabels : previousReviewerLabels,
    reviewersChanged,
    labelsSyncOk: labelsSync.ok,
    ...(labelsSync.error ? { labelsSyncError: labelsSync.error } : {}),
  };
};
