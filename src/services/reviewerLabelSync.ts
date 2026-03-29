import { updateMergeRequest } from '../data/mergeRequestRepository';
import {
  fetchUserByUsername,
  updateMergeRequestReviewersAndLabels,
} from '../gitlab/api';
import { getGitlabUserIdByUsername, upsertGitlabUserProfile } from '../data/userStore';

const buildReviewerLabels = (reviewerUsernames: string[]): string[] =>
  reviewerUsernames
    .map((username) => username.trim())
    .filter(Boolean)
    .map((username) => `@${username}`);

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
    console.warn('[reviewer-label-sync] Cannot resolve GitLab IDs for reviewers', missing.join(', '));
    return null;
  }

  return reviewerIds;
};

export const syncReviewersAndLabelsToGitlab = async (
  projectId: number,
  iid: number,
  reviewerUsernames: string[],
): Promise<{ ok: boolean; error?: string }> => {
  if (!reviewerUsernames.length) {
    return { ok: false, error: 'empty reviewer list' };
  }

  const reviewerIds = await resolveReviewerIds(reviewerUsernames);
  if (!reviewerIds?.length) {
    return { ok: false, error: 'cannot resolve reviewer ids' };
  }

  const labels = buildReviewerLabels(reviewerUsernames);
  const ok = await updateMergeRequestReviewersAndLabels(projectId, iid, reviewerIds, labels);

  if (ok) {
    await updateMergeRequest(projectId, iid, {
      reviewers: reviewerUsernames,
      reviewersSyncedAt: new Date(),
    });
    return { ok: true };
  }

  const error = 'gitlab edit failed';
  await updateMergeRequest(projectId, iid, {
    reviewersSyncFailedAt: new Date(),
    reviewersSyncError: error,
  });
  return { ok: false, error };
};
