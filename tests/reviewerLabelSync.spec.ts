import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { ReviewLabel } from '../src/services/reviewLabelPlan';

let sync: typeof import('../src/services/reviewerLabelSync');
let writes: string[][] = [];
let definitions = new Map<string, { id: number; name: string; color: string; isProjectLabel: boolean }>();
let definitionWrites = 0;
let definitionReads = 0;
let failEdit = false;
let failDefinition = false;

before(() => {
  const apiPath = require.resolve('../src/gitlab/api.ts');
  require.cache[apiPath] = {
    id: apiPath, filename: apiPath, loaded: true,
    exports: {
      fetchProjectLabels: async () => { definitionReads += 1; return [...definitions.values()]; },
      ensureProjectLabel: async (_projectId: number, label: ReviewLabel) => {
        definitionWrites += 1;
        if (failDefinition) return undefined;
        const result = { id: definitions.size + 1, ...label, isProjectLabel: true };
        definitions.set(label.name, result);
        return result;
      },
      updateMergeRequestLabels: async (_projectId: number, _iid: number, labels: string[]) => {
        writes.push(labels);
        return !failEdit;
      },
    },
  } as NodeJS.Module;
  sync = require('../src/services/reviewerLabelSync.ts');
});

beforeEach(() => {
  writes = []; definitions = new Map(); definitionWrites = 0; definitionReads = 0;
  failEdit = false; failDefinition = false;
});

describe('GitLab label synchronization loop protection', () => {
  it('preserves unrelated labels while replacing only bot-owned labels', async () => {
    const result = await sync.syncReviewerLabelsToGitlab(
      101, 1, ['bug', 'sprint', 'Ревьюер'], ['Ревьюер'], ['Можно сливать'],
    );
    assert.equal(result.ok, true);
    assert.deepEqual(writes, [['bug', 'sprint', 'Можно сливать']]);
  });

  it('replaces long role/account labels with short names once and preserves unrelated labels', async () => {
    const old = ['Ревью: Ирина В. Сорокина (@sorokina.iv)', 'Лид: Дмитрий Р. Сазонов (@sazonov.dr)'];
    const next = ['Ирина В. Сорокина', 'Дмитрий Р. Сазонов'];
    assert.equal((await sync.syncReviewerLabelsToGitlab(109, 1, ['bug', ...old], old, next)).ok, true);
    assert.deepEqual(writes, [['bug', ...next]]);
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await sync.syncReviewerLabelsToGitlab(109, 1, ['bug', ...next], next, next)).ok, true);
    }
    assert.equal(writes.length, 1);
  });

  it('does not issue writes for repeated unchanged label webhooks', async () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await sync.syncReviewerLabelsToGitlab(
        102, 1, ['bug', 'Ревьюер'], ['Ревьюер'], ['Ревьюер'],
      )).ok, true);
    }
    assert.equal(writes.length, 0);
  });

  it('deduplicates a repeated stale snapshot without pretending GitLab is synchronized', async () => {
    const initial = await sync.syncReviewerLabelsToGitlab(103, 1, ['old'], ['old'], ['new']);
    const replay = await sync.syncReviewerLabelsToGitlab(103, 1, ['old'], ['old'], ['new']);
    assert.equal(initial.ok, true);
    assert.equal(replay.ok, false);
    assert.equal(writes.length, 1);
  });

  it('throttles alternating targets and retries the latest target after cooldown', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await sync.syncReviewerLabelsToGitlab(104, 1, ['old'], ['old'], ['new']);
    const deferred = await sync.syncReviewerLabelsToGitlab(104, 1, ['new'], ['new'], ['ready']);
    assert.equal(deferred.ok, false);
    assert.equal(writes.length, 1);
    now += 121_000;
    const retried = await sync.syncReviewerLabelsToGitlab(104, 1, ['new'], ['new'], ['ready']);
    assert.equal(retried.ok, true);
    assert.equal(writes.length, 2);
  });

  it('throttles failed label edits instead of creating a retry loop', async () => {
    failEdit = true;
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await sync.syncReviewerLabelsToGitlab(105, 1, ['old'], ['old'], ['new'])).ok, false);
    }
    assert.equal(writes.length, 1);
  });

  it('does not change labels when the current GitLab snapshot is unavailable', async () => {
    const result = await sync.syncReviewerLabelsToGitlab(106, 1, undefined, ['old'], ['new']);
    assert.equal(result.ok, false);
    assert.equal(writes.length, 0);
  });

  it('creates fixed-color label definitions once and reuses them across MRs', async () => {
    const label = { name: '🚨 Ревью: Reviewer (@reviewer)', color: '#d9534f' };
    await sync.syncReviewerLabelsToGitlab(107, 1, [], [], [label.name], [label]);
    await sync.syncReviewerLabelsToGitlab(107, 2, [], [], [label.name], [label]);
    await sync.syncReviewerLabelsToGitlab(107, 1, [label.name], [label.name], [label.name], [label]);
    assert.equal(definitionReads, 1);
    assert.equal(definitionWrites, 1);
    assert.equal(writes.length, 2);
  });

  it('throttles failed label creation and does not attach an incorrectly colored label', async () => {
    failDefinition = true;
    const label = { name: '🚨 Ревью: Failed (@failed)', color: '#d9534f' };
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await sync.syncReviewerLabelsToGitlab(108, i, [], [], [label.name], [label])).ok, false);
    }
    assert.equal(definitionWrites, 1);
    assert.equal(writes.length, 0);
  });
});
