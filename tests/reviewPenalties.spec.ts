import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../src/bot';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { ReviewReminderDocument } from '../src/data/reviewReminderRepository';
import type { UserRecord } from '../src/data/userTypes';
import type { addScoreEvent } from '../src/data/scoreEventRepository';
import { withMergeRequestLock } from '../src/services/mergeRequestLock';
import { isWithinWorkingHours } from '../src/services/workingHours';

type StoredEvent = Parameters<typeof addScoreEvent>[0];
let scheduler: typeof import('../src/services/reviewReminderScheduler');
let reminders: typeof import('../src/data/reviewReminderRepository');
let reminderService: typeof import('../src/services/reviewReminderService');
let approvals: typeof import('../src/services/approvalNotifications');
let scoring: typeof import('../src/services/gameScoring');
let mr: MergeRequestDocument;
let users: UserRecord[];
let documents: ReviewReminderDocument[];
let historicalNotes: Array<{ authorUsername: string; system: boolean }> | undefined;
let noteReads = 0;
const events = new Map<string, StoredEvent>();
const bot = {} as Telegraf<BotContext>;
const assignedAt = new Date('2026-07-27T06:00:00Z'); // Monday 09:00 Moscow
const day1 = new Date('2026-07-27T15:00:00Z');
const day2 = new Date('2026-07-28T15:00:00Z');
const day4 = new Date('2026-07-30T15:00:00Z');

const mockModule = (relative: string, exports: unknown): void => {
  const path = require.resolve(relative);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((part: Record<string, any>) => matches(doc, part));
    if (typeof condition !== 'object' || condition === null) return doc[key] === condition;
    return Object.entries(condition).every(([operator, value]) => {
      if (operator === '$exists') return (doc[key] !== undefined) === value;
      if (operator === '$lte') return doc[key] !== undefined && doc[key] <= value!;
      throw new Error(`Unexpected Mongo predicate ${operator}`);
    });
  });

before(() => {
  mockModule('../src/db/mongo.ts', { getDb: async () => ({ collection: (name: string) => {
    assert.equal(name, 'review_reminders');
    return {
      createIndex: async () => {},
      findOne: async (filter: Record<string, any>) =>
        structuredClone(documents.find((doc) => matches(doc, filter)) ?? null),
      find: (filter: Record<string, any>) => {
        let limit = Infinity;
        const cursor = {
          sort: () => cursor,
          limit: (value: number) => { limit = value; return cursor; },
          toArray: async () => structuredClone(documents.filter((doc) => matches(doc, filter)).slice(0, limit)),
        };
        return cursor;
      },
      updateOne: async (filter: Record<string, any>, update: Record<string, any>, options?: { upsert: boolean }) => {
        let doc = documents.find((item) => matches(item, filter));
        if (!doc && !options?.upsert) return { modifiedCount: 0 };
        if (!doc) {
          doc = { ...filter, ...update.$setOnInsert } as ReviewReminderDocument;
          documents.push(doc);
        }
        Object.assign(doc, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete (doc as Record<string, any>)[key];
        return { modifiedCount: 1 };
      },
    };
  } }) });
  mockModule('../src/data/scoreEventRepository.ts', {
    addScoreEvent: async (event: StoredEvent) => {
      if (events.has(event.eventKey)) return false;
      events.set(event.eventKey, event); return true;
    },
    hasScoreEvent: async (key: string) => events.has(key),
    hasReviewFeedbackScore: async (_projectId: number, _iid: number, username: string) =>
      [...events.values()].some((event) => event.username.toLowerCase() === username.toLowerCase() &&
        ['review_comment', 'review_approved'].includes(event.eventType)),
  });
  mockModule('../src/data/mergeRequestRepository.ts', {
    findMergeRequest: async () => structuredClone(mr),
    updateMergeRequest: async (_projectId: number, _iid: number, update: Partial<MergeRequestDocument>) => {
      Object.assign(mr, structuredClone(update));
    },
  });
  mockModule('../src/data/userStore.ts', {
    getUserByGitlabUsername: async (username: string) => users.find((user) => user.gitlabUsername === username),
    listLeadUsers: async () => users.filter((user) => user.isLead && user.isActive !== false && user.isAllowed !== false),
    listActiveReviewers: async () => users.filter((user) => !user.isLead && user.isReviewer !== false &&
      user.isActive !== false && user.isAllowed !== false).map((user) => user.gitlabUsername),
  });
  mockModule('../src/messages/format.ts', {
    formatGitlabUserLabel: async (username: string) => username, escapeHtml: (value: string) => value,
  });
  mockModule('../src/messages/recipients.ts', {
    isWithinWorkingHours, getLeadRecipients: async () => [],
    getRecipientByGitlabUsername: async (username: string) => ({ gitlabUsername: username, chatId: 1 }),
  });
  mockModule('../src/messages/send.ts', {
    deliverHtmlMessage: async () => {}, deliverHtmlMessageToRecipients: async () => {},
  });
  mockModule('../src/gitlab/api.ts', {
    fetchMergeRequestNotes: async () => { noteReads += 1; return historicalNotes; },
  });
  reminders = require('../src/data/reviewReminderRepository.ts');
  reminderService = require('../src/services/reviewReminderService.ts');
  scheduler = require('../src/services/reviewReminderScheduler.ts');
  approvals = require('../src/services/approvalNotifications.ts');
  scoring = require('../src/services/gameScoring.ts');
});

beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: assignedAt });
  mr = {
    projectId: 1, projectPath: 'test', mrId: 1, iid: 1, title: 'Test', sourceBranch: 'feature',
    targetBranch: 'main', url: 'https://gitlab.example/mr/1', author: { gitlabUsername: 'author' },
    state: 'opened', reviewers: ['reviewer.one', 'reviewer.two'], approvedBy: [],
    reviewCommentsSyncedAt: assignedAt,
  };
  users = ['author', 'reviewer.one', 'reviewer.two', 'tech.lead', 'team.lead'].map((username) => ({
    gitlabUsername: username, isLead: username.endsWith('.lead'), isAllowed: true, isActive: true,
  }));
  documents = []; events.clear(); historicalNotes = []; noteReads = 0;
});

const assign = async (): Promise<void> => {
  await reminders.upsertReviewReminder({ projectId: 1, iid: 1, reviewerUsername: 'reviewer.two', assignedAt });
};
const invite = async (): Promise<void> => {
  mr.approvedBy = ['reviewer.one'];
  await approvals.notifyMergeRequestApprovals(bot, mr);
};
const penalties = (): StoredEvent[] => [...events.values()].filter((event) => event.eventType === 'review_overdue');

describe('one-day and two-day review penalties', () => {
  it('charges exactly -25 at each deadline and never again after day two', async (t) => {
    await assign();
    t.mock.timers.setTime(new Date(day1.getTime() - 1).getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
    t.mock.timers.setTime(day1.getTime());
    await Promise.all([scheduler.runReviewReminderScheduler(bot), scheduler.runReviewReminderScheduler(bot)]);
    await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => event.points), [-25]);
    t.mock.timers.setTime(day2.getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => event.metadata?.overdueDay), [1, 2]);
    t.mock.timers.setTime(day4.getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().reduce((total, event) => total + event.points, 0), -50);
  });

  it('catches up after downtime, without duplicating either stage', async (t) => {
    await assign(); t.mock.timers.setTime(day4.getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => event.occurredAt), [day1, day2]);
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 2);
  });

  it('stops future penalties after a comment but keeps the already charged first day', async (t) => {
    await assign(); t.mock.timers.setTime(day1.getTime()); await scheduler.runReviewReminderScheduler(bot);
    await reminderService.markReviewCompletedForReviewer(mr, 'reviewer.two');
    t.mock.timers.setTime(day2.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 1);
  });

  it('does not count weekend hours', async (t) => {
    const friday = new Date('2026-07-31T12:00:00Z');
    await reminders.upsertReviewReminder({ projectId: 1, iid: 1, reviewerUsername: 'reviewer.two', assignedAt: friday });
    t.mock.timers.setTime(new Date('2026-08-03T11:59:59Z').getTime());
    await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 0);
    t.mock.timers.setTime(new Date('2026-08-03T12:00:00Z').getTime());
    await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 1);
    t.mock.timers.setTime(new Date('2026-08-04T12:00:00Z').getTime());
    await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 2);
  });

  it('preserves an old two-day penalty without adding the new first-day charge retrospectively', async (t) => {
    await assign();
    const key = `review:overdue:${scoring.buildReviewAssignmentKey(documents[0]!)}`;
    events.set(key, { eventKey: key, username: 'reviewer.two', eventType: 'review_overdue', points: -25,
      category: 'review', projectId: 1, iid: 1, occurredAt: day2, description: 'Legacy penalty' });
    t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 1);
  });

  it('rechecks a comment received while waiting for the MR lock', async (t) => {
    await assign(); t.mock.timers.setTime(day1.getTime());
    let release = (): void => {};
    let entered = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const comment = withMergeRequestLock(1, 1, async () => {
      entered(); await held;
      await reminderService.markReviewCompletedForReviewer(mr, 'reviewer.two');
    });
    await acquired;
    const run = scheduler.runReviewReminderScheduler(bot);
    release(); await Promise.all([comment, run]);
    assert.equal(penalties().length, 0);
  });

  for (const changes of [{ state: 'closed' }, { isDraft: true }, { approvedBy: ['reviewer.two'] }, { reviewers: [] }]) {
    it(`does not penalize a developer when ${JSON.stringify(changes)}`, async (t) => {
      await assign(); Object.assign(mr, changes); t.mock.timers.setTime(day4.getTime());
      await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 0);
    });
  }

  for (const changes of [{ isActive: false }, { isAllowed: false }, { isReviewer: false }]) {
    it(`does not penalize a developer who is unavailable: ${JSON.stringify(changes)}`, async (t) => {
      await assign(); Object.assign(users.find((user) => user.gitlabUsername === 'reviewer.two')!, changes);
      t.mock.timers.setTime(day4.getTime());
      await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 0);
    });
  }
});

describe('lead review penalties', () => {
  it('starts only with the invitation after a developer approve and does not restart on sync', async (t) => {
    await approvals.notifyMergeRequestApprovals(bot, mr); assert.equal(documents.length, 0);
    t.mock.timers.setTime(day4.getTime()); await invite();
    assert.equal(documents.length, 2);
    assert.ok(documents.every((doc) => doc.assignedAt.getTime() === day4.getTime() && doc.isLeadReview));
    await approvals.notifyMergeRequestApprovals(bot, mr);
    await reminderService.syncReviewRemindersForMr(mr, mr.reviewers!, new Date());
    assert.ok(documents.filter((doc) => doc.isLeadReview).every((doc) => !doc.inactiveAt));
    await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 0);
  });

  it('penalizes only the lead who did not respond, twice at most', async (t) => {
    await invite(); mr.reviewCommenters = ['TECH.LEAD'];
    t.mock.timers.setTime(day1.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => event.username), ['team.lead']);
    t.mock.timers.setTime(day2.getTime()); await scheduler.runReviewReminderScheduler(bot);
    t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => [event.username, event.points]), [['team.lead', -25], ['team.lead', -25]]);
  });

  it('does not penalize an author lead or a lead who already approved', async (t) => {
    mr.author.gitlabUsername = 'tech.lead'; await invite();
    assert.deepEqual(documents.map((doc) => doc.reviewerUsername), ['team.lead']);
    mr.approvedBy!.push('team.lead');
    t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
  });

  it('continues penalizing the second lead when the first lead has approved', async (t) => {
    await invite(); mr.approvedBy!.push('tech.lead');
    t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.deepEqual(penalties().map((event) => event.username), ['team.lead', 'team.lead']);
  });

  it('recognizes earlier feedback even if the comment was stored only in XP history', async (t) => {
    for (const username of ['tech.lead', 'team.lead']) {
      const key = `old:${username}`;
      events.set(key, { eventKey: key, username, eventType: 'review_comment', points: 5,
        category: 'review', projectId: 1, iid: 1, occurredAt: assignedAt, description: 'Old comment' });
    }
    await invite(); t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
  });

  it('does not penalize an unavailable or forbidden lead', async (t) => {
    await invite(); users.find((user) => user.gitlabUsername === 'tech.lead')!.isActive = false;
    users.find((user) => user.gitlabUsername === 'team.lead')!.isAllowed = false;
    t.mock.timers.setTime(day4.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
  });

  it('restores old lead comments from GitLab once, including inline discussions', async (t) => {
    delete mr.reviewCommentsSyncedAt;
    historicalNotes = [
      { authorUsername: 'TECH.LEAD', system: false },
      { authorUsername: 'team.lead', system: false },
    ];
    await invite(); t.mock.timers.setTime(day4.getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
    assert.equal(noteReads, 1);
    assert.ok(mr.reviewCommentsSyncedAt);
  });

  it('does not penalize leads when old comment history could not be verified', async (t) => {
    delete mr.reviewCommentsSyncedAt; historicalNotes = undefined;
    await invite(); t.mock.timers.setTime(day2.getTime());
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 0);
    historicalNotes = [];
    await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 4);
  });

  it('does not repeat lead penalties if review is restarted after Draft', async (t) => {
    await invite(); t.mock.timers.setTime(day2.getTime()); await scheduler.runReviewReminderScheduler(bot);
    assert.equal(penalties().length, 4);
    await reminderService.markAllRemindersInactiveForMr(mr);
    t.mock.timers.setTime(day4.getTime()); await invite();
    assert.ok(documents.every((doc) => !doc.inactiveAt && !doc.escalatedAt));
    t.mock.timers.setTime(new Date('2026-08-03T15:00:00Z').getTime());
    await scheduler.runReviewReminderScheduler(bot); assert.equal(penalties().length, 4);
  });
});
