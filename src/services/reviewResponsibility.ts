import type { MergeRequestDocument } from '../data/mergeRequestRepository';

type Activity = Pick<MergeRequestDocument,
  'author' | 'reviewCommenters' | 'reviewCommentedAt' | 'reviewAuthorCommentedAt' | 'reviewCodeUpdatedAt' | 'reviewCodeHeadSha'>;

const later = (left: Date | undefined, right: Date | undefined): Date | undefined =>
  !left || (right && right > left) ? right : left;

export const isWaitingForAuthor = (mr: Activity, username: string): boolean => {
  const comment = mr.reviewCommentedAt?.[username.toLowerCase()];
  const authorAction = later(mr.reviewAuthorCommentedAt, mr.reviewCodeUpdatedAt);
  return Boolean(comment && (!authorAction || comment > authorAction));
};

export const getReviewResponseDueSince = (
  mr: Activity,
  username: string,
  requestedAt: Date | undefined,
): Date | undefined => {
  if (!requestedAt || isWaitingForAuthor(mr, username)) return undefined;
  const normalized = username.toLowerCase();
  // Older installations knew only that someone commented, not when. Do not
  // accuse them of silence until the timed history has been recovered.
  if (mr.reviewCommenters?.some((name) => name.toLowerCase() === normalized) &&
    !mr.reviewCommentedAt?.[normalized]) return undefined;
  return later(requestedAt, later(mr.reviewAuthorCommentedAt, mr.reviewCodeUpdatedAt));
};

export const recordReviewCommentActivity = (
  mr: Activity,
  username: string,
  occurredAt: Date,
): Partial<MergeRequestDocument> => {
  if (!Number.isFinite(occurredAt.getTime())) return {};
  const normalized = username.toLowerCase();
  if (normalized === mr.author.gitlabUsername?.toLowerCase()) {
    return mr.reviewAuthorCommentedAt && mr.reviewAuthorCommentedAt >= occurredAt
      ? {} : { reviewAuthorCommentedAt: occurredAt };
  }
  const previous = mr.reviewCommentedAt?.[normalized];
  return previous && previous >= occurredAt ? {} : {
    reviewCommentedAt: { ...mr.reviewCommentedAt, [normalized]: occurredAt },
  };
};

export const recordReviewCodeUpdate = (
  mr: Activity,
  sha: string | undefined,
  occurredAt: Date,
): Partial<MergeRequestDocument> => {
  if (!Number.isFinite(occurredAt.getTime())) return {};
  if ((sha && sha === mr.reviewCodeHeadSha) ||
    (mr.reviewCodeUpdatedAt && mr.reviewCodeUpdatedAt >= occurredAt)) return {};
  return { reviewCodeUpdatedAt: occurredAt, ...(sha ? { reviewCodeHeadSha: sha } : {}) };
};
