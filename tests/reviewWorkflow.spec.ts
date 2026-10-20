import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { BotContext } from '../src/bot';
import type { Telegraf } from 'telegraf';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { ReviewLabel } from '../src/services/reviewLabelPlan';

let webhook: typeof import('../src/gitlab/handlers/mergeRequest');
let periodic: typeof import('../src/services/mergeRequestSync');
let noteHandler: typeof import('../src/gitlab/handlers/note');
let stored: MergeRequestDocument;
let labels: string[];
let approvals: string[];
let editCount = 0;
let selections = 0;
let definitionCount = 0;
let draft = false;
let mrState = 'opened';
let approvalApiAvailable = true;
let nextProjectId = 200;
let remindersStopped = 0;
let historicalNotes: Array<{ authorUsername: string; system: boolean }> | undefined = [];
let historyReads = 0;
let mergeUser: { username?: string; name?: string; id?: number } | undefined;
let mergedBy: { username?: string; name?: string; id?: number } | undefined;
const mergeAlerts: Array<{ text: string; ignoreWorkHours?: boolean; dedupeId?: string }> = [];
let mergedScores = 0;
const readyKeys: string[] = [];
const notifications: Array<{ username: string; eventType: string }> = [];
const people = [
  { gitlabUsername: 'reviewer.one', name: 'Первый ревьюер' },
  { gitlabUsername: 'reviewer.two', name: 'Второй ревьюер' },
  { gitlabUsername: 'tech.lead', name: 'Техлид', isLead: true, gitlabUserId: 42 },
  { gitlabUsername: 'team.lead', name: 'Тимлид', isLead: true },
  { gitlabUsername: 'author', name: 'Автор' },
  { gitlabUsername: 'volunteer', name: 'Доброволец', isReviewer: false },
];
const bot = {} as Telegraf<BotContext>;

const mockModule = (relativePath: string, exports: unknown): void => {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

before(() => {
  mockModule('../src/gitlab/api.ts', {
    fetchMergeRequest: async () => ({
      labels: [...labels], title: 'Test', state: mrState, draft,
      author: { username: stored.author.gitlabUsername },
      merge_user: mergeUser, merged_by: mergedBy,
    }),
    fetchMergeRequestApprovals: async () => approvalApiAvailable
      ? { approved_by: approvals.map((username) => ({ user: { username } })) }
      : undefined,
    fetchProjectLabels: async () => [],
    fetchMergeRequestNotes: async () => { historyReads += 1; return historicalNotes; },
    ensureProjectLabel: async (_projectId: number, label: ReviewLabel) => {
      definitionCount += 1;
      return { id: definitionCount, ...label, isProjectLabel: true };
    },
    updateMergeRequestLabels: async (_projectId: number, _iid: number, next: string[]) => {
      editCount += 1;
      labels = [...next];
      return true;
    },
  });
  mockModule('../src/data/mergeRequestRepository.ts', {
    findMergeRequest: async () => structuredClone(stored),
    upsertMergeRequest: async (update: Partial<MergeRequestDocument>) => {
      stored = { ...stored, ...structuredClone(update) };
    },
    updateMergeRequest: async (_projectId: number, _iid: number, update: Partial<MergeRequestDocument>) => {
      stored = { ...stored, ...structuredClone(update) };
    },
    clearMergeRequestGameReady: async () => { delete stored.gameReadyAt; },
  });
  mockModule('../src/data/userStore.ts', {
    listLeadUsers: async () => people.filter((user) => user.isLead),
    listActiveReviewers: async () => ['reviewer.one', 'reviewer.two'],
    listActiveUsernames: async () => people.map((user) => user.gitlabUsername),
    getUserByGitlabUsername: async (username: string) => people.find(
      (user) => user.gitlabUsername.toLowerCase() === username.toLowerCase(),
    ),
    getGitlabUserProfile: async (username: string) => ({ username, name: username }),
    getTelegramUserIdByUsername: async () => undefined,
  });
  mockModule('../src/data/reviewerQueue.ts', {
    pullReviewers: async () => { selections += 1; return ['reviewer.one', 'reviewer.two']; },
  });
  mockModule('../src/services/reviewReminderService.ts', {
    syncReviewRemindersForMr: async (_mr: unknown, _users: string[], _now: Date, inactive: boolean) => {
      if (inactive) remindersStopped += 1;
    },
    markReviewCompletedForApprovers: async () => {},
    markAllRemindersInactiveForMr: async () => {},
    markReviewCompletedForReviewer: async () => {},
  });
  mockModule('../src/data/reviewReminderRepository.ts', { ensureLeadReviewReminder: async () => {} });
  mockModule('../src/services/gameScoring.ts', {
    runGameAction: async (_label: string, action: () => Promise<void>) => action(),
    recordReviewApprovalScore: async () => {},
    recordReviewUnapprovalScore: async () => {},
    recordReviewCommentScore: async () => {},
    recordMergedMrScore: async () => { mergedScores += 1; },
  });
  mockModule('../src/services/mergeReadiness.ts', { syncMergeRequestGameReadiness: async () => {} });
  mockModule('../src/gitlab/handlers/common.ts', {
    persistGitlabUserProfileFromPayload: async () => {},
    persistGitlabUserProfiles: async () => {},
  });
  mockModule('../src/messages/recipients.ts', {
    getRecipientByGitlabUsername: async (username: string) => ({ gitlabUsername: username }),
    getLeadRecipients: async () => people.filter((user) => user.isLead)
      .map((user) => ({ gitlabUsername: user.gitlabUsername })),
  });
  mockModule('../src/messages/send.ts', {
    deliverHtmlMessage: async (
      _bot: unknown, recipient: { gitlabUsername: string }, _text: string, meta: { eventType: string; dedupeId?: string },
    ) => {
      notifications.push({ username: recipient.gitlabUsername, eventType: meta.eventType });
      if (meta.eventType === 'mr_ready_to_merge') readyKeys.push(meta.dedupeId ?? '');
    },
    deliverHtmlMessageToRecipients: async (
      _bot: unknown, recipients: Array<{ gitlabUsername: string }>, text: string,
      meta: { eventType: string; ignoreWorkHours?: boolean; dedupeId?: string },
    ) => {
      if (meta.eventType === 'mr_merged_without_approval') mergeAlerts.push({ text, ...meta });
      for (const username of new Set(recipients.map((recipient) => recipient.gitlabUsername))) {
        notifications.push({ username, eventType: meta.eventType });
      }
    },
  });
  webhook = require('../src/gitlab/handlers/mergeRequest.ts');
  periodic = require('../src/services/mergeRequestSync.ts');
  noteHandler = require('../src/gitlab/handlers/note.ts');
});

beforeEach(() => {
  nextProjectId += 1;
  stored = {
    projectId: nextProjectId, projectPath: 'test', mrId: 10, iid: 1, title: 'Test',
    sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/1',
    author: { gitlabUsername: 'author' }, state: 'opened', isDraft: false,
    reviewers: ['reviewer.one', 'reviewer.two'], reviewerLabels: ['Old reviewer one', 'Old reviewer two'],
    finalReviewNotified: true,
  };
  labels = ['bug', 'Old reviewer one', 'Old reviewer two'];
  approvals = []; draft = false; mrState = 'opened'; approvalApiAvailable = true;
  editCount = 0; selections = 0; definitionCount = 0; remindersStopped = 0;
  notifications.length = 0;
  historicalNotes = [];
  historyReads = 0; readyKeys.length = 0;
  mergeUser = undefined; mergedBy = undefined; mergeAlerts.length = 0; mergedScores = 0;
});

describe('merge approval audit webhook', () => {
  it('alerts both leads immediately about an incomplete merge without adding a second ordinary lead message', async () => {
    approvals = ['reviewer.one'];
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'missing_approvals');
    assert.deepEqual(notifications, [
      { username: 'tech.lead', eventType: 'mr_merged_without_approval' },
      { username: 'team.lead', eventType: 'mr_merged_without_approval' },
      { username: 'author', eventType: 'mr_closed' },
    ]);
    assert.equal(mergeAlerts[0]?.ignoreWorkHours, true);
    assert.match(mergeAlerts[0]!.text, /без полного набора апрувов/);
    assert.match(mergeAlerts[0]!.text, /tech.lead, team.lead/);
    assert.equal(mergedScores, 1); // Existing merge reward is unchanged; no new penalty action.
    assert.deepEqual(labels, ['bug']);
  });

  it('does not alert for a fully approved merge, including its required commenter', async () => {
    historicalNotes = [{ authorUsername: 'volunteer', system: false }];
    approvals = ['reviewer.one', 'tech.lead', 'team.lead', 'volunteer'];
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'approved');
    assert.equal(mergeAlerts.length, 0);
    assert.ok(notifications.every((item) => item.eventType === 'mr_closed'));
  });

  it('requires a volunteer approve even when the base reviewer and both leads approved', async () => {
    stored.reviewCommentRequirementsSyncedAt = new Date();
    historicalNotes = [{ authorUsername: 'volunteer', system: false }];
    approvals = ['reviewer.one', 'tech.lead', 'team.lead'];
    await event('merge', 'author');
    assert.equal(historyReads, 1); // Force one final read despite a fresh history cache.
    assert.equal(stored.mergeApprovalAudit?.status, 'missing_approvals');
    assert.match(mergeAlerts[0]!.text, /комментаторов: volunteer/);
  });

  it('does not accept an unrelated volunteer approve in place of an assigned reviewer', async () => {
    approvals = ['volunteer', 'tech.lead', 'team.lead'];
    await event('merge', 'author');
    assert.match(mergeAlerts[0]!.text, /нет апрува назначенного ревьюера/);
  });

  it('allows either lead to merge without approvals and does not read comment history', async () => {
    for (const username of ['TECH.LEAD', 'team.lead']) {
      delete stored.mergeApprovalAudit;
      await event('merge', username);
      assert.equal(stored.mergeApprovalAudit?.status, 'lead_override');
    }
    assert.equal(mergeAlerts.length, 0);
    assert.equal(historyReads, 0);
  });

  it('uses the actual API merge_user rather than the webhook actor, with merged_by as legacy fallback', async () => {
    mergeUser = { username: 'tech.lead' };
    mergedBy = { username: 'author' };
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'lead_override');
    assert.equal(stored.mergeApprovalAudit?.mergerUsername, 'tech.lead');
    delete stored.mergeApprovalAudit; mergeUser = undefined; mergedBy = { username: 'team.lead' };
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'lead_override');
    assert.equal(mergeAlerts.length, 0);
  });

  it('does not exempt a lead author when a developer performs the merge, or duplicate the lead-author message', async () => {
    stored.author.gitlabUsername = 'tech.lead';
    await event('merge', 'reviewer.one');
    assert.equal(stored.mergeApprovalAudit?.status, 'missing_approvals');
    assert.deepEqual(notifications, [
      { username: 'tech.lead', eventType: 'mr_merged_without_approval' },
      { username: 'team.lead', eventType: 'mr_merged_without_approval' },
    ]);
    assert.ok(!stored.mergeApprovalAudit?.missingApprovals.some((reason) => reason.includes('tech.lead')));
  });

  it('recognizes a lead by GitLab user ID if the API omitted the username', async () => {
    mergeUser = { id: 42, name: 'Техлид' };
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'lead_override');
    assert.equal(stored.mergeApprovalAudit?.mergerUsername, 'tech.lead');
    assert.equal(mergeAlerts.length, 0);
  });

  it('exempts the lead author from self-approval when a developer merges a fully approved MR', async () => {
    stored.author.gitlabUsername = 'tech.lead'; approvals = ['reviewer.one', 'team.lead'];
    await event('merge', 'reviewer.one');
    assert.equal(stored.mergeApprovalAudit?.status, 'approved');
    assert.equal(mergeAlerts.length, 0);
  });

  it('keeps the first audit snapshot and stable delivery key on repeated merge webhooks', async () => {
    await event('merge', 'author');
    const firstAudit = structuredClone(stored.mergeApprovalAudit);
    approvals = ['reviewer.one', 'tech.lead', 'team.lead'];
    await event('merge', 'tech.lead');
    assert.deepEqual(stored.mergeApprovalAudit, firstAudit);
    assert.equal(historyReads, 1);
    assert.deepEqual(mergeAlerts.map((alert) => alert.dedupeId), ['merge-audit-v1', 'merge-audit-v1']);
  });

  it('reports unavailable approvals as unverified, not as a proven violation', async () => {
    approvalApiAvailable = false;
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'unverified');
    assert.match(mergeAlerts[0]!.text, /подтвердить полный набор апрувов не удалось/);
    assert.ok(!mergeAlerts[0]!.text.includes('без полного набора апрувов'));
  });

  it('reports unknown history neutrally even if all known approvers approved', async () => {
    historicalNotes = undefined; approvals = ['reviewer.one', 'tech.lead', 'team.lead'];
    await event('merge', 'author');
    assert.equal(stored.mergeApprovalAudit?.status, 'unverified');
    assert.match(mergeAlerts[0]!.text, /GitLab API временно недоступен/);
  });

  it('does not audit an MR closed without merging', async () => {
    await event('close', 'author');
    assert.equal(stored.mergeApprovalAudit, undefined);
    assert.equal(mergeAlerts.length, 0);
    assert.equal(mergedScores, 0);
    assert.equal(historyReads, 0);
  });

  it('does not create a notification or label loop from updates following merge cleanup', async () => {
    await event('merge', 'author');
    const count = notifications.length;
    for (let i = 0; i < 10; i += 1) await event('update');
    assert.equal(notifications.length, count);
    assert.equal(historyReads, 1);
    assert.equal(editCount, 1);
    assert.equal(selections, 0);
    assert.equal(stored.state, 'merged');
  });
});

const event = async (action = 'update', username = 'reviewer.one'): Promise<void> => {
  if (action === 'merge') mrState = 'merged';
  if (action === 'close') mrState = 'closed';
  await webhook.handleMergeRequestEvent({
    project: { id: stored.projectId, path_with_namespace: 'test' },
    user: { username },
    object_attributes: {
      id: 10, iid: 1, action, state: 'opened', title: 'Test',
      source_branch: 'feature', target_branch: 'main', url: stored.url,
    },
  }, bot);
};

const comment = (username: string): Promise<void> => noteHandler.handleNoteEvent({
  user: { username }, merge_request: { target_project_id: stored.projectId, iid: stored.iid },
  object_attributes: { id: 100, discussion_id: 'thread', noteable_type: 'MergeRequest', action: 'create', note: 'Замечание' },
}, bot);

describe('webhook and periodic review workflow', () => {
  it('moves through both leads to merge-ready without reassignment or webhook loops', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await event();
    assert.equal(labels.length, 5);
    assert.ok(labels.includes('bug'));
    for (let i = 0; i < 10; i += 1) await event();
    assert.equal(editCount, 1);
    assert.equal(selections, 0);

    now += 121_000;
    approvals = ['reviewer.one'];
    await event('approval');
    assert.equal(labels.length, 4);
    assert.ok(!labels.some((name) => name.includes('Первый ревьюер')));
    assert.deepEqual(notifications.map((item) => item.username), ['tech.lead', 'team.lead']);
    for (let i = 0; i < 10; i += 1) await event();
    assert.equal(notifications.length, 2);
    assert.equal(editCount, 2);

    now += 121_000;
    approvals.push('tech.lead');
    await event('approval', 'tech.lead');
    assert.equal(labels.length, 3);
    assert.ok(labels.includes('Тимлид'));
    assert.ok(!labels.includes('Техлид'));
    assert.equal(notifications.length, 2);

    now += 121_000;
    approvals.push('team.lead');
    await event('approval', 'team.lead');
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.equal(notifications.length, 3);
    assert.deepEqual(notifications[2], { username: 'author', eventType: 'mr_ready_to_merge' });
    assert.ok(remindersStopped > 0);
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    await event();
    assert.equal(editCount, 4);
    assert.equal(notifications.length, 3);
    assert.equal(selections, 0);
    assert.deepEqual(stored.reviewers, ['reviewer.one', 'reviewer.two']);
  });

  it('retries a label update deferred by cooldown from the latest approval snapshot', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await event();
    approvals = ['reviewer.one', 'tech.lead', 'team.lead'];
    await event('approval', 'team.lead');
    assert.equal(editCount, 1);
    assert.ok(stored.reviewersSyncError?.includes('cooldown'));
    now += 121_000;
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.equal(editCount, 2);
    assert.equal(selections, 0);
  });

  it('uses approval and unapproval webhook actors when the approvals API is temporarily unavailable', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    approvalApiAvailable = false;
    stored.approvedBy = ['reviewer.one', 'tech.lead'];
    await event('approval', 'team.lead');
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    now += 121_000;
    await event('unapproval', 'TEAM.LEAD');
    assert.ok(!stored.approvedBy?.includes('team.lead'));
    assert.ok(labels.includes('Тимлид'));
    assert.ok(!labels.includes('Можно сливать'));
  });

  it('clears all managed labels for Draft and keeps unrelated labels', async () => {
    draft = true;
    await event();
    assert.deepEqual(labels, ['bug']);
    assert.deepEqual(stored.reviewers, []);
    assert.deepEqual(stored.approvalRequestedAt, {});
    assert.equal(remindersStopped, 1);
    assert.equal(notifications.length, 0);
  });

  it('retries cleanup for a closed MR even after it leaves the open-MR list', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await event();
    mrState = 'closed';
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.equal(stored.state, 'closed');
    assert.equal(stored.reviewerLabelsCleanupPending, true);
    assert.ok(stored.finishedAt instanceof Date);
    const finishedAt = stored.finishedAt;
    now += 121_000;
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.deepEqual(labels, ['bug']);
    assert.equal(stored.reviewerLabelsCleanupPending, false);
    assert.deepEqual(stored.finishedAt, finishedAt);
    assert.deepEqual(stored.reviewers, ['reviewer.one', 'reviewer.two']);
  });

  it('persists a closure date on webhook updates and clears it if the MR reopens', async () => {
    mrState = 'closed';
    await event();
    assert.ok(stored.finishedAt instanceof Date);
    const finishedAt = stored.finishedAt;
    await event();
    assert.deepEqual(stored.finishedAt, finishedAt);
    mrState = 'opened';
    await event();
    assert.equal(stored.finishedAt, null);
  });

  it('holds readiness for the commenting reviewer even after the other reviewer and leads approve', async (t) => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    await comment('reviewer.one');
    now += 121_000; approvals = ['reviewer.two', 'tech.lead', 'team.lead'];
    await event('approval', 'team.lead');
    assert.deepEqual(labels, ['bug', 'Первый ревьюер']);
    assert.equal(readyKeys.length, 0);
    now += 121_000; approvals.push('reviewer.one');
    await event('approval', 'reviewer.one');
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.equal(readyKeys.length, 1);
    assert.equal(selections, 0);
  });

  it('revokes ready status for a new volunteer, then announces readiness once with a new delivery key', async (t) => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    approvals = ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'];
    await event();
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.deepEqual(readyKeys, ['comment-approvers-v1:0']);
    stored.gameReadyAt = new Date();
    now += 121_000; await comment('volunteer');
    assert.deepEqual(labels, ['bug', 'Доброволец']);
    assert.deepEqual(stored.reviewers, ['reviewer.one', 'reviewer.two']);
    assert.equal(stored.gameReadyAt, undefined);
    assert.equal(stored.authorMergeNotified, false);
    assert.equal(stored.authorMergeNotificationVersion, 1);
    const afterComment = editCount;
    for (let i = 0; i < 10; i += 1) await event();
    assert.equal(editCount, afterComment);
    assert.equal(readyKeys.length, 1);
    now += 121_000; approvals.push('volunteer'); await event('approval', 'volunteer');
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.deepEqual(readyKeys, ['comment-approvers-v1:0', 'comment-approvers-v1:1']);
    for (let i = 0; i < 10; i += 1) await event();
    assert.equal(editCount, afterComment + 1);
    assert.equal(readyKeys.length, 2);
    assert.equal(selections, 0);
  });

  it('backfills volunteers missed by an older handler even if the old comment history was already synced', async () => {
    stored.reviewCommentsSyncedAt = new Date();
    historicalNotes = [
      { authorUsername: 'VOLUNTEER', system: false },
      { authorUsername: 'unknown', system: true },
      { authorUsername: 'author', system: false },
    ];
    approvals = ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'];
    await event();
    assert.deepEqual(labels, ['bug', 'Доброволец']);
    assert.equal(readyKeys.length, 0);
    assert.ok(stored.reviewCommentRequirementsSyncedAt);
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.equal(historyReads, 1);
  });

  it('recovers a missed volunteer comment in the next fifteen-minute history refresh', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T06:00:00Z') });
    approvals = ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'];
    await event();
    historicalNotes = [{ authorUsername: 'volunteer', system: false }];
    t.mock.timers.setTime(new Date('2026-10-21T06:15:01Z').getTime());
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.equal(historyReads, 2);
    assert.deepEqual(labels, ['bug', 'Доброволец']);
    assert.equal(stored.authorMergeNotified, false);
  });

  it('does not confirm readiness on a history API error and retries successfully', async (t) => {
    let now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    historicalNotes = undefined;
    approvals = ['reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'];
    await event();
    assert.ok(!labels.includes('Можно сливать'));
    assert.equal(readyKeys.length, 0);
    assert.equal(stored.reviewCommentHistorySyncPending, true);
    historicalNotes = [];
    now += 121_000; t.mock.timers.setTime(now);
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.deepEqual(labels, ['bug', 'Можно сливать']);
    assert.equal(stored.reviewCommentHistorySyncPending, false);
    assert.equal(readyKeys.length, 1);
  });
});
