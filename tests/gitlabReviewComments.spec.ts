import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let api: typeof import('../src/gitlab/api');
let unavailable = false;
const calls: unknown[][] = [];

const mockModule = (relative: string, exports: unknown): void => {
  const path = require.resolve(relative);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

before(() => {
  mockModule('../src/config.ts', {
    config: { gitlab: { api: {
      baseUrl: 'https://gitlab.example', token: 'test', retries: 1, timeoutMs: 0,
    } } },
  });
  mockModule('@gitbeaker/rest', {
    Gitlab: class {
      MergeRequests = {
        show: async () => ({
          state: 'closed', closed_at: '2026-09-01T09:00:00Z', merged_at: '2026-09-02T09:00:00Z',
          merge_user: { id: 1, username: 'actual.merger', name: 'Merger' },
          merged_by: { id: 2, username: 'legacy.merger', name: 'Legacy' },
        }),
      };
      MergeRequestDiscussions = {
        all: async (...args: unknown[]) => {
          calls.push(args);
          if (unavailable) throw new Error('Test API unavailable');
          return [
            { individual_note: true, notes: [
              { type: null, author: { username: 'reviewer' }, system: false },
            ] },
            { individual_note: false, notes: [
              { type: 'DiffNote', author: { username: 'lead' }, system: false },
              { type: 'DiscussionNote', author: { username: 'reply' }, system: false },
            ] },
            { notes: [{ author: { username: 'system' }, system: true }] },
            {},
          ];
        },
      };
    },
  });
  api = require('../src/gitlab/api.ts');
});

describe('GitLab review comment history', () => {
  it('preserves terminal dates returned by GitLab for MR retention', async () => {
    const mr = await api.fetchMergeRequest(1, 2);
    assert.equal(mr?.closed_at, '2026-09-01T09:00:00Z');
    assert.equal(mr?.merged_at, '2026-09-02T09:00:00Z');
  });

  it('reads ordinary, inline and thread comments through the paginated Discussions API', async () => {
    assert.deepEqual(await api.fetchMergeRequestNotes(1, 2), [
      { authorUsername: 'reviewer', system: false },
      { authorUsername: 'lead', system: false },
      { authorUsername: 'reply', system: false },
      { authorUsername: 'system', system: true },
    ]);
    assert.deepEqual(calls, [[1, 2, { perPage: 100 }]]);
  });

  it('preserves both the actual merger and the legacy merger field', async () => {
    const mr = await api.fetchMergeRequest(1, 2);
    assert.deepEqual(mr?.merge_user, { id: 1, username: 'actual.merger', name: 'Merger' });
    assert.deepEqual(mr?.merged_by, { id: 2, username: 'legacy.merger', name: 'Legacy' });
  });

  it('does not treat an API error as successfully loaded empty history', async () => {
    unavailable = true;
    assert.equal(await api.fetchMergeRequestNotes(1, 2), undefined);
  });
});
