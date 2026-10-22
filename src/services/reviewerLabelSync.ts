import {
  getGitlabUserProfile,
  upsertGitlabUserProfile,
} from '../data/userStore';
import {
  ensureProjectLabel,
  fetchProjectLabels,
  fetchUserByUsername,
  updateMergeRequestLabels,
  type GitlabProjectLabel,
} from '../gitlab/api';
import { isReviewStatusLabel, type ReviewLabel } from './reviewLabelPlan';

const LABEL_EDIT_COOLDOWN_MS = 2 * 60 * 1000;
const recentSuccessfulTargets = new Map<string, number>();
const recentEditAttempts = new Map<string, number>();
const projectLabelCache = new Map<number, { fetchedAt: number; labels: GitlabProjectLabel[] }>();
const labelAttempts = new Map<string, number>();
let labelDefinitionOperation = Promise.resolve();

const withLabelDefinitionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = labelDefinitionOperation;
  let release = (): void => {};
  labelDefinitionOperation = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
};

// Called under the shared definition lock. MR attachment may create a personal
// label, but only the project-wide refresh is allowed to recolor an existing one.
const ensureReviewLabelDefinitions = async (
  projectId: number,
  definitions: ReviewLabel[],
  options: { preservePersonalColors?: boolean; existingOnly?: boolean } = {},
): Promise<boolean> => {
  if (!definitions.length) return true;
  const now = Date.now();
  let cached = projectLabelCache.get(projectId);
  if (!cached || now - cached.fetchedAt > 5 * 60 * 1000) {
    const key = `${projectId}:list`;
    const attemptedAt = labelAttempts.get(key);
    if (attemptedAt && now - attemptedAt < LABEL_EDIT_COOLDOWN_MS) return false;
    labelAttempts.set(key, now);
    const labels = await fetchProjectLabels(projectId);
    if (!labels) return false;
    cached = { fetchedAt: now, labels };
    projectLabelCache.set(projectId, cached);
  }
  pruneRecentEntries(labelAttempts, now);
  let ok = true;
  for (const definition of definitions) {
    const existing = cached.labels.find((label) => label.name === definition.name);
    if (!existing && options.existingOnly) continue;
    if (existing && options.preservePersonalColors && !isReviewStatusLabel(definition.name)) continue;
    if (existing?.color.toLowerCase() === definition.color.toLowerCase()) continue;
    const key = `${projectId}:${definition.name}:${existing ? 'color' : 'create'}`;
    const attemptedAt = labelAttempts.get(key);
    if (attemptedAt && now - attemptedAt < LABEL_EDIT_COOLDOWN_MS) { ok = false; continue; }
    labelAttempts.set(key, now);
    const ensured = await ensureProjectLabel(projectId, definition, existing);
    if (!ensured) { ok = false; continue; }
    cached.labels = cached.labels.filter((label) => label.name !== definition.name);
    cached.labels.push(ensured);
  }
  return ok;
};

export const syncProjectPersonalLabelColors = async (
  projectId: number,
  loadDefinitions: () => Promise<ReviewLabel[]>,
): Promise<boolean> => withLabelDefinitionLock(async () => {
  // Read Mongo after acquiring the lock, never apply a queued stale color plan.
  const definitions = await loadDefinitions();
  return ensureReviewLabelDefinitions(projectId, definitions, { existingOnly: true });
});

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
  definitions: ReviewLabel[] = [],
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
  if (!(await withLabelDefinitionLock(() => ensureReviewLabelDefinitions(
    projectId, definitions, { preservePersonalColors: true },
  )))) {
    return { ok: false, labels, error: 'GitLab review label definitions are unavailable' };
  }
  if (areSameStringSets(labels, currentLabels)) {
    console.info(`[reviewer-label-sync] skip unchanged ${projectId}/${iid}`);
    return { ok: true, labels };
  }

  const syncKey = buildSyncKey(projectId, iid, labels);
  const now = Date.now();
  if (wasRecentlySynced(syncKey, now)) {
    console.warn(`[reviewer-label-sync] skip dedupe ${projectId}/${iid}`);
    return { ok: false, labels, error: 'Stale GitLab labels deferred by dedupe' };
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
