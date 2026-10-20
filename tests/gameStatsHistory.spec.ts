import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { getSeasonKey, shiftSeason } from '../src/services/gameSeason';

let stats: typeof import('../src/services/gameStats');
const requests: Array<{ season: string; category?: string }> = [];
const currentTotals = [
  { username: 'tech.lead', usernameLower: 'tech.lead', points: 2_000 },
  { username: 'team.lead', usernameLower: 'team.lead', points: 1_900 },
  { username: 'new.top', usernameLower: 'new.top', points: 1_200 },
  { username: 'winner', usernameLower: 'winner', points: 590 },
];

before(() => {
  const scorePath = require.resolve('../src/data/scoreEventRepository.ts');
  require.cache[scorePath] = {
    id: scorePath, filename: scorePath, loaded: true,
    exports: {
      listScoreTotals: async (input: { season: string; category?: string; usernames?: string[] }) => {
        requests.push(input);
        if (input.season === getSeasonKey()) {
          return currentTotals.filter((total) => !input.usernames || input.usernames.includes(total.usernameLower));
        }
        return input.season === '2000-01' ? [] : [{
          username: 'former.user', usernameLower: 'former.user', points: 725,
        }];
      },
    },
  } as NodeJS.Module;
  const userPath = require.resolve('../src/data/userStore.ts');
  require.cache[userPath] = {
    id: userPath, filename: userPath, loaded: true,
    exports: { getUserByGitlabUsername: async (username: string) => username === 'former.user' ? undefined : ({
      gitlabUsername: username, isAllowed: true, isActive: true, isLead: username.endsWith('.lead'),
    }) },
  } as NodeJS.Module;
  const rewardsPath = require.resolve('../src/data/reviewRewardRepository.ts');
  require.cache[rewardsPath] = {
    id: rewardsPath, filename: rewardsPath, loaded: true,
    exports: {
      findReviewRewardDay: async () => ({
        grants: [{ usernameLower: 'winner' }],
      }),
      listReviewRewardParticipants: async () => ['winner', 'new.top', 'developer.three', 'developer.four', 'developer.five'],
    },
  } as NodeJS.Module;
  const formatPath = require.resolve('../src/messages/format.ts');
  require.cache[formatPath] = {
    id: formatPath, filename: formatPath, loaded: true,
    exports: {
      escapeHtml: (value: string) => value,
      formatGitlabUserLabel: async (username: string) => username,
    },
  } as NodeJS.Module;
  stats = require('../src/services/gameStats.ts');
});

describe('stored monthly results', () => {
  it('reads each of the previous two months rather than the current season', async () => {
    for (const offset of [-1, -2]) {
      const season = shiftSeason(getSeasonKey(), offset);
      const message = await stats.buildGameTopMessage(undefined, season);
      assert.equal(requests.at(-1)?.season, season);
      assert.match(message, /former.user — 725 XP/);
      assert.doesNotMatch(message, /без новых ревью/);
    }
  });

  it('supports historical review and author category results without filtering deleted users', async () => {
    const season = shiftSeason(getSeasonKey(), -2);
    await stats.buildGameTopMessage('review', season);
    assert.equal(requests.at(-1)?.category, 'review');
    const message = await stats.buildGameTopMessage('author', season);
    assert.equal(requests.at(-1)?.category, 'author');
    assert.match(message, /former.user/);
  });

  it('explains missing history rather than inventing past results', async () => {
    const message = await stats.buildGameTopMessage(undefined, '2000-01');
    assert.match(message, /нет сохранённых начислений/);
  });

  it('shows the fixed daily winner even after a score drop and a change in the live top', async () => {
    const message = await stats.buildGameTopMessage();
    assert.match(message, /winner — 590 XP · 🎁 освобождён сегодня/);
    assert.doesNotMatch(message, /new.top — 1200 XP · 🎁/);
    assert.match(message, /Освобождён сегодня: winner/);
  });

  it('shows a separate developer review table without removing leads from overall statistics', async () => {
    const message = await stats.buildGameTopMessage('review');
    const [overall, contest] = message.split('<b>Зачёт разработчиков для освобождения</b>');
    assert.match(overall!, /tech.lead/);
    assert.match(contest!, /new.top — 1200 review XP/);
    assert.doesNotMatch(contest!, /tech.lead|team.lead/);
  });
});
