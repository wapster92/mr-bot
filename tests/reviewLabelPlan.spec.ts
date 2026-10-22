import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { UserRecord } from '../src/data/userTypes';
import {
  buildReviewLabelPlan,
  buildPersonalReviewLabel,
  getReviewUrgency,
  MERGE_READY_LABEL,
  REVIEW_OVERDUE_LABELS,
} from '../src/services/reviewLabelPlan';
import { isApprovalNotificationRelevant } from '../src/services/approvalNotifications';

const users: UserRecord[] = [
  { gitlabUsername: 'reviewer.one', name: 'Первый ревьюер' },
  { gitlabUsername: 'reviewer.two', name: 'Второй ревьюер' },
  { gitlabUsername: 'tech.lead', isLead: true, name: 'Техлид' },
  { gitlabUsername: 'team.lead', isLead: true, name: 'Тимлид' },
];
const friday = new Date('2026-10-16T06:00:00Z'); // 09:00 MSK
const monday = new Date('2026-10-19T06:00:00Z');
const tuesday = new Date('2026-10-20T06:00:00Z');
const mr: MergeRequestDocument = {
  projectId: 1, projectPath: 'test', mrId: 1, iid: 1, title: 'Test',
  sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/1',
  author: { gitlabUsername: 'author' }, state: 'opened',
  reviewers: ['reviewer.one', 'reviewer.two'], approvedBy: [],
};

describe('review labels and approval deadlines', () => {
  it('uses only the stored display name for developers and leads', () => {
    for (const isLead of [false, true]) {
      const user = { gitlabUsername: 'sorokina.iv', isLead };
      assert.deepEqual(buildPersonalReviewLabel(user, 'Ирина В. Сорокина', 'normal'), {
        name: 'Ирина В. Сорокина', color: '#428bca',
      });
      assert.deepEqual(buildPersonalReviewLabel(user, 'Ирина В. Сорокина', 'warning'), {
        name: 'Ирина В. Сорокина', color: '#ed9121',
      });
      assert.deepEqual(buildPersonalReviewLabel(user, 'Ирина В. Сорокина', 'danger'), {
        name: 'Ирина В. Сорокина', color: '#d9534f',
      });
    }
  });

  it('falls back to GitLab username without role or account suffix when the name is missing', () => {
    assert.equal(buildPersonalReviewLabel({ gitlabUsername: 'reviewer' }, '  ', 'normal').name, 'reviewer');
    assert.equal(buildPersonalReviewLabel({ gitlabUsername: 'reviewer' }, 'Ирина, Сорокина', 'normal').name, 'Ирина  Сорокина');
  });

  it('shows both reviewers and both leads but starts only reviewer timers initially', () => {
    const plan = buildReviewLabelPlan(mr, users, friday);
    assert.equal(plan.labels.length, 4);
    assert.deepEqual(Object.keys(plan.approvalRequestedAt), ['reviewer.one', 'reviewer.two']);
    assert.ok(plan.labels.every((label) => label.color === '#428bca'));
  });

  it('removes the approving reviewer label and starts timers for both leads', () => {
    const initial = buildReviewLabelPlan(mr, users, friday);
    const plan = buildReviewLabelPlan({
      ...mr, approvalRequestedAt: initial.approvalRequestedAt, approvedBy: ['REVIEWER.ONE'],
    }, users, monday);
    assert.equal(plan.labels.length, 4);
    assert.ok(plan.labels.every((label) => !label.name.includes('Первый ревьюер')));
    assert.equal(plan.approvalRequestedAt['tech.lead'], monday);
    assert.equal(plan.approvalRequestedAt['team.lead'], monday);
    assert.equal(plan.approvalRequestedAt['reviewer.two'], friday);
    assert.equal(plan.labels.find((label) => label.name === 'Второй ревьюер')?.color, '#ed9121');
    assert.ok(plan.labels.includes(REVIEW_OVERDUE_LABELS.warning));
    assert.equal(plan.labels.find((label) => label.name === 'Техлид')?.color, '#428bca');
  });

  it('keeps the other lead label after one lead approves and replaces all labels only when complete', () => {
    const partiallyApproved = { ...mr, approvedBy: ['reviewer.one', 'tech.lead'] };
    const plan = buildReviewLabelPlan(partiallyApproved, users, monday);
    assert.equal(plan.labels.length, 2);
    assert.ok(plan.labels.some((label) => label.name === 'Тимлид'));
    assert.ok(plan.labels.every((label) => label.name !== 'Техлид'));
    const ready = buildReviewLabelPlan({
      ...partiallyApproved, approvedBy: [...partiallyApproved.approvedBy, 'team.lead'],
    }, users, monday);
    assert.deepEqual(ready.labels, [MERGE_READY_LABEL]);
    assert.deepEqual(ready.approvalRequestedAt, {});
  });

  it('restores labels after unapproval and restarts the missing lead timer', () => {
    const plan = buildReviewLabelPlan({
      ...mr, approvedBy: ['reviewer.one', 'tech.lead'], approvalRequestedAt: {},
    }, users, tuesday);
    assert.ok(plan.labels.some((label) => label.name === 'Тимлид'));
    assert.ok(!plan.labels.some((label) => label.name === MERGE_READY_LABEL.name));
    assert.equal(plan.approvalRequestedAt['team.lead'], tuesday);
  });

  it('does not display or require the author lead label', () => {
    const authorLead = { ...mr, author: { gitlabUsername: 'tech.lead' } };
    assert.equal(buildReviewLabelPlan(authorLead, users, friday).labels.length, 3);
    assert.deepEqual(buildReviewLabelPlan({
      ...authorLead, approvedBy: ['reviewer.two', 'team.lead'],
    }, users, monday).labels, [MERGE_READY_LABEL]);
  });

  it('counts only working hours: orange after one day, red after two; weekends add no delay', () => {
    const user = users[0]!;
    assert.equal(getReviewUrgency(user, friday, new Date('2026-10-16T14:45:00Z')), 'normal');
    assert.equal(getReviewUrgency(user, friday, monday), 'warning');
    assert.equal(getReviewUrgency(user, friday, tuesday), 'danger');
    const fridayEnd = new Date('2026-10-16T15:00:00Z');
    assert.equal(getReviewUrgency(user, fridayEnd, monday), 'normal');
  });

  it('keeps the same timers on repeated sync and clears them for Draft and closed MRs', () => {
    const initial = buildReviewLabelPlan(mr, users, friday);
    const repeated = buildReviewLabelPlan({ ...mr, approvalRequestedAt: initial.approvalRequestedAt }, users, friday);
    assert.deepEqual(repeated, initial);
    for (const update of [{ isDraft: true }, { state: 'closed' }, { state: 'merged' }]) {
      assert.deepEqual(buildReviewLabelPlan({ ...mr, ...update }, users, monday), {
        labels: [], approvalRequestedAt: {},
      });
    }
  });

  it('ignores inactive users and does not treat a comment as an approval', () => {
    const plan = buildReviewLabelPlan(mr, users.map((user) =>
      user.gitlabUsername === 'reviewer.one' ? { ...user, isActive: false } : user,
    ), friday);
    assert.equal(plan.labels.length, 3);
    assert.ok(plan.labels.some((label) => label.name === 'Второй ревьюер'));
    assert.ok(!plan.labels.some((label) => label.name === MERGE_READY_LABEL.name));
  });

  it('keeps a mandatory commenter label after the other assigned reviewer and leads approve', () => {
    const plan = buildReviewLabelPlan({ ...mr,
      reviewCommenters: ['reviewer.two'], approvedBy: ['reviewer.one', 'tech.lead', 'team.lead'],
    }, users, friday);
    assert.deepEqual(plan.labels.map((label) => label.name), ['Второй ревьюер']);
  });

  it('shows a volunteer with short name and urgency, without adding them to the assigned pair', () => {
    const volunteer = { gitlabUsername: 'volunteer', name: 'Ирина В. Сорокина', isReviewer: false };
    const doc = { ...mr, reviewCommenters: ['volunteer'],
      approvedBy: ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'],
      approvalRequestedAt: { volunteer: friday },
    };
    const plan = buildReviewLabelPlan(doc, [...users, volunteer, volunteer], monday);
    assert.deepEqual(plan.labels, [
      { name: 'Ирина В. Сорокина', color: '#ed9121' }, REVIEW_OVERDUE_LABELS.warning,
    ]);
    assert.deepEqual(doc.reviewers, ['reviewer.one', 'reviewer.two']);
    assert.deepEqual(buildReviewLabelPlan({ ...doc, approvedBy: [...doc.approvedBy, 'volunteer'] },
      [...users, volunteer], monday).labels, [MERGE_READY_LABEL]);
  });

  it('does not hold readiness for unavailable volunteers or the author', () => {
    const doc = { ...mr, reviewCommenters: ['volunteer', 'author'],
      approvedBy: ['reviewer.one', 'tech.lead', 'team.lead'] };
    assert.deepEqual(buildReviewLabelPlan(doc, [...users,
      { gitlabUsername: 'volunteer', isActive: false }, { gitlabUsername: 'author' },
    ], monday).labels, [MERGE_READY_LABEL]);
  });
});

describe('queued final-review notifications', () => {
  const leads = new Set(['tech.lead', 'team.lead']);
  const reviewers = new Set(['reviewer.one', 'reviewer.two']);
  const pending = { ...mr, approvedBy: ['reviewer.one', 'tech.lead'] };
  it('cancels only the approving lead notification and keeps the second lead notification', () => {
    assert.equal(isApprovalNotificationRelevant('mr_final_review', pending, 'tech.lead', leads, reviewers), false);
    assert.equal(isApprovalNotificationRelevant('mr_final_review', pending, 'team.lead', leads, reviewers), true);
    assert.equal(isApprovalNotificationRelevant('mr_ready_to_merge', pending, 'author', leads, reviewers), false);
  });
  it('cancels stale notifications for Draft, closed, unmapped and unapproved MRs', () => {
    for (const candidate of [null, { ...pending, isDraft: true }, { ...pending, state: 'merged' }, mr]) {
      assert.equal(isApprovalNotificationRelevant('mr_final_review', candidate, 'team.lead', leads, reviewers), false);
    }
  });
  it('does not notify an author lead about their own final review', () => {
    assert.equal(isApprovalNotificationRelevant('mr_final_review', {
      ...mr, author: { gitlabUsername: 'tech.lead' }, approvedBy: ['reviewer.one'],
    }, 'tech.lead', leads, reviewers), false);
  });

  it('cancels merge-ready for a pending volunteer but keeps the lead invitation relevant', () => {
    const doc = { ...pending, reviewCommenters: ['volunteer'] };
    assert.equal(isApprovalNotificationRelevant('mr_ready_to_merge', doc, 'author', leads, reviewers,
      new Set([...reviewers, ...leads, 'volunteer'])), false);
    assert.equal(isApprovalNotificationRelevant('mr_final_review', doc, 'team.lead', leads, reviewers,
      new Set([...reviewers, ...leads, 'volunteer'])), true);
  });
});
