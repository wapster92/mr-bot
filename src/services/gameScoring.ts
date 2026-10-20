import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { markMergeRequestGameOverdue } from '../data/mergeRequestRepository';
import {
  ensureReviewReminderGameStarted,
  type ReviewReminderDocument,
} from '../data/reviewReminderRepository';
import {
  addScoreEvent,
  countReviewCommentScores,
  findScoreEvent,
  hasScoredReviewComment,
  hasScoredReviewDiscussion,
  hasScoreEvent,
} from '../data/scoreEventRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import { isReviewerEnabled, type UserRecord } from '../data/userTypes';
import {
  addWorkingMinutes,
  getWorkdayMinutes,
  getWorkingMinutesBetween,
} from './workingHours';
import {
  GAME_POINTS,
  LEAD_GAME_POINTS,
  getMergeSpeedReward,
  getReviewCommentPoints,
  getReviewResponseReward,
} from './gameRules';

const scoreLocks = new Map<string, Promise<void>>();
type ScoringReviewReminder = ReviewReminderDocument & { isVoluntaryReview?: boolean };

export const runGameAction = async (
  label: string,
  task: () => Promise<void>,
): Promise<void> => {
  try {
    await task();
  } catch (error) {
    console.warn(`[game] ${label} failed`, error);
  }
};

const withScoreLock = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = scoreLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  scoreLocks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (scoreLocks.get(key) === queued) {
      scoreLocks.delete(key);
    }
  }
};

const isScoringUserAvailable = async (username: string): Promise<boolean> => {
  const user = await getUserByGitlabUsername(username);
  return Boolean(user && user.isActive !== false);
};

const isScoringReviewParticipant = (user: UserRecord): boolean =>
  user.isAllowed !== false && user.isActive !== false &&
  (user.isLead === true || isReviewerEnabled(user));

const isAssignedReviewer = (mr: MergeRequestDocument, username: string): boolean =>
  Boolean(mr.reviewers?.some((reviewer) => reviewer.toLowerCase() === username.toLowerCase()));

const getTrackingStart = (reminder: ReviewReminderDocument): Date => {
  const gameStartedAt = reminder.gameStartedAt ?? reminder.assignedAt;
  return gameStartedAt > reminder.assignedAt ? gameStartedAt : reminder.assignedAt;
};

export const buildReviewAssignmentKey = (
  reminder: ScoringReviewReminder,
): string => {
  const prefix = `${reminder.projectId}:${reminder.iid}:${reminder.reviewerUsernameLower}`;
  if (reminder.isLeadReview) return `${prefix}:lead`;
  if (reminder.isVoluntaryReview) return `${prefix}:voluntary`;
  return [prefix, reminder.assignedAt.toISOString(), getTrackingStart(reminder).toISOString()].join(':');
};

const getReviewReminder = async (
  mr: MergeRequestDocument,
  reviewerUsername: string,
  occurredAt: Date,
  user: UserRecord,
): Promise<ScoringReviewReminder | null> => {
  const voluntary = !user.isLead && (!isReviewerEnabled(user) || !isAssignedReviewer(mr, reviewerUsername));
  if (user.isLead || voluntary) {
    // Stable budgets for leads and volunteers without creating assignment
    // reminders. Voluntary comments never start response timers or penalties.
    const assignedAt = mr.gameStartedAt ?? mr.createdAt ?? occurredAt;
    return {
      projectId: mr.projectId,
      iid: mr.iid,
      reviewerUsername,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
      assignedAt,
      reminderCount: 0,
      ...(user.isLead ? { isLeadReview: true } : { isVoluntaryReview: true }),
    };
  }
  return ensureReviewReminderGameStarted(
    mr.projectId,
    mr.iid,
    reviewerUsername,
    occurredAt,
  );
};

const recordReviewerResponse = async (
  reminder: ScoringReviewReminder,
  occurredAt: Date,
): Promise<void> => {
  if (reminder.isVoluntaryReview || occurredAt < getTrackingStart(reminder)) return;
  const user = await getUserByGitlabUsername(reminder.reviewerUsername);
  if (!user || !isScoringReviewParticipant(user) || user.isLead) {
    return;
  }
  const assignmentKey = buildReviewAssignmentKey(reminder);
  const trackingStart = getTrackingStart(reminder);
  const workingMinutes = getWorkingMinutesBetween(user, trackingStart, occurredAt);
  const workdayMinutes = getWorkdayMinutes(user);
  const reward = getReviewResponseReward(workingMinutes, workdayMinutes);
  await addScoreEvent({
    eventKey: `review:response:${assignmentKey}`,
    username: reminder.reviewerUsername,
    category: 'review',
    eventType: reward.eventType,
    points: reward.points,
    projectId: reminder.projectId,
    iid: reminder.iid,
    occurredAt,
    description: reward.description,
    metadata: {
      assignmentKey,
      assignedAt: trackingStart.toISOString(),
      workingMinutes,
    },
  });
};

export const recordReviewCommentScore = async (input: {
  mr: MergeRequestDocument;
  reviewerUsername: string;
  noteId: string;
  discussionKey: string;
  occurredAt: Date;
}): Promise<void> => {
  const lockKey = `comment:${input.mr.projectId}:${input.mr.iid}:${input.reviewerUsername.toLowerCase()}`;
  await withScoreLock(lockKey, async () => {
    const user = await getUserByGitlabUsername(input.reviewerUsername);
    if (input.mr.isDraft || ['closed', 'merged'].includes(input.mr.state ?? '') ||
      input.mr.author.gitlabUsername?.toLowerCase() === input.reviewerUsername.toLowerCase() ||
      !user || user.isActive === false || user.isAllowed === false) {
      return;
    }
    const reminder = await getReviewReminder(
      input.mr,
      input.reviewerUsername,
      input.occurredAt,
      user,
    );
    if (!reminder) {
      return;
    }
    const assignmentKey = buildReviewAssignmentKey(reminder);
    const eventKey =
      `review:comment:${assignmentKey}:` + input.discussionKey;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await hasScoreEvent(eventKey) || await hasScoredReviewDiscussion(
        input.mr.projectId, input.mr.iid, input.reviewerUsername, input.discussionKey,
      )) {
        break;
      }
      const scoredComments = await countReviewCommentScores(assignmentKey);
      const points = getReviewCommentPoints(scoredComments, user.isLead === true);
      if (points === undefined) {
        break;
      }
      const position = scoredComments + 1;
      const added = await addScoreEvent({
        eventKey,
        commentSlotKey: `${assignmentKey}:${position}`,
        username: input.reviewerUsername,
        category: 'review',
        eventType: 'review_comment',
        points,
        projectId: input.mr.projectId,
        iid: input.mr.iid,
        occurredAt: input.occurredAt,
        description: `Комментарий в review (${position}/3)`,
        metadata: {
          assignmentKey,
          assignedAt: getTrackingStart(reminder).toISOString(),
          discussionKey: input.discussionKey,
          noteId: input.noteId,
          position,
        },
      });
      if (added) {
        break;
      }
    }
    await recordReviewerResponse(reminder, input.occurredAt);
  });
};

export const recordReviewApprovalScore = async (input: {
  mr: MergeRequestDocument;
  username: string;
  occurredAt: Date;
}): Promise<void> => {
  const approver = await getUserByGitlabUsername(input.username);
  if (
    input.mr.isDraft || ['closed', 'merged'].includes(input.mr.state ?? '') ||
    input.mr.author.gitlabUsername?.toLowerCase() === input.username.toLowerCase() ||
    !approver || !isScoringReviewParticipant(approver) ||
    (!approver.isLead && !isAssignedReviewer(input.mr, input.username))
  ) {
    return;
  }
  await addScoreEvent({
    eventKey: `review:approve:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`,
    username: input.username,
    category: 'review',
    eventType: 'review_approved',
    points: approver.isLead ? LEAD_GAME_POINTS.reviewApprove : GAME_POINTS.reviewApprove,
    projectId: input.mr.projectId,
    iid: input.mr.iid,
    occurredAt: input.occurredAt,
    description: 'Approve MR',
  });

  const reminder = await getReviewReminder(
    input.mr,
    input.username,
    input.occurredAt,
    approver,
  );
  if (reminder) {
    await recordReviewerResponse(reminder, input.occurredAt);
  }
};

export const recordReviewUnapprovalScore = async (input: {
  mr: MergeRequestDocument;
  username: string;
  occurredAt: Date;
}): Promise<void> => {
  const approvalKey =
    `review:approve:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`;
  const approval = await findScoreEvent(approvalKey);
  if (!approval) {
    return;
  }
  await addScoreEvent({
    eventKey: `review:unapprove:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`,
    username: input.username,
    category: 'review',
    eventType: 'review_unapproved',
    points: -approval.points,
    projectId: input.mr.projectId,
    iid: input.mr.iid,
    occurredAt: input.occurredAt,
    description: 'Отмена XP за approve после unapprove',
  });
};

export const recordReviewOverdueScore = async (
  reminder: ReviewReminderDocument,
  overdueAt: Date,
  day: 1 | 2 = 2,
): Promise<void> => {
  const reviewer = await getUserByGitlabUsername(reminder.reviewerUsername);
  if (
    !reminder.gameStartedAt ||
    reminder.reviewCompletedAt || reminder.inactiveAt || reminder.escalatedAt ||
    !reviewer || !isScoringReviewParticipant(reviewer) ||
    (reminder.isLeadReview ? reviewer.isLead !== true : !isReviewerEnabled(reviewer))
  ) {
    return;
  }
  const assignmentKey = buildReviewAssignmentKey(reminder);
  // Preserve the existing two-day key so old penalties cannot be charged twice.
  const eventKey = day === 2
    ? `review:overdue:${assignmentKey}`
    : `review:overdue:day-1:${assignmentKey}`;
  if (await hasScoreEvent(eventKey)) return;
  // Do not add the new first-day penalty retrospectively to an assignment
  // that already received its terminal two-day penalty on an older version.
  if (day === 1 && await hasScoreEvent(`review:overdue:${assignmentKey}`)) return;
  await addScoreEvent({
    eventKey,
    username: reminder.reviewerUsername,
    category: 'review',
    eventType: 'review_overdue',
    points: GAME_POINTS.reviewOverdue,
    projectId: reminder.projectId,
    iid: reminder.iid,
    occurredAt: overdueAt,
    description: day === 1 ? 'Нет обратной связи один рабочий день' : 'Нет обратной связи два рабочих дня',
    metadata: {
      assignmentKey,
      assignedAt: getTrackingStart(reminder).toISOString(),
      overdueDay: day,
    },
  });
};

export const recordAuthorChangesScore = async (input: {
  mr: MergeRequestDocument;
  pushedAt: Date;
}): Promise<void> => {
  const authorUsername = input.mr.author.gitlabUsername;
  if (
    !authorUsername ||
    !(await isScoringUserAvailable(authorUsername)) ||
    !(await hasScoredReviewComment(input.mr.projectId, input.mr.iid, input.pushedAt))
  ) {
    return;
  }
  await addScoreEvent({
    eventKey: `author:changes:${input.mr.projectId}:${input.mr.iid}`,
    username: authorUsername,
    category: 'author',
    eventType: 'author_changes',
    points: GAME_POINTS.authorChanges,
    projectId: input.mr.projectId,
    iid: input.mr.iid,
    occurredAt: input.pushedAt,
    description: 'Первый push после замечаний',
  });
};

export const recordLintFirstPassScore = async (
  mr: MergeRequestDocument,
  occurredAt: Date,
): Promise<void> => {
  const authorUsername = mr.author.gitlabUsername;
  if (!authorUsername || !(await isScoringUserAvailable(authorUsername))) {
    return;
  }
  await addScoreEvent({
    eventKey: `author:lint-first-pass:${mr.projectId}:${mr.iid}`,
    username: authorUsername,
    category: 'author',
    eventType: 'lint_first_pass',
    points: GAME_POINTS.lintFirstPass,
    projectId: mr.projectId,
    iid: mr.iid,
    occurredAt,
    description: 'Первый lint прошёл без предыдущего падения',
  });
};

export const recordMergeOverdueScore = async (
  mr: MergeRequestDocument,
  overdueAt: Date,
): Promise<void> => {
  const authorUsername = mr.author.gitlabUsername;
  if (!authorUsername || !(await isScoringUserAvailable(authorUsername))) {
    await markMergeRequestGameOverdue(mr.projectId, mr.iid, overdueAt);
    return;
  }
  await addScoreEvent({
    eventKey: `author:merge-overdue:${mr.projectId}:${mr.iid}`,
    username: authorUsername,
    category: 'author',
    eventType: 'merge_overdue',
    points: GAME_POINTS.mergeOverdue,
    projectId: mr.projectId,
    iid: mr.iid,
    occurredAt: overdueAt,
    description: 'Готовый MR не слит два рабочих дня',
  });
  await markMergeRequestGameOverdue(mr.projectId, mr.iid, overdueAt);
};

export const recordMergedMrScore = async (
  mr: MergeRequestDocument,
  mergedAt: Date,
): Promise<void> => {
  const authorUsername = mr.author.gitlabUsername;
  const user = authorUsername
    ? await getUserByGitlabUsername(authorUsername)
    : undefined;
  if (!authorUsername || !user || user.isActive === false) {
    return;
  }

  await addScoreEvent({
    eventKey: `author:merged:${mr.projectId}:${mr.iid}`,
    username: authorUsername,
    category: 'author',
    eventType: 'mr_merged',
    points: GAME_POINTS.mrMerged,
    projectId: mr.projectId,
    iid: mr.iid,
    occurredAt: mergedAt,
    description: 'MR успешно слит',
  });

  if (!mr.gameReadyAt || mr.gameMergeOverdueAt) {
    return;
  }
  const workdayMinutes = getWorkdayMinutes(user);
  const workingMinutes = getWorkingMinutesBetween(user, mr.gameReadyAt, mergedAt);
  const reward = getMergeSpeedReward(workingMinutes, workdayMinutes);
  if (reward) {
    await addScoreEvent({
      eventKey: `author:fast-merge:${mr.projectId}:${mr.iid}`,
      username: authorUsername,
      category: 'author',
      eventType: reward.eventType,
      points: reward.points,
      projectId: mr.projectId,
      iid: mr.iid,
      occurredAt: mergedAt,
      description: reward.description,
    });
    return;
  }
  const twoDaysAt = addWorkingMinutes(user, mr.gameReadyAt, workdayMinutes * 2);
  await recordMergeOverdueScore(mr, twoDaysAt);
};
