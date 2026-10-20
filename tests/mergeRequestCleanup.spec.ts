import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import { withMergeRequestLock } from '../src/services/mergeRequestLock';
import { getMergeRequestFinishedAt, MERGE_REQUEST_RETENTION_MS } from '../src/services/mergeRequestRetention';

let repository: typeof import('../src/data/mergeRequestRepository');
let cleanup: typeof import('../src/services/mergeRequestCleanup');
let documents: MergeRequestDocument[] = [];
let projects: number[] = [];
const touched = new Set<string>();
const now = new Date('2026-10-20T12:00:00Z');
const old = new Date(now.getTime() - MERGE_REQUEST_RETENTION_MS - 1);
const recent = new Date(now.getTime() - 1000);

// Minimal Mongo predicate interpreter for the actual repository's scan/delete
// filters: the tests exercise the same conditions for both operations.
const matches = (doc: Record<string, unknown>, filter: Record<string, any>): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((part: Record<string, any>) => matches(doc, part));
    const value = doc[key];
    if (condition === null) return value === null || value === undefined;
    if (typeof condition !== 'object') return value === condition;
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$in') return (expected as unknown[]).includes(value);
      if (operator === '$ne') return value !== expected;
      if (operator === '$type') return expected === 'date' && value instanceof Date;
      if (operator === '$lte') return value instanceof Date && value <= (expected as Date);
      throw new Error(`Unexpected Mongo operator: ${operator}`);
    });
  });

before(() => {
  const path = require.resolve('../src/db/mongo.ts');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: {
    getDb: async () => ({ collection: (name: string) => {
      touched.add(name);
      assert.ok(['merge_requests', 'gitlab_projects'].includes(name));
      return {
        createIndex: async () => {},
        find: (filter: Record<string, any>) => {
          let limit = Infinity;
          const cursor = {
            limit: (value: number) => { limit = value; return cursor; },
            toArray: async () => structuredClone(documents.filter((doc) => matches(doc, filter)).slice(0, limit)),
          };
          return cursor;
        },
        deleteOne: async (filter: Record<string, any>) => {
          const index = documents.findIndex((doc) => matches(doc, filter));
          if (index < 0) return { deletedCount: 0 };
          documents.splice(index, 1);
          return { deletedCount: 1 };
        },
        updateOne: async (_filter: unknown, update: { $setOnInsert: { projectId: number } }) => {
          assert.equal(name, 'gitlab_projects');
          const id = update.$setOnInsert.projectId;
          if (!projects.includes(id)) projects.push(id);
        },
        distinct: async () => name === 'gitlab_projects'
          ? projects : [...new Set(documents.map((doc) => doc.projectId))],
      };
    } }),
  } } as NodeJS.Module;
  repository = require('../src/data/mergeRequestRepository.ts');
  cleanup = require('../src/services/mergeRequestCleanup.ts');
});

beforeEach(() => { documents = []; projects = []; touched.clear(); });

const mr = (iid: number, fields: Partial<MergeRequestDocument> = {}): MergeRequestDocument => ({
  projectId: 1, projectPath: 'test', mrId: iid, iid, title: 'Test',
  sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr',
  author: { gitlabUsername: 'author' }, state: 'closed', finishedAt: old, ...fields,
});

describe('MR retention dates', () => {
  it('uses the closure date rather than an old creation or update date', () => {
    const previous = mr(1, { state: 'opened', updatedAt: old });
    const current = { ...previous, state: 'closed' };
    assert.equal(getMergeRequestFinishedAt(current, previous, recent, now), recent);
    assert.equal(getMergeRequestFinishedAt(current, previous, undefined, now), now);
  });

  it('does not postpone deletion on repeated events or label updates', () => {
    const previous = mr(1);
    assert.equal(getMergeRequestFinishedAt({ ...previous, updatedAt: now }, previous), old);
    const legacy = mr(2, { finishedAt: null, updatedAt: old });
    assert.equal(getMergeRequestFinishedAt({ ...legacy, updatedAt: now }, legacy), old);
  });

  it('clears the date on reopening and starts a new period on subsequent closure', () => {
    const previous = mr(1);
    const reopened = mr(1, { state: 'opened', finishedAt: null });
    assert.equal(getMergeRequestFinishedAt(reopened, previous, old, now), null);
    assert.equal(getMergeRequestFinishedAt(previous, reopened, undefined, now), now);
  });
});

describe('MR database cleanup', () => {
  it('deletes only terminal MRs at least 30 days old and preserves active or unfinished records', async () => {
    documents = [
      mr(1), mr(2, { state: 'merged' }),
      mr(3, { finishedAt: new Date(now.getTime() - MERGE_REQUEST_RETENTION_MS) }),
      mr(4, { finishedAt: recent, createdAt: old, updatedAt: old }),
      mr(5, { state: 'opened' }), mr(6, { state: 'opened', isDraft: true }),
      mr(7, { state: undefined }), mr(8, { reviewerLabelsCleanupPending: true }),
    ];
    assert.equal(await cleanup.runMergeRequestCleanup(now), 3);
    assert.deepEqual(documents.map((doc) => doc.iid), [4, 5, 6, 7, 8]);
    assert.deepEqual([...touched].sort(), ['gitlab_projects', 'merge_requests']);
  });

  it('expires legacy records using last modification, never creation time alone', async () => {
    documents = [
      mr(1, { finishedAt: undefined, updatedAt: old }),
      mr(2, { finishedAt: null, updatedAt: old }),
      mr(3, { finishedAt: undefined, updatedAt: recent, createdAt: old }),
      mr(4, { finishedAt: undefined, createdAt: old }),
    ];
    assert.equal(await cleanup.runMergeRequestCleanup(now), 2);
    assert.deepEqual(documents.map((doc) => doc.iid), [3, 4]);
  });

  it('rechecks the atomic delete filter if an MR was reopened or label cleanup became pending', async () => {
    documents = [mr(1), mr(2)];
    const candidates = await repository.listExpiredMergeRequests(old);
    assert.equal(candidates.length, 2);
    documents[0]!.state = 'opened';
    documents[1]!.reviewerLabelsCleanupPending = true;
    assert.equal(await repository.deleteExpiredMergeRequest(1, 1, old), false);
    assert.equal(await repository.deleteExpiredMergeRequest(1, 2, old), false);
    assert.equal(documents.length, 2);
  });

  it('waits for an in-flight MR update before deleting and prevents overlapping runs', async () => {
    documents = [mr(1)];
    let release = (): void => {};
    let entered = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const update = withMergeRequestLock(1, 1, async () => {
      entered(); await held; documents[0]!.state = 'opened';
    });
    await acquired;
    const run = cleanup.runMergeRequestCleanup(now);
    assert.equal(await cleanup.runMergeRequestCleanup(now), 0);
    release(); await update;
    assert.equal(await run, 0);
    assert.equal(documents.length, 1);
  });

  it('keeps project discovery working after its last MR expires and is idempotent', async () => {
    documents = [mr(1)];
    assert.equal(await cleanup.runMergeRequestCleanup(now), 1);
    assert.equal(await cleanup.runMergeRequestCleanup(now), 0);
    assert.equal(documents.length, 0);
    assert.deepEqual(await repository.listProjectIds(), [1]);
  });
});
