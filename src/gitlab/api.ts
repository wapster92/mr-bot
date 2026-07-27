import { Gitlab } from '@gitbeaker/rest';
import { config } from '../config';

type GitlabUser = {
  id?: number;
  username?: string;
  name?: string;
};

export type GitlabMergeRequest = {
  author?: GitlabUser;
  labels?: string[];
  title?: string;
  description?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  web_url?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  work_in_progress?: boolean;
  draft?: boolean;
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

export type GitlabPipelineJob = {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  web_url?: string;
};

export type GitlabMergeRequestListItem = {
  id?: number;
  iid?: number;
  project_id?: number;
  project_path?: string;
  title?: string;
  description?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  web_url?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  work_in_progress?: boolean;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  author?: GitlabUser;
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
    retries: Math.min(5, Math.max(1, config.gitlab.api?.retries ?? 3)),
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
  if (author) {
    result.author = author;
  }
  result.labels = Array.isArray(response?.labels)
    ? response.labels.filter((label: unknown): label is string => typeof label === 'string')
    : [];
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

export const fetchPipelineJobs = async (
  projectId: number,
  pipelineId: number,
): Promise<GitlabPipelineJob[] | undefined> => {
  const api = getApiConfig();
  if (!api) {
    return undefined;
  }
  const client = getClient(api);
  try {
    const jobs: any = await withRetry(api, `Jobs.all ${projectId}#${pipelineId}`, () =>
      client.Jobs.all(projectId, { pipelineId }),
    );
    if (!Array.isArray(jobs)) {
      return undefined;
    }
    return jobs.map((job) => ({
      id: typeof job.id === 'number' ? job.id : undefined,
      name: typeof job.name === 'string' ? job.name : undefined,
      stage: typeof job.stage === 'string' ? job.stage : undefined,
      status: typeof job.status === 'string' ? job.status : undefined,
      web_url: typeof job.web_url === 'string' ? job.web_url : undefined,
    }));
  } catch (error) {
    console.warn(`[gitlab-api] Pipelines.allJobs failed: ${String(error)}`);
    return undefined;
  }
};

export const fetchProjectMergeRequests = async (
  projectId: number,
  state: 'opened' | 'closed' | 'merged' = 'opened',
): Promise<GitlabMergeRequestListItem[] | undefined> => {
  const api = getApiConfig();
  if (!api) {
    return undefined;
  }
  const client = getClient(api);
  try {
    let page = 1;
    const perPage = 100;
    const all: GitlabMergeRequestListItem[] = [];
    // Gitbeaker REST с withRetry на каждую страницу
    // Останавливаемся, если вернулась пустая страница.
    // Ограничиваемся 50 страницами, чтобы не зависнуть (5k MR).
    while (page <= 50) {
      const mrs: any = await withRetry(
        api,
        `MergeRequests.all project ${projectId} page ${page}`,
        () =>
          client.MergeRequests.all({
            projectId,
            state,
            scope: 'all',
            withMergeStatusRecheck: true,
            page,
            perPage,
          }),
      );
      if (!Array.isArray(mrs) || mrs.length === 0) {
        break;
      }
      for (const mr of mrs) {
        const item: GitlabMergeRequestListItem = {};
        if (typeof mr.id === 'number') item.id = mr.id;
        if (typeof mr.iid === 'number') item.iid = mr.iid;
        item.project_id = typeof mr.project_id === 'number' ? mr.project_id : projectId;
        if (typeof mr.title === 'string') item.title = mr.title;
        if (typeof mr.description === 'string') item.description = mr.description;
        if (typeof mr.state === 'string') item.state = mr.state;
        if (typeof mr.source_branch === 'string') item.source_branch = mr.source_branch;
        if (typeof mr.target_branch === 'string') item.target_branch = mr.target_branch;
        if (typeof mr.web_url === 'string') item.web_url = mr.web_url;
        if (typeof mr.merge_status === 'string') item.merge_status = mr.merge_status;
        if (typeof mr.detailed_merge_status === 'string')
          item.detailed_merge_status = mr.detailed_merge_status;
        if (typeof mr.created_at === 'string') item.created_at = mr.created_at;
        if (typeof mr.updated_at === 'string') item.updated_at = mr.updated_at;
        const author = toGitlabUser(mr.author);
        if (author) item.author = author;
        // path_with_namespace появляется в списке MR
        if (typeof mr.references?.full === 'string') {
          const match = mr.references.full.match(/^(.+)!/);
          if (match?.[1]) {
            item.project_path = match[1];
          }
        }
        all.push(item);
      }
      if (mrs.length < perPage) {
        break;
      }
      page += 1;
    }
    return all;
  } catch (error) {
    console.warn(`[gitlab-api] MergeRequests.all failed: ${String(error)}`);
    return undefined;
  }
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

export const updateMergeRequestLabels = async (
  projectId: number,
  iid: number,
  labels: string[],
): Promise<boolean> => {
  const api = getApiConfig();
  if (!api) {
    return false;
  }
  const client = getClient(api);
  const payload = {
    labels: labels.join(','),
  };
  const result = await withRetry(
    { ...api, retries: 1 },
    `MergeRequests.edit labels ${projectId}#${iid}`,
    () => client.MergeRequests.edit(projectId, iid, payload),
  );
  return Boolean(result);
};
