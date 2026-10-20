import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { BotContext } from '../src/bot';
import type { Telegraf } from 'telegraf';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { ReviewLabel } from '../src/services/reviewLabelPlan';

let webhook: typeof import('../src/gitlab/handlers/mergeRequest');
let periodic: typeof import('../src/services/mergeRequestSync');
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
const notifications: Array<{ username: string; eventType: string }> = [];
const people = [
  { gitlabUsername: 'reviewer.one', name: 'Первый ревьюер' },
  { gitlabUsername: 'reviewer.two', name: 'Второй ревьюер' },
  { gitlabUsername: 'tech.lead', name: 'Техлид', isLead: true },
  { gitlabUsername: 'team.lead', name: 'Тимлид', isLead: true },
  { gitlabUsername: 'author', name: 'Автор' },
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
    }),
    fetchMergeRequestApprovals: async () => approvalApiAvailable
      ? { approved_by: approvals.map((username) => ({ user: { username } })) }
      : undefined,
    fetchProjectLabels: async () => [],
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
    clearMergeRequestGameReady: async () => {},
  });
  mockModule('../src/data/userStore.ts', {
    listLeadUsers: async () => people.filter((user) => user.isLead),
    listActiveReviewers: async () => ['reviewer.one', 'reviewer.two'],
    getUserByGitlabUsername: async (username: string) => people.find(
      (user) => user.gitlabUsername.toLowerCase() === username.toLowerCase(),
    ),
    getGitlabUserProfile: async (username: string) => ({ username, name: username }),
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
  });
  mockModule('../src/services/gameScoring.ts', {
    runGameAction: async (_label: string, action: () => Promise<void>) => action(),
    recordReviewApprovalScore: async () => {},
    recordReviewUnapprovalScore: async () => {},
  });
  mockModule('../src/services/mergeReadiness.ts', { syncMergeRequestGameReadiness: async () => {} });
  mockModule('../src/gitlab/handlers/common.ts', {
    persistGitlabUserProfileFromPayload: async () => {},
    persistGitlabUserProfiles: async () => {},
  });
  mockModule('../src/messages/recipients.ts', {
    getRecipientByGitlabUsername: async (username: string) => ({ gitlabUsername: username }),
  });
  mockModule('../src/messages/send.ts', {
    deliverHtmlMessage: async (
      _bot: unknown, recipient: { gitlabUsername: string }, _text: string, meta: { eventType: string },
    ) => { notifications.push({ username: recipient.gitlabUsername, eventType: meta.eventType }); },
  });
  webhook = require('../src/gitlab/handlers/mergeRequest.ts');
  periodic = require('../src/services/mergeRequestSync.ts');
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
});

const event = async (action = 'update', username = 'reviewer.one'): Promise<void> => {
  await webhook.handleMergeRequestEvent({
    project: { id: stored.projectId, path_with_namespace: 'test' },
    user: { username },
    object_attributes: {
      id: 10, iid: 1, action, state: 'opened', title: 'Test',
      source_branch: 'feature', target_branch: 'main', url: stored.url,
    },
  }, bot);
};

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
    assert.ok(!labels.some((name) => name.includes('@reviewer.one')));
    assert.deepEqual(notifications.map((item) => item.username), ['tech.lead', 'team.lead']);
    for (let i = 0; i < 10; i += 1) await event();
    assert.equal(notifications.length, 2);
    assert.equal(editCount, 2);

    now += 121_000;
    approvals.push('tech.lead');
    await event('approval', 'tech.lead');
    assert.equal(labels.length, 3);
    assert.ok(labels.some((name) => name.includes('@team.lead')));
    assert.ok(!labels.some((name) => name.includes('@tech.lead')));
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
    assert.ok(labels.some((name) => name.includes('@team.lead')));
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
    now += 121_000;
    await periodic.syncMergeRequestFromGitlab(bot, stored.projectId, stored.iid);
    assert.deepEqual(labels, ['bug']);
    assert.equal(stored.reviewerLabelsCleanupPending, false);
    assert.deepEqual(stored.reviewers, ['reviewer.one', 'reviewer.two']);
  });
});
