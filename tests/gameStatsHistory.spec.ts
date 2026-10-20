import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { getSeasonKey, shiftSeason } from '../src/services/gameSeason';

let stats: typeof import('../src/services/gameStats');
const requests: Array<{ season: string; category?: string }> = [];

before(() => {
  const scorePath = require.resolve('../src/data/scoreEventRepository.ts');
  require.cache[scorePath] = {
    id: scorePath, filename: scorePath, loaded: true,
    exports: {
      getScoreVersion: () => 0,
      listScoreTotals: async (input: { season: string; category?: string }) => {
        requests.push(input);
        return input.season === '2000-01' ? [] : [{
          username: 'former.user', usernameLower: 'former.user', points: 725,
        }];
      },
    },
  } as NodeJS.Module;
  const userPath = require.resolve('../src/data/userStore.ts');
  require.cache[userPath] = {
    id: userPath, filename: userPath, loaded: true,
    exports: { getUserByGitlabUsername: async () => undefined },
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
});
