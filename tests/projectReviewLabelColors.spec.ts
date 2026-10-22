import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { UserRecord } from '../src/data/userTypes';
import {
  buildProjectPersonalReviewLabels, buildReviewLabelPlan, MERGE_READY_LABEL,
  REVIEW_OVERDUE_LABELS, URGENCY_COLORS, type ReviewLabel,
} from '../src/services/reviewLabelPlan';

const friday = new Date('2026-10-16T06:00:00Z');
const monday = new Date('2026-10-19T06:00:00Z');
const tuesday = new Date('2026-10-20T06:00:00Z');
let now: Date;
let projectId = 1000;
let users: UserRecord[];
let mrs: MergeRequestDocument[];
type Definition = ReviewLabel & { id: number; isProjectLabel: boolean };
let definitions: Map<string, Definition>;
let mrLabels: Map<number, string[]>;
let definitionAttempts: ReviewLabel[];
let mrWrites: string[][];
let failColor: boolean;
let definitionReads: number;
let assignment: typeof import('../src/services/reviewerAssignment');
let service: typeof import('../src/services/projectReviewLabelColors');
let sync: typeof import('../src/services/reviewerLabelSync');

const makeMr = (iid: number, requestedAt = tuesday): MergeRequestDocument => ({
  projectId, projectPath: 'test/project', mrId: iid, iid, title: 'Test',
  sourceBranch: `feature-${iid}`, targetBranch: 'main', url: `https://gitlab.example/mr/${iid}`,
  author: { gitlabUsername: 'author' }, state: 'opened',
  reviewers: ['reviewer.one', 'reviewer.two'], approvedBy: [],
  reviewerLabels: users.slice(0, 4).map((user) => user.name!),
  approvalRequestedAt: { 'reviewer.one': requestedAt, 'reviewer.two': tuesday },
});

const mockModule = (relative: string, exports: unknown): void => {
  const path = require.resolve(relative);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

before(() => {
  mockModule('../src/config.ts', {
    config: { gitlab: { api: { baseUrl: 'https://gitlab.example', token: 'test', allowedProjectIds: [] } } },
  });
  mockModule('../src/data/mergeRequestRepository.ts', {
    listProjectIds: async () => [projectId],
    listOpenMergeRequests: async () => structuredClone(mrs.filter((mr) =>
      !['closed', 'merged'].includes(mr.state ?? '') || mr.reviewerLabelsCleanupPending,
    )),
  });
  mockModule('../src/data/userStore.ts', {
    listUsersForReviewLabels: async () => structuredClone(users),
    listLeadUsers: async () => users.filter((user) => user.isLead && user.isAllowed !== false && user.isActive !== false),
    getUserByGitlabUsername: async (name: string) => users.find((user) =>
      user.gitlabUsername.toLowerCase() === name.toLowerCase() && user.isAllowed !== false),
  });
  mockModule('../src/data/reviewerQueue.ts', { pullReviewers: async () => [] });
  mockModule('../src/gitlab/api.ts', {
    fetchProjectMergeRequests: async () => [],
    fetchProjectLabels: async () => { definitionReads += 1; return [...definitions.values()]; },
    ensureProjectLabel: async (_projectId: number, label: ReviewLabel, existing?: Definition) => {
      definitionAttempts.push({ ...label });
      if (failColor && existing && label.name === 'Первый ревьюер') return undefined;
      const definition = { ...label, id: existing?.id ?? definitions.size + 1, isProjectLabel: true };
      definitions.set(label.name, definition);
      return definition;
    },
    updateMergeRequestLabels: async (_projectId: number, iid: number, labels: string[]) => {
      mrWrites.push([...labels]); mrLabels.set(iid, [...labels]); return true;
    },
  });
  assignment = require('../src/services/reviewerAssignment.ts');
  service = require('../src/services/projectReviewLabelColors.ts');
  sync = require('../src/services/reviewerLabelSync.ts');
});

beforeEach(() => {
  projectId += 1; now = new Date(tuesday);
  users = [
    { gitlabUsername: 'reviewer.one', name: 'Первый ревьюер' },
    { gitlabUsername: 'reviewer.two', name: 'Второй ревьюер' },
    { gitlabUsername: 'tech.lead', name: 'Техлид', isLead: true },
    { gitlabUsername: 'team.lead', name: 'Тимлид', isLead: true },
    { gitlabUsername: 'volunteer', name: 'Доброволец', isReviewer: false },
  ];
  mrs = [makeMr(1, friday), makeMr(2)];
  definitions = new Map(users.slice(0, 4).map((user, index) => [user.name!, {
    id: index + 1, name: user.name!, color: URGENCY_COLORS.normal, isProjectLabel: true,
  }]));
  mrLabels = new Map(mrs.map((mr) => [mr.iid, ['bug', ...mr.reviewerLabels!]]));
  definitionAttempts = []; mrWrites = []; failColor = false; definitionReads = 0;
});

const projectColors = (): Map<string, string> => new Map(
  buildProjectPersonalReviewLabels(mrs, users, now).map((label) => [label.name, label.color]),
);

describe('stable personal labels and per-MR overdue status', () => {
  it('uses maximum personal urgency regardless of MR iteration order', () => {
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.danger);
    assert.equal(projectColors().get('Второй ревьюер'), URGENCY_COLORS.normal);
    const expected = projectColors(); mrs.reverse();
    assert.deepEqual(projectColors(), expected);
  });

  it('keeps names filterable at every urgency and adds status only to the late MR', () => {
    const overdue = buildReviewLabelPlan(mrs[0]!, users, now).labels;
    const fresh = buildReviewLabelPlan(mrs[1]!, users, now).labels;
    assert.ok(overdue.some((label) => label.name === 'Первый ревьюер'));
    assert.ok(fresh.some((label) => label.name === 'Первый ревьюер'));
    assert.ok(overdue.includes(REVIEW_OVERDUE_LABELS.danger));
    assert.ok(!fresh.some((label) => label.name.startsWith('Ревью:')));
    assert.ok(overdue.every((label) => !/[⚠🚨]/u.test(label.name)));
  });

  it('adds exactly one orange status for one working day and only red for two days', () => {
    const doc = makeMr(3, friday);
    assert.deepEqual(buildReviewLabelPlan(doc, users, monday).labels.filter((label) => label.name.startsWith('Ревью:')),
      [REVIEW_OVERDUE_LABELS.warning]);
    assert.deepEqual(buildReviewLabelPlan(doc, users, tuesday).labels.filter((label) => label.name.startsWith('Ревью:')),
      [REVIEW_OVERDUE_LABELS.danger]);
  });

  for (const change of [{ state: 'closed' }, { state: 'merged' }, { isDraft: true }, { approvedBy: ['reviewer.one'] }]) {
    it(`drops completed obligations from personal urgency: ${JSON.stringify(change)}`, () => {
      mrs[0] = { ...mrs[0]!, ...change };
      assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.normal);
    });
  }

  it('ignores the optional second review after all required approvals are present', () => {
    mrs[0]!.approvedBy = ['reviewer.two', 'tech.lead', 'team.lead'];
    assert.deepEqual(buildReviewLabelPlan(mrs[0]!, users, now).labels, [MERGE_READY_LABEL]);
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.normal);
  });

  it('includes mandatory volunteers without assigning them to the reviewer pair', () => {
    Object.assign(mrs[0]!, { reviewCommenters: ['volunteer'],
      approvedBy: ['reviewer.one', 'tech.lead', 'team.lead'],
      approvalRequestedAt: { volunteer: friday }, reviewCodeUpdatedAt: friday,
      reviewCommentedAt: { volunteer: new Date(friday.getTime() - 60_000) } });
    assert.equal(projectColors().get('Доброволец'), URGENCY_COLORS.danger);
    assert.deepEqual(mrs[0]!.reviewers, ['reviewer.one', 'reviewer.two']);
    mrs[0]!.approvedBy!.push('volunteer');
    assert.equal(projectColors().get('Доброволец'), URGENCY_COLORS.normal);
  });

  it('falls back from red to orange, then blue as the oldest pending reviews are approved', () => {
    mrs[1]!.approvalRequestedAt!['reviewer.one'] = monday;
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.danger);
    mrs[0]!.approvedBy = ['reviewer.one'];
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.warning);
    mrs[1]!.approvedBy = ['reviewer.one'];
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.normal);
  });

  it('starts lead urgency only after a developer approval, using the lead timer', () => {
    mrs[0]!.approvalRequestedAt!['tech.lead'] = friday;
    assert.equal(projectColors().get('Техлид'), URGENCY_COLORS.normal);
    mrs[0]!.approvedBy = ['reviewer.one'];
    assert.equal(projectColors().get('Техлид'), URGENCY_COLORS.danger);
  });

  it('does not color paused, forbidden or author-lead obligations as overdue', () => {
    users[0]!.isActive = false; users[1]!.isAllowed = false;
    mrs[0]!.author.gitlabUsername = 'tech.lead';
    mrs[0]!.approvedBy = ['reviewer.one']; mrs[0]!.approvalRequestedAt!['tech.lead'] = friday;
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.normal);
    assert.equal(projectColors().get('Второй ревьюер'), URGENCY_COLORS.normal);
    assert.equal(projectColors().get('Техлид'), URGENCY_COLORS.normal);
  });

  it('aggregates different accounts sharing one display name without competing colors', () => {
    users[1]!.name = users[0]!.name;
    const labels = buildProjectPersonalReviewLabels(mrs, users, now);
    assert.equal(labels.filter((label) => label.name === 'Первый ревьюер').length, 1);
    assert.equal(projectColors().get('Первый ревьюер'), URGENCY_COLORS.danger);
  });
});

const reconcile = async (iid: number): Promise<void> => {
  const mr = mrs.find((item) => item.iid === iid)!;
  const result = await assignment.reconcileReviewersForMr(mr, mrLabels.get(iid), now);
  assert.equal(result.labelsSyncOk, true);
  Object.assign(mr, { reviewers: result.reviewers, reviewerLabels: result.reviewerLabels,
    approvalRequestedAt: result.approvalRequestedAt });
  await service.refreshProjectReviewLabelColors(projectId, now);
};

describe('project-wide color synchronization', () => {
  it('keeps one red project label across normal/overdue MRs without repeat writes', async () => {
    await reconcile(1); await reconcile(2);
    for (let i = 0; i < 10; i += 1) { await reconcile(2); await reconcile(1); }
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.danger);
    assert.equal(definitionAttempts.filter((label) => label.name === 'Первый ревьюер').length, 1);
    assert.equal(definitionReads, 1);
    assert.equal(mrWrites.length, 1);
    assert.ok(mrLabels.get(1)!.includes(REVIEW_OVERDUE_LABELS.danger.name));
    assert.ok(!mrLabels.get(2)!.includes(REVIEW_OVERDUE_LABELS.danger.name));
    assert.ok(mrLabels.get(1)!.includes('bug'));
    assert.ok(mrLabels.get(2)!.includes('Первый ревьюер'));
  });

  it('resets color after the last overdue approval and removes MR status when ready', async (t) => {
    let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
    await reconcile(1);
    clock += 121_000; now = new Date(tuesday.getTime() + 121_000);
    mrs[0]!.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead'];
    await reconcile(1);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.normal);
    assert.deepEqual(mrLabels.get(1), ['bug', MERGE_READY_LABEL.name]);
  });

  it('retries a deferred reset even when the project has no remaining open MRs', async (t) => {
    let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
    await service.refreshProjectReviewLabelColors(projectId, now);
    for (const mr of mrs) mr.state = 'merged';
    assert.equal(await service.refreshProjectReviewLabelColors(projectId, now), false);
    clock += 121_000;
    assert.equal(await service.refreshProjectReviewLabelColors(projectId, now), true);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.normal);
    assert.equal(mrWrites.length, 0);
  });

  it('does not color this project based on an overdue MR from another project', async () => {
    mrs[0]!.projectId += 1;
    await service.refreshProjectReviewLabelColors(projectId, now);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.normal);
    assert.equal(definitionAttempts.length, 0);
  });

  it('does not create labels for users with no pending review and no existing label', async () => {
    await service.refreshProjectReviewLabelColors(projectId, now);
    assert.ok(!definitions.has('Доброволец'));
  });

  it('can immediately color a newly created personal label without a creation/recolor cooldown conflict', async () => {
    definitions.delete('Первый ревьюер');
    mrLabels.set(1, mrLabels.get(1)!.filter((name) => name !== 'Первый ревьюер'));
    await reconcile(1);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.danger);
    assert.deepEqual(definitionAttempts.filter((label) => label.name === 'Первый ревьюер')
      .map((label) => label.color), [URGENCY_COLORS.normal, URGENCY_COLORS.danger]);
  });

  for (const field of ['isActive', 'isAllowed'] as const) {
    it(`resets an existing red label when ${field} becomes false`, async (t) => {
      let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
      await service.refreshProjectReviewLabelColors(projectId, now);
      users[0]![field] = false; clock += 121_000;
      await service.refreshProjectReviewLabelColors(projectId, now);
      assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.normal);
    });
  }

  it('throttles failed color updates and retries after cooldown without blocking MR labels', async (t) => {
    let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
    failColor = true;
    await reconcile(1); await reconcile(2); await reconcile(1);
    assert.equal(definitionAttempts.filter((label) => label.name === 'Первый ревьюер').length, 1);
    assert.ok(mrLabels.get(1)!.includes(REVIEW_OVERDUE_LABELS.danger.name));
    failColor = false; clock += 121_000;
    assert.equal(await service.refreshProjectReviewLabelColors(projectId, now), true);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.danger);
    assert.equal(mrWrites.length, 1);
  });

  it('replaces tracked emoji labels once without changing other labels or reviewer assignment', async () => {
    mrs[0]!.reviewerLabels = ['🚨 Первый ревьюер', 'Второй ревьюер', 'Техлид', 'Тимлид'];
    mrLabels.set(1, ['bug', ...mrs[0]!.reviewerLabels]);
    await reconcile(1); await reconcile(1);
    assert.ok(mrLabels.get(1)!.includes('Первый ревьюер'));
    assert.ok(!mrLabels.get(1)!.some((label) => /[⚠🚨]/u.test(label)));
    assert.deepEqual(mrs[0]!.reviewers, ['reviewer.one', 'reviewer.two']);
    assert.equal(mrWrites.length, 1);
  });

  it('loads a queued color plan only after the previous definition operation completes', async () => {
    const order: string[] = [];
    let release = (): void => {};
    let entered = (): void => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = sync.syncProjectPersonalLabelColors(projectId, async () => {
      order.push('first'); entered(); await hold; return [];
    });
    await started;
    const second = sync.syncProjectPersonalLabelColors(projectId, async () => {
      order.push('second');
      return [{ name: 'Первый ревьюер', color: URGENCY_COLORS.danger }];
    });
    assert.deepEqual(order, ['first']); release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.danger);
  });

  it('periodic sync retries the final deferred reset without any open MR', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    await service.refreshProjectReviewLabelColors(projectId, now);
    for (const mr of mrs) mr.state = 'merged';
    const periodic = require('../src/services/mergeRequestSync.ts') as typeof import('../src/services/mergeRequestSync');
    periodic.startMergeRequestSync({} as Parameters<typeof periodic.startMergeRequestSync>[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.danger);
    t.mock.timers.tick(15 * 60 * 1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(definitions.get('Первый ревьюер')?.color, URGENCY_COLORS.normal);
    assert.equal(mrWrites.length, 0);
  });
});
