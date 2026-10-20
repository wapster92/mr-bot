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

  const commentedMr = {
    author: { gitlabUsername: 'author' }, reviewers: ['developer.one', 'developer.two'],
    approvedBy: ['developer.two', 'tech.lead', 'team.lead'], reviewCommenters: ['developer.one'],
  };
  const developers = new Set(['developer.one', 'developer.two']);
  const participants = new Set([...developers, ...leads, 'volunteer', 'author.only', 'author']);

  it('requires the commenting assignee even when the other reviewer and both leads approved', () => {
    const summary = summarizeMergeRequestApprovals(commentedMr, leads, developers, participants);
    assert.deepEqual(summary.pendingCommenterUsernames, ['developer.one']);
    assert.equal(hasRequiredMergeApprovals(summary), false);
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...commentedMr, approvedBy: [...commentedMr.approvedBy, 'DEVELOPER.ONE'],
    }, leads, developers, participants)), true);
  });

  it('requires every active voluntary commenter, including author-only users', () => {
    const mr = { ...commentedMr, reviewCommenters: ['VOLUNTEER', 'author.only', 'volunteer'] };
    const summary = summarizeMergeRequestApprovals(mr, leads, developers, participants);
    assert.deepEqual(summary.requiredCommenterUsernames, ['volunteer', 'author.only']);
    assert.equal(hasRequiredMergeApprovals(summary), false);
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...mr, approvedBy: [...mr.approvedBy, 'volunteer', 'AUTHOR.ONLY'],
    }, leads, developers, participants)), true);
  });

  it('does not substitute a volunteer approval for the required assigned developer', () => {
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...commentedMr, reviewCommenters: ['volunteer'], approvedBy: ['volunteer', ...leads],
    }, leads, developers, participants)), false);
  });

  it('exempts the author, unavailable users and unknown accounts from commenter obligations', () => {
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...commentedMr, reviewCommenters: ['author', 'on.vacation', 'blocked', 'removed', 'unknown'],
    }, leads, developers, participants)), true);
  });

  it('keeps the author-lead exemption even if the author commented', () => {
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...commentedMr, author: { gitlabUsername: 'tech.lead' }, reviewCommenters: ['TECH.LEAD'],
      approvedBy: ['developer.two', 'team.lead'],
    }, leads, developers, participants)), true);
  });

  it('still invites leads after one developer approve while other commenters are pending', () => {
    const summary = summarizeMergeRequestApprovals({ ...commentedMr, approvedBy: ['developer.two'] }, leads, developers, participants);
    assert.equal(needsLeadReview(summary), true);
    assert.equal(hasRequiredMergeApprovals(summary), false);
  });

  it('restores the obligation after an approve is reset', () => {
    const mr = { ...commentedMr, reviewCommenters: ['volunteer'] };
    assert.deepEqual(summarizeMergeRequestApprovals(mr, leads, developers, participants).pendingCommenterUsernames, ['volunteer']);
  });

  it('does not confirm readiness until an unavailable comment history has been checked', () => {
    assert.equal(hasRequiredMergeApprovals(summarizeMergeRequestApprovals({
      ...commentedMr, reviewCommenters: [], reviewCommentHistorySyncPending: true,
    }, leads, developers, participants)), false);
  });
});
