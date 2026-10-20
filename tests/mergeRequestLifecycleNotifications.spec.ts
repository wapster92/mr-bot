import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { DeliveryRecipient } from '../src/messages/recipients';
import type { NotificationMeta } from '../src/messages/send';

let lifecycle: typeof import('../src/services/mergeRequestLifecycleNotifications');
let mr: MergeRequestDocument;
let mergerIsLead = false;
let mergerAvailable = true;
const recipient = (username: string, chatId: number): DeliveryRecipient => ({
  gitlabUsername: username, chatId, isWithinHours: false,
});
let recipients: Map<string, DeliveryRecipient>;
const deliveries: Array<{ recipients: DeliveryRecipient[]; text: string; meta: NotificationMeta }> = [];
const bot = {} as Parameters<typeof lifecycle.notifyMergeRequestCreated>[0];

const mockModule = (relative: string, exports: unknown): void => {
  const path = require.resolve(relative);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

before(() => {
  mockModule('../src/data/userStore.ts', {
    getUserByGitlabUsername: async (username: string) => ({ gitlabUsername: username, isLead: mergerIsLead }),
  });
  mockModule('../src/messages/recipients.ts', {
    getLeadRecipients: async () => [recipients.get('tech.lead')!, recipients.get('team.lead')!],
    getRecipientByGitlabUsername: async (username: string) =>
      username === 'merger' && !mergerAvailable ? undefined : recipients.get(username),
  });
  mockModule('../src/messages/format.ts', {
    formatGitlabUserLabel: async (username?: string) => username ?? '—',
    escapeHtml: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
  mockModule('../src/messages/send.ts', {
    deliverHtmlMessageToRecipients: async (
      _bot: unknown, targets: DeliveryRecipient[], text: string, meta: NotificationMeta,
    ) => { deliveries.push({ recipients: targets, text, meta }); },
  });
  lifecycle = require('../src/services/mergeRequestLifecycleNotifications.ts');
});

beforeEach(() => {
  mr = {
    projectId: 1, projectPath: 'team/project', mrId: 10, iid: 2, title: 'Test',
    sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/2',
    taskUrl: 'https://jira.example/TASK-1', author: { gitlabUsername: 'author' },
    reviewers: ['reviewer.one', 'reviewer.two'],
  };
  recipients = new Map([
    ['tech.lead', recipient('tech.lead', 1)], ['team.lead', recipient('team.lead', 2)],
    ['author', recipient('author', 3)], ['merger', recipient('merger', 4)],
  ]);
  mergerIsLead = false; mergerAvailable = true; deliveries.length = 0;
});

const byEvent = (event: string): typeof deliveries => deliveries.filter((item) => item.meta.eventType === event);
const usernames = (event: string): Array<string | undefined> => byEvent(event)
  .flatMap((item) => item.recipients.map((target) => target.gitlabUsername));

describe('MR lifecycle notification contracts', () => {
  it('keeps creation recipients, reviewer list, working hours and legacy delivery ID', async () => {
    await lifecycle.notifyMergeRequestCreated(bot, mr, 'created-at');
    assert.deepEqual(usernames('mr_created'), ['tech.lead', 'team.lead', 'author']);
    assert.deepEqual(deliveries[0]!.meta, {
      eventType: 'mr_created', projectId: 1, mrIid: 2, dedupeId: 'created-at',
    });
    assert.match(deliveries[0]!.text, /Ревьюеры: reviewer.one, reviewer.two/);
    assert.ok(deliveries[0]!.text.includes(mr.taskUrl!));
  });

  it('handles creation without assigned reviewers or a known author recipient', async () => {
    mr.author = {}; mr.reviewers = [];
    await lifecycle.notifyMergeRequestCreated(bot, mr);
    assert.deepEqual(usernames('mr_created'), ['tech.lead', 'team.lead']);
    assert.equal(deliveries[0]!.meta.dedupeId, undefined);
    assert.match(deliveries[0]!.text, /Ревьюеры: не назначены/);
  });

  it('does not use a previous merge audit when the current event is closure', async () => {
    mr.mergeApprovalAudit = { status: 'missing_approvals', mergerUsername: 'merger', missingApprovals: [] };
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'close', actorUsername: 'author', updatedAt: 'closed-at' });
    assert.equal(deliveries.length, 1);
    assert.deepEqual(usernames('mr_closed'), ['tech.lead', 'team.lead', 'author']);
    assert.equal(deliveries[0]!.meta.dedupeId, 'close:closed-at');
    assert.equal(deliveries[0]!.meta.ignoreWorkHours, undefined);
    assert.match(deliveries[0]!.text, /Действие выполнил: author/);
  });

  for (const status of ['approved', 'lead_override'] as const) {
    it(`keeps ordinary merge recipients and stable delivery ID for ${status}`, async () => {
      mr.mergeApprovalAudit = { status, mergerUsername: 'merger', missingApprovals: [] };
      await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge', updatedAt: 'new-timestamp' });
      assert.equal(deliveries.length, 1);
      assert.deepEqual(usernames('mr_closed'), ['tech.lead', 'team.lead', 'author']);
      assert.equal(deliveries[0]!.meta.dedupeId, 'merge');
      assert.equal(deliveries[0]!.meta.ignoreWorkHours, undefined);
    });
  }

  it('keeps the audit and warning delivery contracts separate from the ordinary author message', async () => {
    mr.mergeApprovalAudit = { status: 'missing_approvals', mergerUsername: 'merger', missingApprovals: ['нет апрува'] };
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge', actorUsername: 'author' });
    assert.deepEqual(usernames('mr_merged_without_approval'), ['tech.lead', 'team.lead']);
    assert.deepEqual(usernames('mr_merge_policy_warning'), ['merger']);
    assert.deepEqual(usernames('mr_closed'), ['author']);
    for (const item of deliveries.filter((delivery) => delivery.meta.eventType !== 'mr_closed')) {
      assert.equal(item.meta.dedupeId, 'merge-audit-v1');
      assert.equal(item.meta.ignoreWorkHours, true);
      assert.equal(item.meta.projectId, 1); assert.equal(item.meta.mrIid, 2);
    }
  });

  it('does not duplicate the author message when another GitLab account shares the alerted chat', async () => {
    mr.mergeApprovalAudit = { status: 'missing_approvals', mergerUsername: 'merger', missingApprovals: [] };
    recipients.set('author', recipient('author', 4));
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge' });
    assert.deepEqual(usernames('mr_merge_policy_warning'), ['merger']);
    assert.deepEqual(usernames('mr_closed'), []);
  });

  it('does not accuse a merger when the audit could not be verified', async () => {
    mr.mergeApprovalAudit = { status: 'unverified', mergerUsername: 'merger', missingApprovals: [] };
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge' });
    assert.deepEqual(usernames('mr_merge_policy_warning'), []);
    assert.deepEqual(usernames('mr_merged_without_approval'), ['tech.lead', 'team.lead']);
    assert.deepEqual(usernames('mr_closed'), ['author']);
  });

  it('skips the merger warning for a promoted or unavailable recipient', async () => {
    mr.mergeApprovalAudit = { status: 'missing_approvals', mergerUsername: 'merger', missingApprovals: [] };
    mergerIsLead = true;
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge' });
    mergerIsLead = false; mergerAvailable = false;
    await lifecycle.notifyMergeRequestClosed(bot, mr, { action: 'merge' });
    assert.deepEqual(usernames('mr_merge_policy_warning'), []);
    assert.deepEqual(usernames('mr_closed'), ['author', 'author']);
  });
});
