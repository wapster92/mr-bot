import {
  getGitlabUserProfile,
  upsertGitlabUserProfile,
} from '../data/userStore';
import { fetchUserByUsername, updateMergeRequestLabels } from '../gitlab/api';

const LABEL_EDIT_COOLDOWN_MS = 2 * 60 * 1000;
const recentSuccessfulTargets = new Map<string, number>();
const recentEditAttempts = new Map<string, number>();

const normalizeValues = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const normalizeForComparison = (value: string): string => value.trim().toLowerCase();

const areSameStringSets = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].map(normalizeForComparison).sort();
  const normalizedRight = [...right].map(normalizeForComparison).sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

const buildSyncKey = (projectId: number, iid: number, labels: string[]): string =>
  JSON.stringify({
    projectId,
    iid,
    labels: [...labels].map(normalizeForComparison).sort(),
  });

const pruneRecentEntries = (entries: Map<string, number>, now: number): void => {
  for (const [entryKey, timestamp] of entries.entries()) {
    if (now - timestamp > LABEL_EDIT_COOLDOWN_MS) {
      entries.delete(entryKey);
    }
  }
};

const wasRecentlySynced = (key: string, now: number): boolean => {
  pruneRecentEntries(recentSuccessfulTargets, now);
  const previousAttemptAt = recentSuccessfulTargets.get(key);
  return Boolean(
    previousAttemptAt && now - previousAttemptAt < LABEL_EDIT_COOLDOWN_MS,
  );
};

const isEditCoolingDown = (projectId: number, iid: number, now: number): boolean => {
  pruneRecentEntries(recentEditAttempts, now);
  const previousAttemptAt = recentEditAttempts.get(`${projectId}:${iid}`);
  return Boolean(
    previousAttemptAt && now - previousAttemptAt < LABEL_EDIT_COOLDOWN_MS,
  );
};

const markEditAttempt = (projectId: number, iid: number, now: number): void => {
  recentEditAttempts.set(`${projectId}:${iid}`, now);
};

const markSuccessfulTarget = (key: string, now: number): void => {
  recentSuccessfulTargets.set(key, now);
};

export const buildReviewerLabels = async (reviewerUsernames: string[]): Promise<string[]> => {
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
    labels.push(apiUser?.name?.trim() || username);
  }

  return normalizeValues(labels);
};

export const mergeReviewerLabels = (
  currentLabels: string[],
  previousReviewerLabels: string[],
  nextReviewerLabels: string[],
): string[] => {
  const previousSet = new Set(previousReviewerLabels.map(normalizeForComparison));
  const result = currentLabels.filter(
    (label) => !previousSet.has(normalizeForComparison(label)),
  );
  const resultSet = new Set(result.map(normalizeForComparison));
  for (const label of nextReviewerLabels) {
    const normalized = normalizeForComparison(label);
    if (!normalized || resultSet.has(normalized)) {
      continue;
    }
    result.push(label.trim());
    resultSet.add(normalized);
  }
  return result;
};

export const syncReviewerLabelsToGitlab = async (
  projectId: number,
  iid: number,
  currentLabels: string[] | undefined,
  previousReviewerLabels: string[],
  nextReviewerLabels: string[],
): Promise<{ ok: boolean; labels: string[]; error?: string }> => {
  if (!currentLabels) {
    return {
      ok: false,
      labels: nextReviewerLabels,
      error: 'current GitLab labels are unavailable',
    };
  }

  const labels = mergeReviewerLabels(
    currentLabels,
    previousReviewerLabels,
    nextReviewerLabels,
  );
  if (areSameStringSets(labels, currentLabels)) {
    console.info(`[reviewer-label-sync] skip unchanged ${projectId}/${iid}`);
    return { ok: true, labels };
  }

  const syncKey = buildSyncKey(projectId, iid, labels);
  const now = Date.now();
  if (wasRecentlySynced(syncKey, now)) {
    console.warn(`[reviewer-label-sync] skip dedupe ${projectId}/${iid}`);
    return { ok: true, labels };
  }

  if (isEditCoolingDown(projectId, iid, now)) {
    console.warn(`[reviewer-label-sync] skip cooldown ${projectId}/${iid}`);
    return {
      ok: false,
      labels,
      error: 'GitLab label edit deferred by cooldown',
    };
  }
  markEditAttempt(projectId, iid, now);

  console.info(
    `[reviewer-label-sync] edit ${projectId}/${iid} labels=${labels.join(',')}`,
  );
  const ok = await updateMergeRequestLabels(projectId, iid, labels);
  if (ok) {
    markSuccessfulTarget(syncKey, now);
    return { ok: true, labels };
  }
  return { ok: false, labels, error: 'GitLab label edit failed' };
};
