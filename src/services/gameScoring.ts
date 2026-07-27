import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { markMergeRequestGameOverdue } from '../data/mergeRequestRepository';
import {
  ensureReviewReminderGameStarted,
  type ReviewReminderDocument,
} from '../data/reviewReminderRepository';
import {
  addScoreEvent,
  countReviewCommentScores,
  hasScoredReviewComment,
  hasScoreEvent,
} from '../data/scoreEventRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import {
  addWorkingMinutes,
  getWorkdayMinutes,
  getWorkingMinutesBetween,
} from './workingHours';
import {
  GAME_POINTS,
  getMergeSpeedReward,
  getReviewCommentPoints,
  getReviewResponseReward,
} from './gameRules';

const scoreLocks = new Map<string, Promise<void>>();

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

const getTrackingStart = (reminder: ReviewReminderDocument): Date => {
  const gameStartedAt = reminder.gameStartedAt ?? reminder.assignedAt;
  return gameStartedAt > reminder.assignedAt ? gameStartedAt : reminder.assignedAt;
};

export const buildReviewAssignmentKey = (
  reminder: ReviewReminderDocument,
): string =>
  [
    reminder.projectId,
    reminder.iid,
    reminder.reviewerUsernameLower,
    reminder.assignedAt.toISOString(),
    getTrackingStart(reminder).toISOString(),
  ].join(':');

const getReviewReminder = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  occurredAt: Date,
): Promise<ReviewReminderDocument | null> =>
  ensureReviewReminderGameStarted(
    projectId,
    iid,
    reviewerUsername,
    occurredAt,
  );

const recordReviewerResponse = async (
  reminder: ReviewReminderDocument,
  occurredAt: Date,
): Promise<void> => {
  const user = await getUserByGitlabUsername(reminder.reviewerUsername);
  if (!user || user.isActive === false) {
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
    if (!(await isScoringUserAvailable(input.reviewerUsername))) {
      return;
    }
    const reminder = await getReviewReminder(
      input.mr.projectId,
      input.mr.iid,
      input.reviewerUsername,
      input.occurredAt,
    );
    if (!reminder) {
      return;
    }
    const assignmentKey = buildReviewAssignmentKey(reminder);
    const eventKey =
      `review:comment:${assignmentKey}:` + input.discussionKey;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await hasScoreEvent(eventKey)) {
        break;
      }
      const scoredComments = await countReviewCommentScores(assignmentKey);
      const points = getReviewCommentPoints(scoredComments);
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
  if (
    input.mr.author.gitlabUsername?.toLowerCase() === input.username.toLowerCase() ||
    !(await isScoringUserAvailable(input.username))
  ) {
    return;
  }
  await addScoreEvent({
    eventKey: `review:approve:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`,
    username: input.username,
    category: 'review',
    eventType: 'review_approved',
    points: GAME_POINTS.reviewApprove,
    projectId: input.mr.projectId,
    iid: input.mr.iid,
    occurredAt: input.occurredAt,
    description: 'Approve MR',
  });

  if (
    input.mr.reviewers?.some(
      (reviewer) => reviewer.toLowerCase() === input.username.toLowerCase(),
    )
  ) {
    const reminder = await getReviewReminder(
      input.mr.projectId,
      input.mr.iid,
      input.username,
      input.occurredAt,
    );
    if (reminder) {
      await recordReviewerResponse(reminder, input.occurredAt);
    }
  }
};

export const recordReviewUnapprovalScore = async (input: {
  mr: MergeRequestDocument;
  username: string;
  occurredAt: Date;
}): Promise<void> => {
  const approvalKey =
    `review:approve:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`;
  if (!(await hasScoreEvent(approvalKey))) {
    return;
  }
  await addScoreEvent({
    eventKey: `review:unapprove:${input.mr.projectId}:${input.mr.iid}:${input.username.toLowerCase()}`,
    username: input.username,
    category: 'review',
    eventType: 'review_unapproved',
    points: -GAME_POINTS.reviewApprove,
    projectId: input.mr.projectId,
    iid: input.mr.iid,
    occurredAt: input.occurredAt,
    description: 'Отмена XP за approve после unapprove',
  });
};

export const recordReviewOverdueScore = async (
  reminder: ReviewReminderDocument,
  overdueAt: Date,
): Promise<void> => {
  if (!reminder.gameStartedAt || !(await isScoringUserAvailable(reminder.reviewerUsername))) {
    return;
  }
  const assignmentKey = buildReviewAssignmentKey(reminder);
  await addScoreEvent({
    eventKey: `review:overdue:${assignmentKey}`,
    username: reminder.reviewerUsername,
    category: 'review',
    eventType: 'review_overdue',
    points: GAME_POINTS.reviewOverdue,
    projectId: reminder.projectId,
    iid: reminder.iid,
    occurredAt: overdueAt,
    description: 'Нет обратной связи два рабочих дня',
    metadata: {
      assignmentKey,
      assignedAt: getTrackingStart(reminder).toISOString(),
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
