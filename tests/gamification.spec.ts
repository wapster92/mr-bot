import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MergeRequestDocument } from '../src/data/mergeRequestRepository';
import {
  GAME_POINTS,
  getMergeSpeedReward,
  getReviewCommentPoints,
  getReviewResponseReward,
} from '../src/services/gameRules';
import { getSeasonKey } from '../src/services/gameSeason';
import { isMergeRequestGameReady } from '../src/services/mergeReadiness';
import {
  addWorkingMinutes,
  getWorkingMinutesBetween,
  isWithinWorkingHours,
} from '../src/services/workingHours';

const createMergeRequest = (
  update: Partial<MergeRequestDocument> = {},
): MergeRequestDocument => ({
  projectId: 1,
  projectPath: 'group/project',
  mrId: 100,
  iid: 10,
  title: 'Test MR',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  url: 'https://gitlab.example/group/project/-/merge_requests/10',
  author: { gitlabUsername: 'author' },
  state: 'opened',
  isDraft: false,
  lastLintStatus: 'success',
  mergeStatus: 'can_be_merged',
  detailedMergeStatus: 'mergeable',
  approvedBy: ['reviewer.one', 'reviewer.two', 'lead.user'],
  ...update,
});

describe('game season', () => {
  it('changes exactly on the first day in Moscow', () => {
    assert.equal(getSeasonKey(new Date('2026-07-31T20:59:59.000Z')), '2026-07');
    assert.equal(getSeasonKey(new Date('2026-07-31T21:00:00.000Z')), '2026-08');
  });
});

describe('working-time game deadlines', () => {
  const user = {
    gitlabUsername: 'reviewer',
    isAllowed: true,
    isActive: true,
  };

  it('does not count Saturday and Sunday', () => {
    const assignedAt = new Date('2026-07-31T12:00:00.000Z'); // Friday 15:00 MSK
    const deadline = addWorkingMinutes(user, assignedAt, 18 * 60);
    assert.equal(deadline.toISOString(), '2026-08-04T12:00:00.000Z');
    assert.equal(getWorkingMinutesBetween(user, assignedAt, deadline), 18 * 60);
  });

  it('keeps weekends disabled with ignoreWorkHours', () => {
    assert.equal(
      isWithinWorkingHours(
        { ...user, ignoreWorkHours: true },
        new Date('2026-08-01T09:00:00.000Z'),
      ),
      false,
    );
  });
});

describe('game balance', () => {
  it('limits paid review comments to three positions', () => {
    assert.equal(getReviewCommentPoints(0), 20);
    assert.equal(getReviewCommentPoints(1), 10);
    assert.equal(getReviewCommentPoints(2), 5);
    assert.equal(getReviewCommentPoints(3), undefined);
  });

  it('uses exclusive response speed bonuses', () => {
    assert.equal(getReviewResponseReward(180, 540).points, 15);
    assert.equal(getReviewResponseReward(181, 540).points, 10);
    assert.equal(getReviewResponseReward(541, 540).points, 0);
  });

  it('uses the documented merge rewards and penalties', () => {
    assert.equal(getMergeSpeedReward(540, 540)?.points, 20);
    assert.equal(getMergeSpeedReward(541, 540)?.points, 10);
    assert.equal(getMergeSpeedReward(1_081, 540), undefined);
    assert.equal(GAME_POINTS.reviewOverdue, -25);
    assert.equal(GAME_POINTS.mergeOverdue, -25);
  });
});

describe('merge readiness', () => {
  const leads = new Set(['lead.user']);
  const activeUsers = new Set([
    'reviewer.one',
    'reviewer.two',
    'lead.user',
  ]);

  it('requires green lint, two regular approves and one lead approve', () => {
    assert.equal(isMergeRequestGameReady(createMergeRequest(), leads, activeUsers), true);
    assert.equal(
      isMergeRequestGameReady(
        createMergeRequest({ approvedBy: ['reviewer.one', 'lead.user'] }),
        leads,
        activeUsers,
      ),
      false,
    );
    assert.equal(
      isMergeRequestGameReady(
        createMergeRequest({ lastLintStatus: 'failed' }),
        leads,
        activeUsers,
      ),
      false,
    );
  });

  it('stops the timer for Draft and explicit GitLab blockers', () => {
    assert.equal(
      isMergeRequestGameReady(
        createMergeRequest({ isDraft: true }),
        leads,
        activeUsers,
      ),
      false,
    );
    assert.equal(
      isMergeRequestGameReady(
        createMergeRequest({ detailedMergeStatus: 'conflict' }),
        leads,
        activeUsers,
      ),
      false,
    );
  });

  it('does not count approvals of inactive users', () => {
    assert.equal(
      isMergeRequestGameReady(
        createMergeRequest(),
        leads,
        new Set(['reviewer.one', 'reviewer.two']),
      ),
      false,
    );
  });
});
