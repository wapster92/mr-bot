import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../src/bot';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { NotificationQueueDocument } from '../src/data/notificationQueueRepository';
import type { UserRecord } from '../src/data/userTypes';
import { withMergeRequestLock } from '../src/services/mergeRequestLock';

let notes: typeof import('../src/gitlab/handlers/note');
let pushes: typeof import('../src/gitlab/handlers/push');
let notifications: typeof import('../src/services/notificationQueue');
let policy: typeof import('../src/services/pushReviewNotifications');
let approvalMessages: typeof import('../src/services/approvalNotifications');
let mr: MergeRequestDocument;
let users: UserRecord[];
let queued: NotificationQueueDocument[];
let withinHours = true;
let approvals: string[] = [];
let approvalApiAvailable = true;
let historicalNotes: Array<{ authorUsername: string; system: boolean }> | undefined = [];
let noteReads = 0;
let apiReads = 0;
let sent: number[] = [];
let scoredCommenters: string[] = [];
const bot = { telegram: { sendMessage: async (chatId: number) => { sent.push(chatId); } } } as unknown as Telegraf<BotContext>;

const mockModule = (relative: string, exports: unknown): void => {
  const path = require.resolve(relative);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

before(() => {
  mockModule('../src/data/mergeRequestRepository.ts', {
    findMergeRequest: async () => structuredClone(mr),
    findMergeRequestByBranch: async () => structuredClone(mr),
    updateMergeRequest: async (_projectId: number, _iid: number, update: Partial<MergeRequestDocument>) => {
      mr = { ...mr, ...structuredClone(update) };
    },
    clearMergeRequestGameReady: async () => {},
  });
  mockModule('../src/data/userStore.ts', {
    getUserByGitlabUsername: async (name: string) => users.find((user) =>
      user.gitlabUsername.toLowerCase() === name.toLowerCase() && user.isAllowed !== false,
    ),
    getUserByTelegramUsername: async (name: string) => users.find((user) =>
      user.telegramUsername === name && user.isAllowed !== false,
    ),
    listLeadUsers: async () => users.filter((user) => user.isLead && user.isActive !== false && user.isAllowed !== false),
    listActiveUsernames: async () => users.filter((user) => user.isActive !== false && user.isAllowed !== false)
      .map((user) => user.gitlabUsername),
    listActiveReviewers: async () => users.filter((user) => !user.isLead).map((user) => user.gitlabUsername),
    getChatIdByUsername: async (name: string) => users.find((user) => user.telegramUsername === name)?.chatId,
    getGitlabUserProfile: async (name: string) => ({ name }),
  });
  mockModule('../src/gitlab/api.ts', {
    fetchMergeRequest: async () => { apiReads += 1; return { state: mr.state, draft: mr.isDraft, title: mr.title }; },
    fetchMergeRequestApprovals: async () => {
      apiReads += 1;
      return approvalApiAvailable ? { approved_by: approvals.map((username) => ({ user: { username } })) } : undefined;
    },
    fetchMergeRequestNotes: async () => { noteReads += 1; return historicalNotes; },
  });
  mockModule('../src/gitlab/handlers/common.ts', { persistGitlabUserProfileFromPayload: async () => {} });
  mockModule('../src/services/gameScoring.ts', {
    recordReviewCommentScore: async (input: { reviewerUsername: string }) => { scoredCommenters.push(input.reviewerUsername); },
    recordAuthorChangesScore: async () => {},
    runGameAction: async (_name: string, action: () => Promise<void>) => action(),
  });
  mockModule('../src/services/reviewReminderService.ts', { markReviewCompletedForReviewer: async () => {} });
  mockModule('../src/services/mergeRequestSync.ts', { syncMergeRequestFromGitlab: async () => {} });
  mockModule('../src/services/workingHours.ts', { isWithinWorkingHours: () => withinHours });
  mockModule('../src/data/notificationQueueRepository.ts', {
    enqueueNotification: async (input: NotificationQueueDocument, status: 'processing' | 'pending') => {
      const existing = input.dedupeKey && queued.find((item) => item.chatId === input.chatId && item.dedupeKey === input.dedupeKey);
      if (existing) return { id: existing._id!, shouldSend: false };
      const item = { ...input, _id: new ObjectId(), status };
      queued.push(item);
      return { id: item._id, shouldSend: status === 'processing' };
    },
    listQueuedNotifications: async () => queued.filter((item) => item.status === 'pending'),
    claimNotification: async (id: ObjectId) => {
      const item = queued.find((entry) => entry._id!.equals(id))!;
      if (item.status !== 'pending') return false;
      item.status = 'processing'; return true;
    },
    markNotificationDelivered: async (id: ObjectId) => { queued.find((item) => item._id!.equals(id))!.status = 'delivered'; },
    markNotificationCancelled: async (id: ObjectId) => { queued.find((item) => item._id!.equals(id))!.status = 'cancelled'; },
    markNotificationError: async (id: ObjectId) => { queued.find((item) => item._id!.equals(id))!.status = 'error'; },
  });
  notes = require('../src/gitlab/handlers/note.ts');
  pushes = require('../src/gitlab/handlers/push.ts');
  notifications = require('../src/services/notificationQueue.ts');
  policy = require('../src/services/pushReviewNotifications.ts');
  approvalMessages = require('../src/services/approvalNotifications.ts');
});

beforeEach(() => {
  mr = {
    projectId: 1, projectPath: 'team/project', mrId: 10, iid: 1, title: 'Test',
    sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/1',
    author: { gitlabUsername: 'author' }, state: 'opened', isDraft: false,
    reviewers: ['reviewer.one', 'reviewer.two'], approvedBy: [],
  };
  users = ['author', 'reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead', 'outsider'].map((name, index) => ({
    gitlabUsername: name, telegramUsername: name, chatId: index + 1,
    isLead: name.endsWith('.lead'), isActive: true, isAllowed: true,
  }));
  queued = []; withinHours = true; approvals = []; approvalApiAvailable = true;
  historicalNotes = []; noteReads = 0; apiReads = 0; sent = []; scoredCommenters = [];
});

const comment = (username: string, extra: Record<string, unknown> = {}): Promise<void> => notes.handleNoteEvent({
  merge_request: { target_project_id: 1, iid: 1 }, user: { username },
  object_attributes: { id: username, noteable_type: 'MergeRequest', note: 'Замечание', action: 'create', ...extra },
}, bot);

const push = (sha = 'sha-1', extra: Record<string, unknown> = {}): Promise<void> => pushes.handlePushEvent({
  ref: 'refs/heads/feature', project: { path_with_namespace: 'team/project' },
  after: sha, total_commits_count: 1, user_username: 'author', ...extra,
}, bot);

const pushMessages = (): NotificationQueueDocument[] => queued.filter((item) => item.eventType === 'mr_push');

describe('updates after reviewer and lead comments', () => {
  it('scores a voluntary code comment and subscribes the commenter without changing assigned reviewers', async () => {
    await comment('outsider', { type: 'DiffNote' });
    assert.deepEqual(scoredCommenters, ['outsider']);
    assert.deepEqual(mr.reviewers, ['reviewer.one', 'reviewer.two']);
    assert.deepEqual(mr.reviewCommenters, ['outsider']);
    await push();
    assert.deepEqual(pushMessages().map((item) => item.chatId), [6]);
  });

  it('does not score voluntary system, edited or deleted notes or comments by unavailable users', async () => {
    await comment('outsider', { system: true });
    await comment('outsider', { action: 'update' });
    await comment('outsider', { action: 'delete' });
    await comment('author');
    users[5]!.isActive = false; await comment('outsider');
    users[5]!.isActive = true; users[5]!.isAllowed = false; await comment('outsider');
    await comment('unknown');
    assert.deepEqual(scoredCommenters, []);
  });

  it('notifies all active commenters, but not silent reviewers or the author', async () => {
    await Promise.all([comment('reviewer.one'), comment('tech.lead')]);
    await comment('outsider'); await comment('author');
    await push();
    assert.deepEqual(pushMessages().map((item) => item.chatId).sort(), [2, 4, 6]);
    assert.deepEqual(mr.reviewCommenters?.sort(), ['outsider', 'reviewer.one', 'tech.lead']);
  });

  it('uses fresh approvals and stops notifying each person independently after their approve', async () => {
    await comment('reviewer.one'); await comment('tech.lead');
    approvals = ['TECH.LEAD'];
    await push();
    assert.deepEqual(pushMessages().map((item) => item.chatId), [2]);
    assert.deepEqual(mr.approvedBy, ['TECH.LEAD']);
    approvals = ['TECH.LEAD', 'reviewer.one'];
    await push('sha-2');
    assert.equal(pushMessages().length, 1);
  });

  it('cancels a queued push after approval and still delivers the other lead update', async () => {
    await comment('reviewer.one'); await comment('tech.lead');
    withinHours = false;
    await push();
    assert.ok(pushMessages().every((item) => item.status === 'pending'));
    mr.approvedBy = ['reviewer.one'];
    withinHours = true;
    await notifications.flushNotificationQueue(bot);
    assert.equal(pushMessages().find((item) => item.chatId === 2)?.status, 'cancelled');
    assert.equal(pushMessages().find((item) => item.chatId === 4)?.status, 'delivered');
  });

  it('cancels a voluntary commenter push if they approve before working hours', async () => {
    await comment('outsider'); withinHours = false; await push();
    mr.approvedBy = ['outsider']; withinHours = true;
    await notifications.flushNotificationQueue(bot);
    assert.equal(pushMessages()[0]?.chatId, 6);
    assert.equal(pushMessages()[0]?.status, 'cancelled');
  });

  it('cancels old merge-ready and delivers a new one exactly once after the mandatory volunteer approves', async () => {
    mr.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead'];
    withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    const ready = (): NotificationQueueDocument[] => queued.filter((item) => item.eventType === 'mr_ready_to_merge');
    assert.equal(ready().length, 1);
    await comment('outsider');
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    withinHours = true; await notifications.flushNotificationQueue(bot);
    assert.equal(ready()[0]?.status, 'cancelled');
    mr.approvedBy!.push('outsider'); withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    assert.equal(ready().length, 2);
    assert.notEqual(ready()[0]?.dedupeKey, ready()[1]?.dedupeKey);
    withinHours = true; await notifications.flushNotificationQueue(bot);
    assert.equal(ready()[1]?.status, 'delivered');
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    await notifications.flushNotificationQueue(bot);
    assert.equal(ready().length, 2);
  });

  it('waits for an in-flight comment before delivering a queued merge-ready message', async () => {
    mr.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead']; withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    let release = (): void => {};
    let entered = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const incoming = withMergeRequestLock(1, 1, async () => {
      entered(); await held; mr.reviewCommenters = ['outsider'];
    });
    await acquired;
    withinHours = true;
    const delivery = notifications.flushNotificationQueue(bot);
    release(); await Promise.all([incoming, delivery]);
    assert.equal(queued.find((item) => item.eventType === 'mr_ready_to_merge')?.status, 'cancelled');
  });

  it('does not deliver both readiness versions when a commenter responds before the queue is flushed', async () => {
    mr.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead']; withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    await comment('outsider'); await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    mr.approvedBy!.push('outsider'); await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    withinHours = true; await notifications.flushNotificationQueue(bot);
    const ready = queued.filter((item) => item.eventType === 'mr_ready_to_merge');
    assert.deepEqual(ready.map((item) => item.status), ['cancelled', 'delivered']);
    assert.equal(mr.authorMergeNotified, true);
    assert.equal(mr.authorMergeNotificationVersion, 1);
  });

  it('defers a ready message on a history API error without generating another delivery cycle', async (t) => {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    mr.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead']; withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    historicalNotes = undefined; withinHours = true;
    await notifications.flushNotificationQueue(bot);
    let ready = queued.filter((item) => item.eventType === 'mr_ready_to_merge');
    assert.equal(ready[0]?.status, 'pending');
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    assert.equal(mr.authorMergeNotified, true);
    assert.equal(mr.authorMergeNotificationVersion, 0);
    historicalNotes = [];
    await notifications.flushNotificationQueue(bot);
    assert.equal(noteReads, 1); // Failure retries are bounded to two minutes.
    t.mock.timers.setTime(now + 121_000);
    await notifications.flushNotificationQueue(bot);
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    ready = queued.filter((item) => item.eventType === 'mr_ready_to_merge');
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.status, 'delivered');
  });

  it('starts a new ready delivery cycle when queue history discovers a previously missed volunteer', async () => {
    mr.approvedBy = ['reviewer.one', 'tech.lead', 'team.lead']; withinHours = false;
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    historicalNotes = [{ authorUsername: 'outsider', system: false }]; withinHours = true;
    await notifications.flushNotificationQueue(bot);
    assert.equal(mr.authorMergeNotified, false);
    assert.equal(mr.authorMergeNotificationVersion, 1);
    mr.approvedBy!.push('outsider');
    await approvalMessages.notifyMergeRequestApprovals(bot, mr);
    assert.deepEqual(queued.filter((item) => item.eventType === 'mr_ready_to_merge').map((item) => item.status),
      ['cancelled', 'delivered']);
  });

  it('backfills comments for existing MRs once and ignores system notes', async () => {
    historicalNotes = [
      { authorUsername: 'REVIEWER.ONE', system: false },
      { authorUsername: 'tech.lead', system: false },
      { authorUsername: 'team.lead', system: true },
      { authorUsername: 'author', system: false },
    ];
    await push(); await push('sha-2');
    assert.equal(noteReads, 1);
    assert.deepEqual(pushMessages().map((item) => item.chatId).sort(), [2, 2, 4, 4]);
  });

  it('ignores system/edited/deleted notes and tracks human comments independently of XP', async () => {
    await comment('reviewer.one', { system: true });
    await comment('reviewer.two', { action: 'update' });
    await comment('team.lead', { action: 'delete' });
    await comment('tech.lead', { id: undefined });
    await push();
    assert.deepEqual(pushMessages().map((item) => item.chatId), [4]);
  });

  it('does not send duplicate push notifications on repeated webhook delivery', async () => {
    await comment('reviewer.one');
    await Promise.all([push(), push(), push()]);
    assert.equal(pushMessages().length, 1);
    assert.equal(pushMessages()[0]?.status, 'delivered');
  });

  it('does not interpret branch deletion or an empty push as an update', async () => {
    await comment('reviewer.one');
    await push('0000000000'); await push('sha-empty', { total_commits_count: 0 });
    await push('', { after: undefined, checkout_sha: undefined });
    assert.equal(pushMessages().length, 0);
    assert.equal(apiReads, 0);
    assert.equal(noteReads, 0);
  });

  it('resumes updates after approval reset and retains cached approvals when the API is unavailable', async () => {
    await comment('reviewer.one');
    mr.approvedBy = ['reviewer.one']; approvals = ['reviewer.one'];
    approvalApiAvailable = false;
    await push();
    assert.equal(pushMessages().length, 0);
    approvalApiAvailable = true; approvals = [];
    await push('sha-2');
    assert.equal(pushMessages().length, 1);
  });

  it('cancels updates queued for an MR that was closed before working hours', async () => {
    await comment('tech.lead'); withinHours = false; await push();
    mr.state = 'merged'; withinHours = true;
    await notifications.flushNotificationQueue(bot);
    assert.equal(pushMessages()[0]?.status, 'cancelled');
  });

  it('waits for an in-flight approval and rechecks the queued push under the MR lock', async () => {
    await comment('tech.lead'); withinHours = false; await push();
    let release = (): void => {};
    let entered = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const approval = withMergeRequestLock(1, 1, async () => {
      entered(); await held; mr.approvedBy = ['tech.lead'];
    });
    await acquired;
    withinHours = true;
    const delivery = notifications.flushNotificationQueue(bot);
    release();
    await Promise.all([approval, delivery]);
    assert.equal(pushMessages()[0]?.status, 'cancelled');
  });

  it('excludes unavailable users, authors and Draft MRs, but keeps active commenters after reassignment', () => {
    mr.reviewCommenters = ['reviewer.one', 'tech.lead'];
    const reviewer = users[1]!;
    assert.equal(policy.shouldNotifyReviewUpdate(mr, reviewer), true);
    for (const update of [{ isActive: false }, { isAllowed: false }]) {
      assert.equal(policy.shouldNotifyReviewUpdate(mr, { ...reviewer, ...update }), false);
    }
    assert.equal(policy.shouldNotifyReviewUpdate({ ...mr, reviewers: ['reviewer.two'] }, reviewer), true);
    assert.equal(policy.shouldNotifyReviewUpdate(mr, { ...reviewer, isReviewer: false }), true);
    assert.equal(policy.shouldNotifyReviewUpdate({ ...mr, isDraft: true }, reviewer), false);
    assert.equal(policy.shouldNotifyReviewUpdate({ ...mr, author: { gitlabUsername: 'tech.lead' } }, users[3]!), false);
  });
});
