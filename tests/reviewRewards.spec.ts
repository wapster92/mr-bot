import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { ScoreTotal } from '../src/data/scoreEventRepository';

let rewards: typeof import('../src/services/reviewRewards');
let totals: ScoreTotal[] = [];
let version = 0;
let reads = 0;
let requestedSeasons: string[] = [];

before(() => {
  const path = require.resolve('../src/data/scoreEventRepository.ts');
  require.cache[path] = {
    id: path, filename: path, loaded: true,
    exports: {
      getScoreVersion: () => version,
      listScoreTotals: async (input: { season: string; category?: string }) => {
        assert.equal(input.category, undefined); // Both author and review XP.
        reads += 1;
        requestedSeasons.push(input.season);
        return [...totals];
      },
    },
  } as NodeJS.Module;
  rewards = require('../src/services/reviewRewards.ts');
});

beforeEach(() => { version += 1; reads = 0; totals = []; requestedSeasons = []; });

const total = (username: string, points: number): ScoreTotal => ({
  username, usernameLower: username, points, reviewPoints: 0, authorPoints: points,
  reviewEarned: 0, authorEarned: points, penalties: 0, events: 1,
});
const now = new Date('2026-10-20T10:00:00Z');

describe('current-season review exemptions', () => {
  it('uses exactly the first two places with a personal threshold of 600 total XP', async () => {
    totals = [total('first', 750), total('second', 600), total('third', 600)];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['first', 'second']);
    totals = [total('first', 600), total('second', 599)]; version += 1;
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['first']);
  });

  it('does not transfer leader places to lower-ranked developers', async () => {
    totals = [total('tech.lead', 900), total('team.lead', 800), total('developer', 700)];
    const exemptSlots = await rewards.getReviewExemptUsernames(now);
    const developers = ['developer']; // Leads never enter the assignment pool.
    assert.deepEqual(developers.filter((name) => !exemptSlots.has(name)), developers);
    totals = [total('tech.lead', 900), total('developer', 700), total('third', 650)]; version += 1;
    const oneFreeSlot = await rewards.getReviewExemptUsernames(now);
    assert.deepEqual(['developer', 'third'].filter((name) => !oneFreeSlot.has(name)), ['third']);
  });

  it('refreshes immediately after a score change, including penalties', async () => {
    totals = [total('first', 700), total('second', 650)];
    await rewards.getReviewExemptUsernames(now);
    await rewards.getReviewExemptUsernames(now);
    assert.equal(reads, 1);
    totals = [total('third', 750), total('first', 599)]; version += 1;
    assert.deepEqual([...await rewards.getReviewExemptUsernames(now)], ['third']);
    assert.equal(reads, 2);
  });

  it('ends the previous-month exemption exactly at the Moscow season boundary', async () => {
    totals = [total('first', 700)];
    await rewards.getReviewExemptUsernames(new Date('2026-10-31T20:59:59Z'));
    totals = [];
    assert.deepEqual([...await rewards.getReviewExemptUsernames(new Date('2026-10-31T21:00:00Z'))], []);
    assert.deepEqual(requestedSeasons, ['2026-10', '2026-11']);
  });
});
