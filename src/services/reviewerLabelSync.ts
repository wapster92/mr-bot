import { updateMergeRequest } from '../data/mergeRequestRepository';
import {
  fetchUserByUsername,
  updateMergeRequestReviewersAndLabels,
} from '../gitlab/api';
import {
  getGitlabUserIdByUsername,
  getGitlabUserProfile,
  upsertGitlabUserProfile,
} from '../data/userStore';

type SyncTargetState = {
  reviewers?: string[];
  labels?: string[];
};

const SYNC_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const recentSyncAttempts = new Map<string, number>();

const normalizeValues = (values: string[]): string[] =>
  values.map((value) => value.trim()).filter(Boolean);

const areSameStringSets = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...normalizeValues(left)].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...normalizeValues(right)].sort((a, b) => a.localeCompare(b));

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

const buildSyncKey = (
  projectId: number,
  iid: number,
  reviewers: string[],
  labels: string[],
): string =>
  JSON.stringify({
    projectId,
    iid,
    reviewers: [...normalizeValues(reviewers)].sort((a, b) => a.localeCompare(b)),
    labels: [...normalizeValues(labels)].sort((a, b) => a.localeCompare(b)),
  });

const shouldSkipRecentAttempt = (key: string): boolean => {
  const now = Date.now();
  for (const [entryKey, timestamp] of recentSyncAttempts.entries()) {
    if (now - timestamp > SYNC_DEDUPE_WINDOW_MS) {
      recentSyncAttempts.delete(entryKey);
    }
  }

  const previousAttemptAt = recentSyncAttempts.get(key);
  if (previousAttemptAt && now - previousAttemptAt < SYNC_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentSyncAttempts.set(key, now);
  return false;
};

const buildReviewerLabels = async (reviewerUsernames: string[]): Promise<string[]> => {
  const labels: string[] = [];

  for (const rawUsername of reviewerUsernames) {
    const username = rawUsername.trim();
    if (!username) {
      continue;
    }

    const storedProfile = await getGitlabUserProfile(username);
    if (storedProfile?.name?.trim()) {
      labels.push(storedProfile.name.trim());
      continue;
    }

    const apiUser = await fetchUserByUsername(username);
    if (apiUser?.username) {
      await upsertGitlabUserProfile(apiUser.username, apiUser.name, apiUser.id);
    }
    if (apiUser?.name?.trim()) {
      labels.push(apiUser.name.trim());
      continue;
    }

    labels.push(username);
  }

  return labels;
};

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
  currentState?: SyncTargetState,
): Promise<{ ok: boolean; error?: string }> => {
  if (!reviewerUsernames.length) {
    return { ok: false, error: 'empty reviewer list' };
  }

  const normalizedReviewerUsernames = normalizeValues(reviewerUsernames);
  const reviewerIds = await resolveReviewerIds(reviewerUsernames);
  if (!reviewerIds?.length) {
    return { ok: false, error: 'cannot resolve reviewer ids' };
  }

  const labels = await buildReviewerLabels(reviewerUsernames);
  if (
    currentState &&
    areSameStringSets(
      normalizedReviewerUsernames,
      normalizeValues(currentState.reviewers ?? []),
    ) &&
    areSameStringSets(labels, normalizeValues(currentState.labels ?? []))
  ) {
    console.info(
      `[reviewer-label-sync] skip unchanged ${projectId}/${iid} reviewers=${normalizedReviewerUsernames.join(',')} labels=${labels.join(',')}`,
    );
    return { ok: true };
  }

  const syncKey = buildSyncKey(projectId, iid, normalizedReviewerUsernames, labels);
  if (shouldSkipRecentAttempt(syncKey)) {
    console.warn(
      `[reviewer-label-sync] skip dedupe ${projectId}/${iid} reviewers=${normalizedReviewerUsernames.join(',')} labels=${labels.join(',')}`,
    );
    return { ok: true };
  }

  console.info(
    `[reviewer-label-sync] edit ${projectId}/${iid} reviewers=${normalizedReviewerUsernames.join(',')} labels=${labels.join(',')}`,
  );

  const ok = await updateMergeRequestReviewersAndLabels(projectId, iid, reviewerIds, labels);

  if (ok) {
    await updateMergeRequest(projectId, iid, {
      reviewers: normalizedReviewerUsernames,
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
