import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import type { UserRecord } from '../data/userTypes';
import { isWaitingForAuthor } from './reviewResponsibility';

export const shouldNotifyReviewUpdate = (
  mr: MergeRequestDocument | null,
  user: UserRecord,
): boolean => {
  if (!mr || mr.isDraft || ['closed', 'merged'].includes(mr.state ?? '') ||
    user.isActive === false || user.isAllowed === false) return false;
  const username = user.gitlabUsername.toLowerCase();
  if (mr.author.gitlabUsername?.toLowerCase() === username) return false;
  if (!mr.reviewCommenters?.some((name) => name.toLowerCase() === username)) return false;
  if (mr.approvedBy?.some((name) => name.toLowerCase() === username)) return false;
  if (isWaitingForAuthor(mr, username)) return false;
  return true;
};
