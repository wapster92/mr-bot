import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let repository: typeof import('../src/data/mergeRequestRepository');
let filter: Record<string, any>;

before(() => {
  const path = require.resolve('../src/db/mongo.ts');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: {
    getDb: async () => ({ collection: () => ({
      createIndex: async () => {},
      find: (query: Record<string, any>) => {
        filter = query;
        const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => [] };
        return cursor;
      },
    }) }),
  } } as NodeJS.Module;
  repository = require('../src/data/mergeRequestRepository.ts');
});

describe('pending MR query for assigned reviewers and volunteers', () => {
  it('includes commenters independently of the assigned pair and excludes drafts', async () => {
    await repository.listPendingReviewsForReviewer('sorokina.iv');
    assert.ok(filter.$or.some((part: Record<string, any>) => part.reviewers));
    const commenter = filter.$or.find((part: Record<string, any>) => part.reviewCommenters).reviewCommenters;
    assert.ok(new RegExp(commenter.$regex, commenter.$options).test('SOROKINA.IV'));
    assert.equal(filter.isDraft.$ne, true);
  });

  it('excludes the author and current approvers, with literal case-insensitive usernames', async () => {
    await repository.listPendingReviewsForReviewer('sorokina.iv');
    for (const key of ['approvedBy', 'author.gitlabUsername']) {
      const excluded = filter[key].$not as RegExp;
      assert.equal(excluded.test('SOROKINA.IV'), true);
      assert.equal(excluded.test('sorokinaXiv'), false);
      assert.equal(excluded.test('other.user'), false);
    }
  });
});
