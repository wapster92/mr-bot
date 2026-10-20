import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { isReviewerEnabled, type UserRecord } from '../data/userTypes';

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
  return user.isLead === true || (isReviewerEnabled(user) && Boolean(
    mr.reviewers?.some((name) => name.toLowerCase() === username),
  ));
};
