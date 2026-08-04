import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasLeadApproval,
  hasRequiredMergeApprovals,
  needsLeadReview,
  summarizeApprovals,
} from '../src/services/approvalPolicy';

describe('approval policy', () => {
  const leads = new Set(['tech.lead', 'team.lead']);

  it('requests lead review after the first developer approve', () => {
    const summary = summarizeApprovals(['developer.one'], leads);
    assert.equal(needsLeadReview(summary), true);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('allows merge after one developer and one lead approve', () => {
    const summary = summarizeApprovals(
      ['developer.one', 'TECH.LEAD'],
      leads,
    );
    assert.equal(needsLeadReview(summary), false);
    assert.equal(hasLeadApproval(summary), true);
    assert.equal(hasRequiredMergeApprovals(summary), true);
  });

  it('does not request another lead review after any lead approve', () => {
    const summary = summarizeApprovals(
      ['developer.one', 'tech.lead', 'developer.two'],
      leads,
    );
    assert.equal(needsLeadReview(summary), false);
  });

  it('does not treat a lead approve without developer review as merge-ready', () => {
    const summary = summarizeApprovals(['team.lead'], leads);
    assert.equal(needsLeadReview(summary), false);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });
});
