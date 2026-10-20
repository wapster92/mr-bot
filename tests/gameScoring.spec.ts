import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

type StoredEvent = {
  eventKey: string;
  commentSlotKey?: string;
  eventType: string;
  points: number;
  metadata?: { assignmentKey?: string };
};

const events = new Map<string, StoredEvent>();
const commentSlots = new Set<string>();
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
      countReviewCommentScores: async (assignmentKey: string) =>
        [...events.values()].filter(
          (event) =>
            event.eventType === 'review_comment' &&
            event.metadata?.assignmentKey === assignmentKey,
        ).length,
      hasScoredReviewComment: async () =>
        [...events.values()].some((event) => event.eventType === 'review_comment'),
    },
  } as NodeJS.Module;
  require.cache[reminderRepositoryPath] = {
    id: reminderRepositoryPath,
    filename: reminderRepositoryPath,
    loaded: true,
    exports: {
      ensureReviewReminderGameStarted: async () => reminder,
    },
  } as NodeJS.Module;
  require.cache[userStorePath] = {
    id: userStorePath,
    filename: userStorePath,
    loaded: true,
    exports: {
      getUserByGitlabUsername: async (username: string) => ({
        gitlabUsername: username,
        isAllowed: true,
        isActive: true,
        isLead: username === 'tech.lead',
      }),
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

  it('pays lead comments and approval with one response bonus after the review stage starts', async () => {
    const leadMr = {
      ...mr, iid: 11,
      createdAt: new Date('2026-07-27T06:00:00.000Z'),
      leadReviewStartedAt: new Date('2026-07-27T06:00:00.000Z'),
    };
    const initialCount = events.size;
    await scoring.recordReviewCommentScore({
      mr: leadMr, reviewerUsername: 'tech.lead', noteId: 'lead-note',
      discussionKey: 'lead-discussion', occurredAt,
    });
    await scoring.recordReviewApprovalScore({ mr: leadMr, username: 'tech.lead', occurredAt });
    const leadEvents = [...events.values()].slice(initialCount);
    assert.deepEqual(leadEvents.map((event) => event.points), [20, 15, 30]);
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
    assert.deepEqual(leadEvents.map((event) => event.points), [20, 10, 5]);
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
});
