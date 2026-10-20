import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

let queue: typeof import('../src/data/reviewerQueue');
let available: string[] = [];
let storedQueue: string[] = [];

before(() => {
  const userPath = require.resolve('../src/data/userStore.ts');
  require.cache[userPath] = {
    id: userPath, filename: userPath, loaded: true,
    exports: { listAssignableReviewers: async () => [...available] },
  } as NodeJS.Module;
  const dbPath = require.resolve('../src/db/mongo.ts');
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: async () => ({
        collection: () => ({
          findOne: async () => ({ queue: [...storedQueue] }),
          updateOne: async (_filter: unknown, update: { $set: { queue: string[] } }) => {
            storedQueue = [...update.$set.queue];
          },
        }),
      }),
    },
  } as NodeJS.Module;
  queue = require('../src/data/reviewerQueue.ts');
});

beforeEach(() => {
  available = ['developer.one', 'developer.two', 'developer.three'];
  storedQueue = ['winner', ...available];
});

describe('reviewer queue with temporary rating exemptions', () => {
  it('skips an exempt winner already present in the persisted queue', async () => {
    assert.deepEqual(await queue.pullReviewers([]), ['developer.one', 'developer.two']);
  });

  it('restores new assignments when a participant loses the exemption', async () => {
    available = ['winner', 'developer.one', 'developer.two'];
    assert.deepEqual(await queue.pullReviewers([]), ['winner', 'developer.one']);
  });

  it('never duplicates a reviewer or assigns the author when the remaining pool is small', async () => {
    available = ['author', 'developer.one'];
    storedQueue = ['winner', 'author', 'developer.one'];
    assert.deepEqual(await queue.pullReviewers(['author']), ['developer.one']);
  });
});
