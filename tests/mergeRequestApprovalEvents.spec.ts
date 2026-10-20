import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';

let events: typeof import('../src/services/mergeRequestApprovalEvents');
type ScoreInput = { mr: MergeRequestDocument; username: string; occurredAt: Date };
const scored: Array<ScoreInput & { kind: 'approval' | 'unapproval' }> = [];
const previous: MergeRequestDocument = {
  projectId: 1, projectPath: 'team/project', mrId: 10, iid: 2, title: 'Test',
  sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/2',
  author: { gitlabUsername: 'author' }, reviewers: ['reviewer.one', 'reviewer.two'],
  approvedBy: ['reviewer.one', 'TECH.LEAD', 'team.lead'], approvalsRequired: 3, approvalsLeft: 0,
};
const occurredAt = new Date('2026-10-21T10:00:00Z');

before(() => {
  const path = require.resolve('../src/services/gameScoring.ts');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: {
    runGameAction: async (_label: string, action: () => Promise<void>) => action(),
    recordReviewApprovalScore: async (input: ScoreInput) => { scored.push({ ...input, kind: 'approval' }); },
    recordReviewUnapprovalScore: async (input: ScoreInput) => { scored.push({ ...input, kind: 'unapproval' }); },
  } } as NodeJS.Module;
  events = require('../src/services/mergeRequestApprovalEvents.ts');
});

beforeEach(() => { scored.length = 0; });

describe('MR approval snapshot fallbacks', () => {
  it('uses defaults for a new MR without inventing approvers', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(null, undefined, { action: 'open' }, 3), {
      approvalsRequired: 3, approvalsLeft: 3,
    });
  });

  it('keeps the cached approve list during an API outage on ordinary updates', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, undefined, { action: 'update' }, 2), {
      approvedBy: previous.approvedBy, approvalsRequired: 3, approvalsLeft: 0,
    });
  });

  for (const action of ['approval', 'approved']) {
    it(`applies the ${action} actor case-insensitively when the API is unavailable`, () => {
      const next = events.resolveMergeRequestApprovals(previous, undefined, {
        action, actorUsername: 'tech.lead',
      }, 2);
      assert.deepEqual(next.approvedBy, ['reviewer.one', 'team.lead', 'tech.lead']);
    });
  }

  for (const action of ['unapproval', 'unapproved']) {
    it(`removes only the explicit ${action} actor during an API outage`, () => {
      const next = events.resolveMergeRequestApprovals(previous, undefined, {
        action, actorUsername: 'tech.lead',
      }, 2);
      assert.deepEqual(next.approvedBy, ['reviewer.one', 'team.lead']);
      // Legacy GitLab counters are normalized before actor fallback, not inferred
      // again from it. Bot readiness is calculated separately by approvalPolicy.
      assert.equal(next.approvalsLeft, 0);
    });
  }

  it('clears approves on an explicit system reset even without an actor or API', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, undefined, {
      action: 'unapproved', system: true,
    }, 2).approvedBy, []);
  });

  it('does not treat the system flag on an ordinary update as a reset', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, undefined, {
      action: 'update', system: true,
    }, 2).approvedBy, previous.approvedBy);
  });

  it('preserves known approvals when an approval event has no actor and no API', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, undefined, {
      action: 'approval',
    }, 2).approvedBy, previous.approvedBy);
  });

  it('prefers the API snapshot to a conflicting actor event and webhook counters', () => {
    const next = events.resolveMergeRequestApprovals(previous, {
      approved_by: [{ user: { username: 'reviewer.two' } }, {}, { user: { username: '' } }],
      approvals_required: 4, approvals_left: 3,
    }, { action: 'unapproval', actorUsername: 'reviewer.two', approvalsRequired: 9, approvalsLeft: 9 }, 2);
    assert.deepEqual(next, { approvedBy: ['reviewer.two'], approvalsRequired: 4, approvalsLeft: 3 });
  });

  it('recognizes an explicitly empty API approve list, not a network outage', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, { approved_by: [] }, {}, 2), {
      approvedBy: [], approvalsRequired: 3, approvalsLeft: 3,
    });
  });

  it('preserves the legacy empty-list behavior for an API response without approved_by', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(previous, {}, {}, 2).approvedBy, []);
  });

  it('takes webhook counters when the API is unavailable', () => {
    const next = events.resolveMergeRequestApprovals(null, undefined, {
      approvalsRequired: 4, approvalsLeft: 2,
    }, 3);
    assert.deepEqual(next, { approvalsRequired: 4, approvalsLeft: 2 });
  });

  it('repairs a misleading zero counter using known approvers', () => {
    assert.deepEqual(events.resolveMergeRequestApprovals(null, {
      approvals_required: 3, approvals_left: 0, approved_by: [{ user: { username: 'reviewer.one' } }],
    }, {}, 2), { approvalsRequired: 3, approvalsLeft: 2, approvedBy: ['reviewer.one'] });
  });

  it('clamps negative counters without introducing negative approvals left', () => {
    assert.equal(events.resolveMergeRequestApprovals(null, {
      approvals_required: 0, approvals_left: -1, approved_by: [],
    }, {}, 2).approvalsLeft, 0);
  });

  it('returns only approval fields and does not mutate the stored MR or its approve array', () => {
    const copy = structuredClone(previous);
    const next = events.resolveMergeRequestApprovals(previous, undefined, {
      action: 'unapproval', actorUsername: 'tech.lead',
    }, 2);
    assert.deepEqual(previous, copy);
    assert.deepEqual(Object.keys(next).sort(), ['approvalsLeft', 'approvalsRequired', 'approvedBy']);
  });
});

describe('approval event scoring dispatch', () => {
  for (const action of ['approval', 'approved', 'unapproval', 'unapproved']) {
    it(`dispatches ${action} with its actor, current MR and original timestamp`, async () => {
      await events.recordMergeRequestApprovalEvent(previous, previous, {
        action, actorUsername: 'reviewer.one',
      }, true, occurredAt);
      assert.deepEqual(scored, [{
        mr: previous, username: 'reviewer.one', occurredAt,
        kind: action.startsWith('un') ? 'unapproval' : 'approval',
      }]);
    });
  }

  it('reverses only the approvals removed by a verified system reset, ignoring username case', async () => {
    const current = { ...previous, approvedBy: ['tech.lead'] };
    await events.recordMergeRequestApprovalEvent(current, previous, {
      action: 'unapproved', system: true, actorUsername: 'author',
    }, true, occurredAt);
    assert.deepEqual(scored.map(({ kind, username }) => ({ kind, username })), [
      { kind: 'unapproval', username: 'reviewer.one' }, { kind: 'unapproval', username: 'team.lead' },
    ]);
    assert.ok(scored.every((score) => score.mr === scored[0]!.mr && score.occurredAt === occurredAt));
  });

  it('does not reverse scores from an unverifiable system reset during an API outage', async () => {
    await events.recordMergeRequestApprovalEvent({ ...previous, approvedBy: [] }, previous, {
      action: 'unapproved', system: true, actorUsername: 'author',
    }, false, occurredAt);
    assert.deepEqual(scored, []);
  });

  it('does not score ordinary MR updates or approval events without an actor', async () => {
    for (const event of [{ action: 'update', actorUsername: 'author' }, { action: 'approval' }]) {
      await events.recordMergeRequestApprovalEvent(previous, previous, event, true, occurredAt);
    }
    assert.deepEqual(scored, []);
  });
});
