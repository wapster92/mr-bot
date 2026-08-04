import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildUserDeletionPhrase,
  UserDeletionConfirmations,
} from '../src/services/userDeletionConfirmation';

describe('user deletion confirmation', () => {
  const target = {
    userId: '507f1f77bcf86cd799439011',
    gitlabUsername: 'developer.one',
    displayName: 'Developer One',
  };

  it('requires the exact generated phrase from the same lead', () => {
    const confirmations = new UserDeletionConfirmations(60_000);
    const requested = confirmations.request(
      100,
      target,
      new Date('2026-08-04T12:00:00.000Z'),
    );
    assert.equal(requested.phrase, 'УДАЛИТЬ developer.one');
    assert.equal(buildUserDeletionPhrase(target.gitlabUsername), requested.phrase);
    assert.equal(
      confirmations.confirm(
        200,
        requested.phrase,
        new Date('2026-08-04T12:00:10.000Z'),
      ).status,
      'missing',
    );
    assert.equal(
      confirmations.confirm(
        100,
        'удалить developer.one',
        new Date('2026-08-04T12:00:10.000Z'),
      ).status,
      'mismatch',
    );
    assert.deepEqual(
      confirmations.confirm(
        100,
        requested.phrase,
        new Date('2026-08-04T12:00:20.000Z'),
      ),
      { status: 'confirmed', target },
    );
  });

  it('rejects an expired confirmation', () => {
    const confirmations = new UserDeletionConfirmations(1_000);
    const requested = confirmations.request(
      100,
      target,
      new Date('2026-08-04T12:00:00.000Z'),
    );
    assert.equal(
      confirmations.confirm(
        100,
        requested.phrase,
        new Date('2026-08-04T12:00:01.000Z'),
      ).status,
      'expired',
    );
  });
});
