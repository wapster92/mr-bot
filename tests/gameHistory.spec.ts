import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatSeasonInput,
  getSeasonKey,
  parseSeasonInput,
  shiftSeason,
} from '../src/services/gameSeason';

describe('monthly leaderboard selection', () => {
  const now = new Date('2026-10-20T10:00:00Z');

  it('accepts both previous months and any older valid month', () => {
    assert.equal(parseSeasonInput('09.2026', now), '2026-09');
    assert.equal(parseSeasonInput('08.2026', now), '2026-08');
    assert.equal(parseSeasonInput('01.2024', now), '2024-01');
    assert.equal(parseSeasonInput('10.2026', now), '2026-10');
  });

  it('rejects invalid formats and future months', () => {
    for (const input of ['9.2026', '00.2026', '13.2026', '09.26', '2026-09', '09.2026 x', '11.2026', '01.2027']) {
      assert.equal(parseSeasonInput(input, now), undefined);
    }
  });

  it('navigates across years and uses Moscow month boundaries', () => {
    assert.equal(shiftSeason('2026-01', -1), '2025-12');
    assert.equal(shiftSeason('2026-01', -2), '2025-11');
    assert.equal(formatSeasonInput('2025-12'), '12.2025');
    const boundary = new Date('2026-09-30T21:00:00Z');
    assert.equal(getSeasonKey(boundary), '2026-10');
    assert.equal(parseSeasonInput('10.2026', boundary), '2026-10');
  });
});
