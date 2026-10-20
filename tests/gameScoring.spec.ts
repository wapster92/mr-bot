import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import type { UserRecord } from '../src/data/userTypes';

type StoredEvent = {
  eventKey: string;
  commentSlotKey?: string;
  eventType: string;
  points: number;
  username?: string;
  projectId?: number;
  iid?: number;
  metadata?: { assignmentKey?: string; discussionKey?: string };
};

const events = new Map<string, StoredEvent>();
const commentSlots = new Set<string>();
const userOverrides = new Map<string, Partial<UserRecord> | null>();
let reminderReads = 0;
const reminder = {
  projectId: 1,
  iid: 10,
  reviewerUsername: 'reviewer.one',
  reviewerUsernameLower: 'reviewer.one',
  assignedAt: new Date('2026-07-27T06:00:00.000Z'),
  gameStartedAt: new Date('2026-07-27T06:00:00.000Z'),
  reminderCount: 0,
};

let scoring: typeof import('../src/services/gameScoring');

before(() => {
  const scoreRepositoryPath = require.resolve('../src/data/scoreEventRepository.ts');
  const reminderRepositoryPath = require.resolve(
    '../src/data/reviewReminderRepository.ts',
  );
  const userStorePath = require.resolve('../src/data/userStore.ts');
  const mergeRequestRepositoryPath = require.resolve(
    '../src/data/mergeRequestRepository.ts',
  );

  require.cache[scoreRepositoryPath] = {
    id: scoreRepositoryPath,
    filename: scoreRepositoryPath,
    loaded: true,
    exports: {
      addScoreEvent: async (event: StoredEvent) => {
        if (
          events.has(event.eventKey) ||
          (event.commentSlotKey && commentSlots.has(event.commentSlotKey))
        ) {
          return false;
        }
        events.set(event.eventKey, event);
        if (event.commentSlotKey) {
          commentSlots.add(event.commentSlotKey);
        }
        return true;
      },
      hasScoreEvent: async (eventKey: string) => events.has(eventKey),
      findScoreEvent: async (eventKey: string) => events.get(eventKey) ?? null,
      countReviewCommentScores: async (assignmentKey: string) =>
        [...events.values()].filter(
          (event) =>
            event.eventType === 'review_comment' &&
            event.metadata?.assignmentKey === assignmentKey,
        ).length,
      hasScoredReviewComment: async () =>
        [...events.values()].some((event) => event.eventType === 'review_comment'),
      hasScoredReviewDiscussion: async (projectId: number, iid: number, username: string, discussionKey: string) =>
        [...events.values()].some((event) => event.eventType === 'review_comment' &&
          event.projectId === projectId && event.iid === iid &&
          event.username?.toLowerCase() === username.toLowerCase() && event.metadata?.discussionKey === discussionKey),
    },
  } as NodeJS.Module;
  require.cache[reminderRepositoryPath] = {
    id: reminderRepositoryPath,
    filename: reminderRepositoryPath,
    loaded: true,
    exports: {
      ensureReviewReminderGameStarted: async (projectId: number, iid: number, username: string) => {
        reminderReads += 1;
        return { ...reminder, projectId, iid, reviewerUsername: username, reviewerUsernameLower: username.toLowerCase() };
      },
    },
  } as NodeJS.Module;
  require.cache[userStorePath] = {
    id: userStorePath,
    filename: userStorePath,
    loaded: true,
    exports: {
      getUserByGitlabUsername: async (username: string) => {
        const overrides = userOverrides.get(username.toLowerCase());
        return overrides === null ? undefined : {
          gitlabUsername: username, isAllowed: true, isActive: true,
          isLead: username.toLowerCase() === 'tech.lead', ...overrides,
        };
      },
    },
  } as NodeJS.Module;
  require.cache[mergeRequestRepositoryPath] = {
    id: mergeRequestRepositoryPath,
    filename: mergeRequestRepositoryPath,
    loaded: true,
    exports: {
      markMergeRequestGameOverdue: async () => {},
    },
  } as NodeJS.Module;

  scoring = require('../src/services/gameScoring.ts');
});

describe('assigned approval and voluntary comment rewards', () => {
  const mr: MergeRequestDocument = {
    projectId: 1, projectPath: 'group/project', mrId: 100, iid: 10, title: 'Test',
    sourceBranch: 'feature', targetBranch: 'main', url: 'https://gitlab.example/mr/10',
    author: { gitlabUsername: 'author' }, reviewers: ['reviewer.one'],
  };
  const occurredAt = new Date('2026-07-27T07:00:00Z');
  const comment = (username: string, discussionKey = 'discussion', doc = mr, at = occurredAt): Promise<void> =>
    scoring.recordReviewCommentScore({ mr: doc, reviewerUsername: username, noteId: discussionKey, discussionKey, occurredAt: at });
  const approve = (username: string, doc = mr): Promise<void> =>
    scoring.recordReviewApprovalScore({ mr: doc, username, occurredAt });

  beforeEach(() => { events.clear(); commentSlots.clear(); userOverrides.clear(); reminderReads = 0; });
  afterEach(() => { events.clear(); commentSlots.clear(); userOverrides.clear(); reminderReads = 0; });

  it('does not pay a non-assigned approve even after the lead approved', async () => {
    await approve('outsider', { ...mr, approvedBy: ['tech.lead'] });
    await scoring.recordReviewUnapprovalScore({ mr, username: 'outsider', occurredAt });
    assert.equal(events.size, 0);
    assert.equal(reminderReads, 0);
  });

  it('pays voluntary comments only once per discussion with a three-discussion cap and no speed bonus', async () => {
    await Promise.all(['one', 'one', 'two', 'three', 'four'].map((key) => comment('outsider', key)));
    assert.deepEqual([...events.values()].map((event) => event.points), [20, 10, 5]);
    assert.ok([...events.values()].every((event) => event.eventType === 'review_comment'));
    assert.equal(reminderReads, 0);
    await comment('OUTSIDER', 'one');
    assert.equal(events.size, 3);
  });

  it('does not unlock approval XP after a voluntary comment', async () => {
    await comment('outsider'); await approve('outsider');
    assert.deepEqual([...events.values()].map((event) => event.points), [20]);
    assert.equal(reminderReads, 0);
  });

  it('keeps approval and first-response rewards for assigned reviewers, case-insensitively', async () => {
    await approve('REVIEWER.ONE');
    assert.deepEqual([...events.values()].map((event) => event.points), [30, 15]);
  });

  it('keeps the reduced lead approval reward without requiring a developer assignment', async () => {
    await approve('TECH.LEAD');
    assert.deepEqual([...events.values()].map((event) => event.points), [10]);
  });

  it('does not pay approval to a former assignee but still pays their voluntary comment', async () => {
    const reassigned = { ...mr, reviewers: [] };
    await approve('reviewer.one', reassigned);
    await comment('reviewer.one', 'discussion', reassigned);
    assert.deepEqual([...events.values()].map((event) => event.points), [20]);
    assert.equal(reminderReads, 0);
  });

  it('allows author-only users to help with comments, never approval XP or response bonuses', async () => {
    userOverrides.set('outsider', { isReviewer: false });
    await comment('outsider'); await approve('outsider', { ...mr, reviewers: ['outsider'] });
    assert.deepEqual([...events.values()].map((event) => event.points), [20]);
    assert.equal(reminderReads, 0);
  });

  it('does not pay the same discussion again after a volunteer becomes assigned', async () => {
    const beforeAssignment = new Date('2026-07-27T05:00:00Z');
    await comment('reviewer.one', 'shared', { ...mr, reviewers: [] }, beforeAssignment);
    await comment('reviewer.one', 'shared', mr, beforeAssignment);
    assert.deepEqual([...events.values()].map((event) => event.points), [20]);
  });

  it('does not pay the same discussion again when an assignee becomes a volunteer', async () => {
    await comment('reviewer.one');
    const initialCount = events.size;
    await comment('reviewer.one', 'discussion', { ...mr, reviewers: [] });
    assert.equal(events.size, initialCount);
  });

  for (const override of [{ isActive: false }, { isAllowed: false }, null]) {
    it(`rejects unavailable participants: ${JSON.stringify(override)}`, async () => {
      userOverrides.set('outsider', override);
      await comment('outsider'); await approve('outsider', { ...mr, reviewers: ['outsider'] });
      assert.equal(events.size, 0);
    });
  }

  for (const update of [{ isDraft: true }, { state: 'closed' }, { state: 'merged' }, { author: { gitlabUsername: 'outsider' } }]) {
    it(`does not pay voluntary comments or approval for ${JSON.stringify(update)}`, async () => {
      const doc = { ...mr, ...update };
      await comment('outsider', 'discussion', doc); await approve('outsider', doc);
      assert.equal(events.size, 0);
    });
  }
});

describe('game scoring idempotency', () => {
  const mr = {
    projectId: 1,
    projectPath: 'group/project',
    mrId: 100,
    iid: 10,
    title: 'Test MR',
    sourceBranch: 'feature/test',
    targetBranch: 'main',
    url: 'https://gitlab.example/mr/10',
    author: { gitlabUsername: 'author' },
    reviewers: ['reviewer.one'],
  };
  const occurredAt = new Date('2026-07-27T07:00:00.000Z');

  it('pays only three distinct discussions and one response bonus', async () => {
    await Promise.all(
      ['discussion-1', 'discussion-1', 'discussion-2', 'discussion-3', 'discussion-4'].map(
        (discussionKey, index) =>
          scoring.recordReviewCommentScore({
            mr,
            reviewerUsername: 'reviewer.one',
            noteId: String(index + 1),
            discussionKey,
            occurredAt,
          }),
      ),
    );

    const commentEvents = [...events.values()].filter(
      (event) => event.eventType === 'review_comment',
    );
    const responseEvents = [...events.values()].filter((event) =>
      event.eventType.startsWith('review_response'),
    );
    assert.deepEqual(
      commentEvents.map((event) => event.points),
      [20, 10, 5],
    );
    assert.equal(responseEvents.length, 1);
    assert.equal(responseEvents[0]?.points, 15);
  });

  it('does not farm approve and unapprove webhooks', async () => {
    await scoring.recordReviewApprovalScore({
      mr,
      username: 'reviewer.one',
      occurredAt,
    });
    await scoring.recordReviewApprovalScore({
      mr,
      username: 'reviewer.one',
      occurredAt,
    });
    await scoring.recordReviewUnapprovalScore({
      mr,
      username: 'reviewer.one',
      occurredAt,
    });
    await scoring.recordReviewUnapprovalScore({
      mr,
      username: 'reviewer.one',
      occurredAt,
    });

    const approveEvents = [...events.values()].filter(
      (event) => event.eventType === 'review_approved',
    );
    const unapproveEvents = [...events.values()].filter(
      (event) => event.eventType === 'review_unapproved',
    );
    assert.equal(approveEvents.length, 1);
    assert.equal(approveEvents[0]?.points, 30);
    assert.equal(unapproveEvents.length, 1);
    assert.equal(unapproveEvents[0]?.points, -30);
  });

  it('pays leads a reduced comment and approval reward without a response bonus', async () => {
    const leadMr = {
      ...mr, iid: 11,
      createdAt: new Date('2026-07-27T06:00:00.000Z'),
    };
    const initialCount = events.size;
    await scoring.recordReviewCommentScore({
      mr: leadMr, reviewerUsername: 'tech.lead', noteId: 'lead-note',
      discussionKey: 'lead-discussion', occurredAt,
    });
    await scoring.recordReviewApprovalScore({ mr: leadMr, username: 'tech.lead', occurredAt });
    const leadEvents = [...events.values()].slice(initialCount);
    assert.deepEqual(leadEvents.map((event) => event.points), [5, 10]);
    const afterFirstDelivery = events.size;
    await scoring.recordReviewCommentScore({
      mr: leadMr, reviewerUsername: 'tech.lead', noteId: 'lead-note',
      discussionKey: 'lead-discussion', occurredAt,
    });
    await scoring.recordReviewApprovalScore({ mr: leadMr, username: 'tech.lead', occurredAt });
    assert.equal(events.size, afterFirstDelivery);
  });

  it('limits lead comments before the final-review invitation without awarding early response XP', async () => {
    const leadMr = { ...mr, iid: 12 };
    const initialCount = events.size;
    for (let index = 0; index < 5; index += 1) {
      await scoring.recordReviewCommentScore({
        mr: leadMr, reviewerUsername: 'tech.lead', noteId: `early-${index}`,
        discussionKey: `early-discussion-${index}`,
        occurredAt: new Date(occurredAt.getTime() + index * 60_000),
      });
    }
    const leadEvents = [...events.values()].slice(initialCount);
    assert.deepEqual(leadEvents.map((event) => event.points), [5, 3, 2]);
  });

  it('does not score lead self-review or review on Draft/closed MRs', async () => {
    const initialCount = events.size;
    for (const update of [{ author: { gitlabUsername: 'tech.lead' } }, { isDraft: true }, { state: 'closed' }]) {
      const leadMr = { ...mr, iid: 13, ...update };
      await scoring.recordReviewCommentScore({
        mr: leadMr, reviewerUsername: 'tech.lead', noteId: 'own', discussionKey: 'own', occurredAt,
      });
      await scoring.recordReviewApprovalScore({ mr: leadMr, username: 'tech.lead', occurredAt });
    }
    assert.equal(events.size, initialCount);
  });

  it('reverses exactly the original approval reward even if the balance or role changed', async () => {
    const historicalKey = 'review:approve:1:14:tech.lead';
    events.set(historicalKey, { eventKey: historicalKey, eventType: 'review_approved', points: 30 });
    await scoring.recordReviewUnapprovalScore({ mr: { ...mr, iid: 14 }, username: 'tech.lead', occurredAt });
    assert.equal(events.get('review:unapprove:1:14:tech.lead')?.points, -30);
    await scoring.recordReviewUnapprovalScore({ mr: { ...mr, iid: 11 }, username: 'tech.lead', occurredAt });
    assert.equal(events.get('review:unapprove:1:11:tech.lead')?.points, -10);
  });
});
