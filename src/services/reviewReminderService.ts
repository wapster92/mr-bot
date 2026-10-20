import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import {
  listReviewRemindersForMr,
  markReminderInactive,
  markReviewCompleted,
  resetReviewReminder,
  upsertReviewReminder,
} from '../data/reviewReminderRepository';

const normalize = (value: string): string => value.toLowerCase();

export const syncReviewRemindersForMr = async (
  mr: Pick<MergeRequestDocument, 'projectId' | 'iid'>,
  reviewers: string[],
  assignedAt: Date,
  isDraft?: boolean,
  resetAssignments?: boolean,
): Promise<void> => {
  if (isDraft) {
    await markAllRemindersInactiveForMr(mr);
    return;
  }
  const normalizedReviewers = reviewers.map((reviewer) => reviewer.toLowerCase());
  const normalizedSet = new Set(normalizedReviewers);

  const existing = await listReviewRemindersForMr(mr.projectId, mr.iid);
  const developerReminders = existing.filter((item) => !item.isLeadReview);
  const existingMap = new Map(
    developerReminders.map((item) => [item.reviewerUsernameLower, item]),
  );

  for (const reviewer of reviewers) {
    if (!reviewer) continue;
    const key = reviewer.toLowerCase();
    const existingReminder = existingMap.get(key);
    if (resetAssignments && existingReminder) {
      await resetReviewReminder({
        projectId: mr.projectId,
        iid: mr.iid,
        reviewerUsername: reviewer,
        assignedAt,
      });
      continue;
    }
    if (existingReminder?.inactiveAt) {
      await resetReviewReminder({
        projectId: mr.projectId,
        iid: mr.iid,
        reviewerUsername: reviewer,
        assignedAt,
      });
      continue;
    }
    await upsertReviewReminder({
      projectId: mr.projectId,
      iid: mr.iid,
      reviewerUsername: reviewer,
      assignedAt,
    });
  }

  for (const reminder of developerReminders) {
    if (!normalizedSet.has(reminder.reviewerUsernameLower)) {
      await markReminderInactive(mr.projectId, mr.iid, reminder.reviewerUsername);
    }
  }
};

export const markReviewCompletedForReviewer = async (
  mr: Pick<MergeRequestDocument, 'projectId' | 'iid'>,
  reviewerUsername: string,
): Promise<void> => {
  if (!reviewerUsername) {
    return;
  }
  await markReviewCompleted(mr.projectId, mr.iid, reviewerUsername);
};

export const markReviewCompletedForApprovers = async (
  mr: Pick<MergeRequestDocument, 'projectId' | 'iid'>,
  reviewers: string[],
  approvers: string[],
): Promise<void> => {
  if (!approvers.length || !reviewers.length) {
    return;
  }
  const reviewerSet = new Set(reviewers.map(normalize));
  for (const approver of approvers) {
    if (reviewerSet.has(normalize(approver))) {
      await markReviewCompleted(mr.projectId, mr.iid, approver);
    }
  }
};

export const markAllRemindersInactiveForMr = async (
  mr: Pick<MergeRequestDocument, 'projectId' | 'iid'>,
): Promise<void> => {
  const existing = await listReviewRemindersForMr(mr.projectId, mr.iid);
  for (const reminder of existing) {
    await markReminderInactive(mr.projectId, mr.iid, reminder.reviewerUsername);
  }
};
