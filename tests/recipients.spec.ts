import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterRecipientsWithoutApproval,
  type DeliveryRecipient,
} from '../src/messages/recipients';

describe('final review recipients', () => {
  const recipients: DeliveryRecipient[] = [
    {
      chatId: 1,
      gitlabUsername: 'tech.lead',
      telegramUsername: 'tech_lead',
      isWithinHours: true,
    },
    {
      chatId: 2,
      gitlabUsername: 'team.lead',
      telegramUsername: 'team_lead',
      isWithinHours: true,
    },
  ];

  it('keeps only leads who have not approved the MR', () => {
    const result = filterRecipientsWithoutApproval(recipients, ['TECH.LEAD']);
    assert.deepEqual(
      result.map((recipient) => recipient.gitlabUsername),
      ['team.lead'],
    );
  });

  it('returns no recipients when every lead has approved', () => {
    const result = filterRecipientsWithoutApproval(recipients, [
      'tech.lead',
      'team.lead',
    ]);
    assert.deepEqual(result, []);
  });
});
