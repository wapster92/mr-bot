import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';

let summary: typeof import('../src/services/mrSummary');

before(() => {
  const mockModule = (relative: string, exports: unknown): void => {
    const path = require.resolve(relative);
    require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  mockModule('../src/data/userStore.ts', {
    listLeadUsers: async () => [{ gitlabUsername: 'tech.lead' }, { gitlabUsername: 'team.lead' }],
    listActiveReviewers: async () => ['reviewer.one', 'reviewer.two'],
    listActiveUsernames: async () => ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead', 'volunteer'],
  });
  mockModule('../src/messages/format.ts', {
    escapeHtml: (value: string) => value, formatGitlabUserLabel: async (username: string) => username,
  });
  summary = require('../src/services/mrSummary.ts');
});

describe('MR summary for mandatory commenters', () => {
  const mr: MergeRequestDocument = {
    projectId: 1, projectPath: 'test', mrId: 1, iid: 1, title: 'Test', sourceBranch: 'feature',
    targetBranch: 'main', url: 'https://gitlab.example/mr/1', author: { gitlabUsername: 'author' },
    reviewers: ['reviewer.one', 'reviewer.two'], approvedBy: ['reviewer.one', 'tech.lead', 'team.lead'],
    reviewCommenters: ['volunteer'],
  };

  it('shows the mandatory volunteer separately from the unchanged assigned pair', async () => {
    const message = (await summary.buildMergeRequestMessages([mr]))[0]!;
    assert.ok(message.includes('Апрувы: ревьюер 1/1, лиды 2/2'));
    assert.ok(message.includes('Комментаторы без обязательного апрува: volunteer'));
    assert.ok(message.includes('Ревьюеры: reviewer.one, reviewer.two'));
  });

  it('removes the approved volunteer from the pending line and explains unverified history', async () => {
    const message = (await summary.buildMergeRequestMessages([{
      ...mr, approvedBy: [...mr.approvedBy!, 'volunteer'], reviewCommentHistorySyncPending: true,
    }]))[0]!;
    assert.ok(message.includes('Комментаторы без обязательного апрува: —'));
    assert.ok(message.includes('готовность не подтверждена'));
  });
});
