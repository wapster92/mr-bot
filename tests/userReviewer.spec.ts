import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReviewerEnabled } from '../src/data/userTypes';

describe('reviewer eligibility', () => {
  it('keeps existing active developers in the reviewer pool by default', () => {
    assert.equal(
      isReviewerEnabled({
        isAllowed: true,
        isActive: true,
        isLead: false,
      }),
      true,
    );
  });

  it('excludes an author-only developer from reviews', () => {
    assert.equal(
      isReviewerEnabled({
        isAllowed: true,
        isActive: true,
        isLead: false,
        isReviewer: false,
      }),
      false,
    );
  });

  it('excludes leads and inactive users', () => {
    assert.equal(
      isReviewerEnabled({
        isAllowed: true,
        isActive: true,
        isLead: true,
        isReviewer: true,
      }),
      false,
    );
    assert.equal(
      isReviewerEnabled({
        isAllowed: true,
        isActive: false,
        isLead: false,
        isReviewer: true,
      }),
      false,
    );
  });
});
