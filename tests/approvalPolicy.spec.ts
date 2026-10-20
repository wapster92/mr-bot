import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasRequiredMergeApprovals,
  needsLeadReview,
  summarizeApprovals,
  summarizeMergeRequestApprovals,
} from '../src/services/approvalPolicy';

describe('approval policy', () => {
  const leads = new Set(['tech.lead', 'team.lead']);

  it('requests lead review after the first developer approve', () => {
    const summary = summarizeApprovals(['developer.one'], leads);
    assert.equal(needsLeadReview(summary), true);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('allows merge only after one developer and both leads approve', () => {
    const summary = summarizeApprovals(
      ['developer.one', 'TECH.LEAD', 'team.lead'],
      leads,
    );
    assert.equal(needsLeadReview(summary), false);
    assert.equal(hasRequiredMergeApprovals(summary), true);
  });

  it('continues requesting review from the second lead after the first lead approves', () => {
    const summary = summarizeApprovals(
      ['developer.one', 'tech.lead', 'developer.two'],
      leads,
    );
    assert.equal(needsLeadReview(summary), true);
    assert.deepEqual(summary.pendingLeadUsernames, ['team.lead']);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('does not treat a lead approve without developer review as merge-ready', () => {
    const summary = summarizeApprovals(['team.lead'], leads);
    assert.equal(needsLeadReview(summary), false);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('does not count an approve from a user excluded from reviews', () => {
    const summary = summarizeApprovals(
      ['author.only', 'tech.lead'],
      leads,
      new Set(['developer.one']),
    );
    assert.equal(needsLeadReview(summary), false);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('exempts the author lead from self-approval', () => {
    const summary = summarizeApprovals(
      ['developer.one', 'TEAM.LEAD'], leads, new Set(['developer.one']), 'TECH.LEAD',
    );
    assert.equal(summary.requiredLeadCount, 1);
    assert.deepEqual(summary.pendingLeadUsernames, []);
    assert.equal(hasRequiredMergeApprovals(summary), true);
  });

  it('does not reduce the two-lead requirement if a lead is unavailable', () => {
    assert.equal(hasRequiredMergeApprovals(
      summarizeApprovals(['developer.one', 'tech.lead'], new Set(['tech.lead'])),
    ), false);
    assert.equal(hasRequiredMergeApprovals(
      summarizeApprovals(['developer.one'], new Set()),
    ), false);
  });

  it('counts only an active assigned reviewer and ignores author self-approval', () => {
    const mr = {
      author: { gitlabUsername: 'author' },
      reviewers: ['developer.one', 'developer.two'],
      approvedBy: ['outsider', 'author', 'tech.lead', 'team.lead'],
    };
    const active = new Set(['developer.one', 'outsider', 'author']);
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals(mr, leads, active)), false);
    mr.approvedBy.push('DEVELOPER.ONE');
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals(mr, leads, active)), true);
    mr.approvedBy = ['developer.two', 'tech.lead', 'team.lead'];
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals(mr, leads, active)), false);
  });
});
