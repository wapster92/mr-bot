import { Gitlab } from '@gitbeaker/rest';
import { config } from '../config';

type GitlabUser = {
  id?: number;
  username?: string;
  name?: string;
};

export type GitlabMergeRequest = {
  author?: GitlabUser;
  reviewers?: GitlabUser[];
  title?: string;
  description?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  web_url?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  created_at?: string;
  updated_at?: string;
};

export type GitlabApprovals = {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: Array<{
    user?: GitlabUser;
  }>;
};

const normalizeHost = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  let trimmed = value.replace(/\/$/, '');
  if (trimmed.endsWith('/api/v4')) {
    trimmed = trimmed.slice(0, -'/api/v4'.length);
  }
  return trimmed;
};

type ApiConfig = {
  host: string;
  token: string;
  retries: number;
  retryBaseMs: number;
  timeoutMs: number;
};

const getApiConfig = (): ApiConfig | undefined => {
  const host = normalizeHost(config.gitlab.api?.baseUrl);
  const token = config.gitlab.api?.token;
  if (!host || !token) {
    return undefined;
  }
  return {
    host,
    token,
    retries: Math.max(1, config.gitlab.api?.retries ?? 3),
    retryBaseMs: Math.max(0, config.gitlab.api?.retryBaseMs ?? 500),
    timeoutMs: Math.max(0, config.gitlab.api?.timeoutMs ?? 10000),
  };
};

const toGitlabUser = (user?: any): GitlabUser | undefined => {
  if (!user) {
    return undefined;
  }
  const id = typeof user.id === 'number' ? user.id : undefined;
  const username = typeof user.username === 'string' ? user.username : undefined;
  const name = typeof user.name === 'string' ? user.name : undefined;
  if (!id && !username && !name) {
    return undefined;
  }
  return { id, username, name };
};

const normalizeUserList = (users?: any): GitlabUser[] =>
  Array.isArray(users)
    ? (users.map((user) => toGitlabUser(user)).filter(Boolean) as GitlabUser[])
    : [];

let gitlabClient: Gitlab | undefined;
let gitlabHost: string | undefined;
let gitlabToken: string | undefined;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const withRetry = async <T>(
  api: ApiConfig,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= api.retries; attempt += 1) {
    try {
      return await withTimeout(fn(), api.timeoutMs, label);
    } catch (error) {
      lastError = error;
      const message = `[gitlab-api] ${label} failed (attempt ${attempt}/${api.retries}): ${String(
        error,
      )}`;
      if (attempt < api.retries) {
        console.warn(message);
        const delay = api.retryBaseMs * 2 ** (attempt - 1);
        if (delay > 0) {
          await sleep(delay);
        }
      } else {
        console.error(message);
      }
    }
  }
  if (lastError) {
    console.error(`[gitlab-api] ${label} giving up: ${String(lastError)}`);
  }
  return undefined;
};

const getClient = (api: ApiConfig): Gitlab => {
  if (!gitlabClient || gitlabHost !== api.host || gitlabToken !== api.token) {
    gitlabClient = new Gitlab({ host: api.host, token: api.token });
    gitlabHost = api.host;
    gitlabToken = api.token;
  }
  return gitlabClient;
};

export const fetchMergeRequest = async (
  projectId: number,
  iid: number,
): Promise<GitlabMergeRequest | undefined> => {
  const api = getApiConfig();
  if (!api) {
    return undefined;
  }
  const client = getClient(api);
  const response = await withRetry(
    api,
    `MergeRequests.show ${projectId}#${iid}`,
    () => client.MergeRequests.show(projectId, iid),
  );
  if (!response) {
    return undefined;
  }
  const result: GitlabMergeRequest = {};
  const author = toGitlabUser(response?.author);
  const reviewers = normalizeUserList(response?.reviewers);
  if (author) {
    result.author = author;
  }
  result.reviewers = reviewers;
  if (typeof response?.title === 'string') {
    result.title = response.title;
  }
  if (typeof response?.description === 'string') {
    result.description = response.description;
  }
  if (typeof response?.state === 'string') {
    result.state = response.state;
  }
  if (typeof response?.source_branch === 'string') {
    result.source_branch = response.source_branch;
  }
  if (typeof response?.target_branch === 'string') {
    result.target_branch = response.target_branch;
  }
  if (typeof response?.web_url === 'string') {
    result.web_url = response.web_url;
  }
  if (typeof response?.merge_status === 'string') {
    result.merge_status = response.merge_status;
  }
  if (typeof response?.detailed_merge_status === 'string') {
    result.detailed_merge_status = response.detailed_merge_status;
  }
  if (typeof response?.created_at === 'string') {
    result.created_at = response.created_at;
  }
  if (typeof response?.updated_at === 'string') {
    result.updated_at = response.updated_at;
  }
  return result;
};

export const fetchMergeRequestApprovals = async (
  projectId: number,
  iid: number,
): Promise<GitlabApprovals | undefined> => {
  const api = getApiConfig();
  if (!api) {
    return undefined;
  }
  const client = getClient(api);
  const response: any = await withRetry(
    api,
    `MergeRequestApprovals.showConfiguration ${projectId}#${iid}`,
    () => client.MergeRequestApprovals.showConfiguration(projectId, { mergerequestIId: iid }),
  );
  if (!response) {
    return undefined;
  }
  const approvedBy = Array.isArray(response?.approved_by)
    ? response.approved_by
        .map((item: any) => ({ user: toGitlabUser(item?.user) }))
        .filter((item: { user?: GitlabUser }) => Boolean(item.user))
    : undefined;
  return {
    approvals_required:
      typeof response?.approvals_required === 'number' ? response.approvals_required : undefined,
    approvals_left:
      typeof response?.approvals_left === 'number' ? response.approvals_left : undefined,
    approved_by: approvedBy,
  };
};

export const fetchUserByUsername = async (
  username: string,
): Promise<GitlabUser | undefined> => {
  const api = getApiConfig();
  if (!api || !username) {
    return undefined;
  }
  const client = getClient(api);
  const response: any = await withRetry(
    api,
    `Users.all ${username}`,
    () => client.Users.all({ username }),
  );
  if (!Array.isArray(response) || response.length === 0) {
    return undefined;
  }
  return toGitlabUser(response[0]);
};

export const setMergeRequestReviewers = async (
  projectId: number,
  iid: number,
  reviewerIds: number[],
): Promise<boolean> => {
  const api = getApiConfig();
  if (!api) {
    return false;
  }
  const client = getClient(api);
  const payload = { reviewerIds };
  const result = await withRetry(
    api,
    `MergeRequests.edit reviewers ${projectId}#${iid}`,
    () => client.MergeRequests.edit(projectId, iid, payload),
  );
  return Boolean(result);
};
