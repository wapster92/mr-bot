import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import {
  getReviewResponseDueSince, isWaitingForAuthor, recordReviewCodeUpdate, recordReviewCommentActivity,
} from '../src/services/reviewResponsibility';
import {
  buildProjectPersonalReviewLabels, buildReviewLabelPlan, REVIEW_OVERDUE_LABELS, URGENCY_COLORS,
} from '../src/services/reviewLabelPlan';

const assignedAt = new Date('2026-10-21T08:54:00.907Z');
const pushedAt = new Date('2026-10-22T13:59:07.260Z');
const beforePush = new Date('2026-10-22T10:55:52.584Z');
const afterPush = new Date('2026-10-22T15:12:25.516Z');
const nextDay = new Date('2026-10-23T13:59:08Z');
const users = [
  { gitlabUsername: 'zolotov.aa', name: 'Антон А. Золотов' },
  { gitlabUsername: 'nasirov.ef', name: 'Эрик Ф. Насиров' },
  { gitlabUsername: 'tech.lead', name: 'Техлид', isLead: true },
  { gitlabUsername: 'team.lead', name: 'Тимлид', isLead: true },
];
const example = (): MergeRequestDocument => ({
  projectId: 112, projectPath: 'cit/srm2/frontend', mrId: 1, iid: 1636, title: 'MR example',
  sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/1636',
  author: { gitlabUsername: 'author' }, state: 'opened',
  reviewers: ['zolotov.aa', 'nasirov.ef'], approvedBy: [],
  approvalRequestedAt: { 'zolotov.aa': assignedAt, 'nasirov.ef': assignedAt },
  reviewCommenters: ['zolotov.aa', 'nasirov.ef'],
  reviewCommentedAt: { 'zolotov.aa': afterPush, 'nasirov.ef': beforePush },
  reviewCodeUpdatedAt: pushedAt, reviewCodeHeadSha: 'current',
});

describe('review responsibility and urgency', () => {
  it('reproduces MR !1636: Anton waits for its author; Erik must check the new code', () => {
    const mr = example();
    assert.equal(isWaitingForAuthor(mr, 'ZOLOTOV.AA'), true);
    assert.equal(isWaitingForAuthor(mr, 'nasirov.ef'), false);
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', assignedAt), undefined);
    assert.equal(getReviewResponseDueSince(mr, 'nasirov.ef', assignedAt), pushedAt);
    const plan = buildReviewLabelPlan(mr, users, nextDay);
    assert.equal(plan.labels.find((label) => label.name === users[0]!.name)?.color, URGENCY_COLORS.normal);
    assert.equal(plan.labels.find((label) => label.name === users[1]!.name)?.color, URGENCY_COLORS.warning);
    assert.ok(plan.labels.includes(REVIEW_OVERDUE_LABELS.warning));
    assert.deepEqual(plan.approvalRequestedAt, mr.approvalRequestedAt);
  });

  it('does not color reviewers overdue immediately after an author update just because the MR is old', () => {
    const mr = example();
    const plan = buildReviewLabelPlan(mr, users, new Date(pushedAt.getTime() + 60_000));
    assert.ok(plan.labels.every((label) => label.color === URGENCY_COLORS.normal));
  });

  it('returns responsibility to all pending reviewers after an author reply, without a commit', () => {
    const mr = example();
    const replyAt = new Date('2026-10-23T06:00:00Z');
    Object.assign(mr, recordReviewCommentActivity(mr, 'AUTHOR', replyAt));
    for (const user of users.slice(0, 2)) {
      assert.equal(isWaitingForAuthor(mr, user.gitlabUsername), false);
      assert.equal(getReviewResponseDueSince(mr, user.gitlabUsername, assignedAt), replyAt);
    }
    assert.ok(buildReviewLabelPlan(mr, users, replyAt).labels.every((label) => label.color === URGENCY_COLORS.normal));
  });

  it('a reviewer reply pauses only that reviewer, not everyone else', () => {
    const mr = example(); const authorReply = new Date('2026-10-23T06:00:00Z');
    Object.assign(mr, recordReviewCommentActivity(mr, 'author', authorReply));
    Object.assign(mr, recordReviewCommentActivity(mr, 'nasirov.ef', new Date('2026-10-23T07:00:00Z')));
    assert.equal(isWaitingForAuthor(mr, 'nasirov.ef'), true);
    assert.equal(isWaitingForAuthor(mr, 'zolotov.aa'), false);
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', assignedAt), authorReply);
  });

  it('a subsequent push starts another fresh review turn for everyone still pending', () => {
    const mr = example(); const push = new Date('2026-10-23T08:00:00Z');
    Object.assign(mr, recordReviewCodeUpdate(mr, 'next-head', push));
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', assignedAt), push);
    assert.equal(getReviewResponseDueSince(mr, 'nasirov.ef', assignedAt), push);
  });

  it('preserves the original initial timer and the lead-invitation gate', () => {
    const mr = { ...example(), reviewCommenters: [], reviewCommentedAt: {} };
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', assignedAt), pushedAt);
    assert.equal(getReviewResponseDueSince(mr, 'tech.lead', undefined), undefined);
    const newlyAssigned = new Date('2026-10-23T06:00:00Z');
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', newlyAssigned), newlyAssigned);
  });

  it('does not charge a legacy commenter for silence when their response time is unknown', () => {
    const mr = example(); delete mr.reviewCommentedAt;
    assert.equal(getReviewResponseDueSince(mr, 'zolotov.aa', assignedAt), undefined);
  });

  it('keeps the required approve even while waiting for the author', () => {
    const mr = example(); mr.approvedBy = ['nasirov.ef', 'tech.lead', 'team.lead'];
    const plan = buildReviewLabelPlan(mr, users, nextDay);
    assert.deepEqual(plan.labels, [{ name: users[0]!.name, color: URGENCY_COLORS.normal }]);
  });

  it('still uses another overdue MR for the shared personal color, not this MR status', () => {
    const mr = example(); const other = { ...example(), iid: 1637,
      reviewCommenters: [], reviewCommentedAt: {}, reviewCodeUpdatedAt: assignedAt };
    const labels = buildProjectPersonalReviewLabels([mr, other], users, nextDay);
    assert.equal(labels.find((label) => label.name === users[0]!.name)?.color, URGENCY_COLORS.danger);
    assert.equal(buildReviewLabelPlan(mr, users, nextDay).labels
      .find((label) => label.name === users[0]!.name)?.color, URGENCY_COLORS.normal);
  });

  it('ignores duplicate and out-of-order activity rather than restarting turns', () => {
    const mr = example();
    assert.deepEqual(recordReviewCommentActivity(mr, 'zolotov.aa', beforePush), {});
    assert.deepEqual(recordReviewCodeUpdate(mr, 'current', nextDay), {});
    assert.deepEqual(recordReviewCodeUpdate(mr, 'old-head', assignedAt), {});
    Object.assign(mr, recordReviewCommentActivity(mr, 'author', nextDay));
    assert.deepEqual(recordReviewCommentActivity(mr, 'author', pushedAt), {});
    assert.deepEqual(recordReviewCodeUpdate(mr, 'next', new Date('invalid')), {});
    assert.deepEqual(recordReviewCommentActivity(mr, 'author', new Date('invalid')), {});
  });

  it('does not count weekends in a newly handed-off review turn', () => {
    const mr = example(); const friday = new Date('2026-10-23T14:00:00Z');
    Object.assign(mr, recordReviewCodeUpdate(mr, 'friday-head', friday));
    assert.ok(buildReviewLabelPlan(mr, users, new Date('2026-10-26T06:00:00Z')).labels
      .every((label) => label.color === URGENCY_COLORS.normal));
  });
});

let history: typeof import('../src/services/reviewCommentHistory');
let notes: Array<{ authorUsername: string; createdAt?: string; system: boolean }> | undefined;
let diff: { createdAt?: string; headSha?: string } | undefined;
let noteReads = 0;
let diffReads = 0;
before(() => {
  const path = require.resolve('../src/gitlab/api.ts');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: {
    fetchMergeRequestNotes: async () => { noteReads += 1; return notes; },
    fetchMergeRequestLatestDiff: async () => { diffReads += 1; return diff; },
  } } as NodeJS.Module;
  history = require('../src/services/reviewCommentHistory.ts');
});
beforeEach(() => {
  noteReads = 0; diffReads = 0;
  notes = [
    { authorUsername: 'ZOLOTOV.AA', createdAt: afterPush.toISOString(), system: false },
    { authorUsername: 'zolotov.aa', createdAt: assignedAt.toISOString(), system: false },
    { authorUsername: 'nasirov.ef', createdAt: beforePush.toISOString(), system: false },
    { authorUsername: 'author', createdAt: nextDay.toISOString(), system: true },
  ];
  diff = { createdAt: pushedAt.toISOString(), headSha: 'current' };
});

describe('timed review history recovery', () => {
  it('backfills activity even when the old commenter-list cache is fresh', async () => {
    const mr = example(); delete mr.reviewCommentedAt; delete mr.reviewCodeUpdatedAt; delete mr.reviewCodeHeadSha;
    mr.reviewCommentRequirementsSyncedAt = new Date();
    Object.assign(mr, await history.loadReviewCommentHistory(mr));
    assert.deepEqual(mr.reviewCommentedAt, { 'zolotov.aa': afterPush, 'nasirov.ef': beforePush });
    assert.equal(mr.reviewAuthorCommentedAt, undefined);
    assert.deepEqual(mr.reviewCodeUpdatedAt, pushedAt);
    assert.ok(mr.reviewActivitySyncedAt);
    await history.loadReviewCommentHistory(mr, { headSha: 'current' });
    assert.equal(noteReads, 1); assert.equal(diffReads, 1);
  });

  it('forces refresh for a new code HEAD but not for label/status updated_at changes', async () => {
    const mr = example(); Object.assign(mr, await history.loadReviewCommentHistory(mr));
    mr.updatedAt = new Date();
    assert.deepEqual(await history.loadReviewCommentHistory(mr, { headSha: 'current' }), {});
    diff = { createdAt: nextDay.toISOString(), headSha: 'next-head' };
    const update = await history.loadReviewCommentHistory(mr, { headSha: 'next-head' });
    assert.deepEqual(update.reviewCodeUpdatedAt, nextDay);
    assert.equal(noteReads, 2); assert.equal(diffReads, 2);
  });

  it('recovers author replies and never regresses newer webhook timestamps', async () => {
    const mr = example(); mr.reviewAuthorCommentedAt = nextDay;
    notes!.push({ authorUsername: 'author', createdAt: pushedAt.toISOString(), system: false });
    Object.assign(mr, await history.loadReviewCommentHistory(mr));
    assert.equal(mr.reviewAuthorCommentedAt, nextDay);
    assert.deepEqual(mr.reviewCommentedAt!['zolotov.aa'], afterPush);
  });

  it('does not make missing diff metadata a false failure of mandatory comment history', async () => {
    const mr = example(); diff = undefined;
    const update = await history.loadReviewCommentHistory(mr);
    assert.equal(update.reviewActivitySyncPending, true);
    assert.equal(update.reviewCommentHistorySyncPending, false);
    assert.equal(update.reviewCodeUpdatedAt, undefined);
  });

  it('bounds retries after API failures and recovers without inventing response dates', async (t) => {
    const clock = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: clock });
    const mr = example(); notes = undefined; diff = undefined;
    Object.assign(mr, await history.loadReviewCommentHistory(mr));
    assert.equal(mr.reviewCommentHistorySyncPending, true);
    assert.deepEqual(mr.reviewCommentedAt!['zolotov.aa'], afterPush);
    assert.deepEqual(await history.loadReviewCommentHistory(mr), {});
    assert.equal(noteReads, 1); assert.equal(diffReads, 1);
    notes = []; diff = { createdAt: pushedAt.toISOString(), headSha: 'current' };
    t.mock.timers.setTime(clock + 121_000);
    Object.assign(mr, await history.loadReviewCommentHistory(mr));
    assert.equal(mr.reviewActivitySyncPending, false);
    assert.equal(noteReads, 2); assert.equal(diffReads, 2);
  });

  it('does not load diff versions during the terminal merge audit', async () => {
    const mr = { ...example(), state: 'merged' };
    await history.loadReviewCommentHistory(mr, { mergeAudit: true });
    assert.equal(noteReads, 1); assert.equal(diffReads, 0);
  });

  it('throttles refreshes while GitLab has not yet produced the expected new diff version', async () => {
    const mr = example();
    Object.assign(mr, await history.loadReviewCommentHistory(mr, { headSha: 'not-yet-collected' }));
    assert.equal(mr.reviewActivitySyncPending, true);
    assert.equal(mr.reviewCommentHistorySyncPending, false);
    assert.deepEqual(await history.loadReviewCommentHistory(mr, { headSha: 'not-yet-collected' }), {});
    assert.equal(noteReads, 1); assert.equal(diffReads, 1);
  });
});
