import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommentRecipients } from '../src/gitlab/handlers/note';
import type { DeliveryRecipient } from '../src/messages/recipients';

describe('comment notification recipients', () => {
  const author: DeliveryRecipient = {
    chatId: 1,
    gitlabUsername: 'author',
    isWithinHours: true,
  };
  const leads: DeliveryRecipient[] = [
    {
      chatId: 2,
      gitlabUsername: 'lead',
      isWithinHours: true,
    },
  ];

  it('delivers a review comment to both the MR author and leads', () => {
    assert.deepEqual(buildCommentRecipients(author, leads), [author, ...leads]);
  });

  it('still delivers a review comment to leads when the author is not mapped', () => {
    assert.deepEqual(buildCommentRecipients(undefined, leads), leads);
  });
});
