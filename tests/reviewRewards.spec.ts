import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { ReviewRewardDay } from '../src/data/reviewRewardRepository';
import type { ReviewScoreActivity, ReviewScoreBalance } from '../src/data/scoreEventRepository';

let rewards: typeof import('../src/services/reviewRewards');
const days = new Map<string, ReviewRewardDay>();
const fullTeam = ['alice', 'bob', 'charlie', 'developer.four', 'developer.five'];
let baseline: ReviewScoreBalance[] = [];
let activity: ReviewScoreActivity[] = [];
let participants = [...fullTeam];
let baselineReads: string[] = [];
let successfulSaves = 0;
let collisions = 0;

const clone = <T>(value: T): T => structuredClone(value);
const balance = (usernameLower: string, points: number): ReviewScoreBalance => ({ usernameLower, points });
const event = (usernameLower: string, points: number, at: string): ReviewScoreActivity => ({
  usernameLower, points, at: new Date(at), eventKey: `${usernameLower}:${at}:${points}`,
});
const now = new Date('2026-10-20T12:00:00Z');

before(() => {
  const repository = require.resolve('../src/data/reviewRewardRepository.ts');
  require.cache[repository] = {
    id: repository, filename: repository, loaded: true,
    exports: {
      findReviewRewardDay: async (day: string) => clone(days.get(day) ?? null),
      listReviewRewardParticipants: async () => [...participants],
      ensureReviewRewardDay: async (input: ReviewRewardDay) => {
        if (!days.has(input.day)) days.set(input.day, clone(input));
        return clone(days.get(input.day)!);
      },
      saveDailyReviewGrants: async (day: string, revision: number, grants: ReviewRewardDay['grants']) => {
        await Promise.resolve();
        const stored = days.get(day)!;
        if (stored.revision !== revision) { collisions += 1; return false; }
        days.set(day, clone({ ...stored, grants, revision: revision + 1 }));
        successfulSaves += 1;
        return true;
      },
    },
  } as NodeJS.Module;
  const scores = require.resolve('../src/data/scoreEventRepository.ts');
  require.cache[scores] = {
    id: scores, filename: scores, loaded: true,
    exports: {
      loadReviewScoreBaseline: async (season: string, at: Date) => {
        baselineReads.push(season);
        assert.equal(at.toISOString().slice(11), '21:00:00.000Z');
        return clone(baseline);
      },
      listReviewScoreActivity: async (_season: string, _start: Date, end: Date) =>
        clone(activity.filter((item) => item.at <= end)),
    },
  } as NodeJS.Module;
  rewards = require('../src/services/reviewRewards.ts');
});

beforeEach(() => {
  days.clear(); baseline = []; activity = [];
  participants = [...fullTeam];
  baselineReads = []; successfulSaves = 0; collisions = 0;
});

describe('daily review reward grants', () => {
  it('skips both leads and grants one place at a personal threshold of 600 review XP', async () => {
    baseline = [
      balance('tech.lead', 2_000), balance('team.lead', 1_900),
      balance('alice', 600), balance('bob', 599), balance('charlie', 590),
    ];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['alice']);
    assert.equal(days.get('2026-10-20')?.grants[0]?.grantedAt.toISOString(), '2026-10-19T21:00:00.000Z');
  });

  it('does not revoke a grant after intraday ranking changes or a penalty below 600', async () => {
    baseline = [balance('alice', 1_000), balance('bob', 990), balance('charlie', 980)];
    await rewards.getReviewExemptUsernames(now);
    activity = [event('charlie', 500, '2026-10-20T13:00:00Z'), event('alice', -500, '2026-10-20T14:00:00Z')];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(new Date('2026-10-20T15:00:00Z'))], ['alice']);
    baseline = [balance('alice', 500), balance('bob', 990), balance('charlie', 1_480)];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(new Date('2026-10-20T21:00:00Z'))], ['charlie']);
  });

  it('fills an empty place with the first threshold crossing, not the highest later score', async () => {
    baseline = [balance('alice', 590), balance('bob', 590), balance('charlie', 590)];
    activity = [
      event('charlie', 300, '2026-10-20T11:00:00Z'),
      event('bob', 10, '2026-10-20T10:00:00Z'),
    ];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['bob']);
    assert.equal(days.get('2026-10-20')?.grants[0]?.points, 600);
    assert.equal(days.get('2026-10-20')?.grants[0]?.grantedAt.toISOString(), '2026-10-20T10:00:00.000Z');
  });

  it('does not give a place below 600 and fills it when someone qualifies later', async () => {
    baseline = [balance('alice', 599), balance('bob', 590)];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], []);
    activity.push(event('bob', 10, '2026-10-20T13:00:00Z'));
    assert.deepEqual([...await rewards.getReviewExemptUsernames(new Date('2026-10-20T14:00:00Z'))], ['bob']);
  });

  it('honors the first crossing even if an approval was withdrawn before the bot restarted', async () => {
    baseline = [balance('alice', 590), balance('bob', 590), balance('charlie', 590)];
    activity = [
      event('bob', 30, '2026-10-20T09:00:00Z'),
      event('bob', -30, '2026-10-20T10:00:00Z'),
      event('charlie', 100, '2026-10-20T11:00:00Z'),
    ];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['bob']);
  });

  it('settles simultaneous threshold crossings in stable username order', async () => {
    baseline = [balance('bob', 590), balance('charlie', 590)];
    activity = [
      event('charlie', 30, '2026-10-20T10:00:00Z'),
      event('bob', 10, '2026-10-20T10:00:00Z'),
    ];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['bob']);
  });

  it('preserves the recorded grant when the application module restarts', async () => {
    baseline = [balance('alice', 700), balance('bob', 650)];
    await rewards.getReviewExemptUsernames(now);
    baseline = [balance('charlie', 5_000)];
    const path = require.resolve('../src/services/reviewRewards.ts');
    delete require.cache[path];
    const restarted: typeof rewards = require(path);
    assert.deepEqual([...await restarted.getReviewExemptUsernames(now)], ['alice']);
    assert.equal(baselineReads.length, 1);
  });

  it('serializes concurrent day creation and grants using revision checks', async () => {
    activity = [event('alice', 600, '2026-10-20T10:00:00Z'), event('bob', 650, '2026-10-20T11:00:00Z')];
    const results = await Promise.all(Array.from({ length: 20 }, () => rewards.getReviewExemptUsernames(now)));
    assert.ok(results.every((result) => [...result].join(',') === 'alice'));
    assert.equal(successfulSaves, 1);
    assert.ok(collisions > 0);
    assert.equal(days.size, 1);
    assert.equal(days.get('2026-10-20')?.grants.length, 1);
  });

  it('resets the award at the Moscow month boundary using the new season', async () => {
    baseline = [balance('alice', 700), balance('bob', 650)];
    await rewards.getReviewExemptUsernames(new Date('2026-10-31T20:59:59Z'));
    baseline = [];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(new Date('2026-10-31T21:00:00Z'))], []);
    assert.deepEqual(baselineReads, ['2026-10', '2026-11']);
  });

  it('uses a stable username order for tied midnight scores', async () => {
    baseline = [balance('charlie', 700), balance('bob', 700), balance('alice', 700)];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['alice']);
  });

  it('does not transfer the daily place when the winner goes on vacation', async () => {
    baseline = [balance('alice', 700), balance('bob', 650), balance('charlie', 640)];
    await rewards.getReviewExemptUsernames(now);
    participants = fullTeam.filter((name) => name !== 'alice');
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], []);
    assert.equal(days.get('2026-10-20')?.grants[0]?.usernameLower, 'alice');
  });

  it('keeps one winner with five developers and three reviewers after a vacation leaves four', async () => {
    baseline = [balance('alice', 700), balance('bob', 650)];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['alice']);
    participants = ['alice', 'bob', 'charlie', 'developer.four'];
    const status = await rewards.getReviewRewardStatus(now);
    assert.equal(status.paused, false);
    assert.equal(status.activeReviewers - status.exemptUsernames.size, 3);
  });

  it('pauses the program when fewer than three would remain and restores the same winner after a return', async () => {
    baseline = [balance('alice', 700), balance('bob', 650)];
    await rewards.getReviewExemptUsernames(now);
    participants = ['alice', 'bob', 'charlie'];
    const paused = await rewards.getReviewRewardStatus(now);
    assert.equal(paused.paused, true);
    assert.deepEqual([...paused.exemptUsernames], []);
    participants = [...fullTeam];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['alice']);
    assert.equal(days.get('2026-10-20')?.grants[0]?.usernameLower, 'alice');
  });
});
