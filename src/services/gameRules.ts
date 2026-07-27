import type { ScoreEventType } from '../data/scoreEventRepository';

export const GAME_POINTS = {
  reviewComments: [20, 10, 5],
  reviewApprove: 30,
  reviewOverdue: -25,
  authorChanges: 15,
  lintFirstPass: 10,
  mrMerged: 25,
  mrFastMergeDay: 20,
  mrFastMergeTwoDays: 10,
  mergeOverdue: -25,
} as const;

export type GameReward = {
  eventType: ScoreEventType;
  points: number;
  description: string;
};

export const getReviewCommentPoints = (
  alreadyScoredComments: number,
): number | undefined => GAME_POINTS.reviewComments[alreadyScoredComments];

export const getReviewResponseReward = (
  workingMinutes: number,
  workdayMinutes: number,
): GameReward => {
  if (workingMinutes <= 180) {
    return {
      eventType: 'review_response_3h',
      points: 15,
      description: 'Первая реакция не позднее 3 рабочих часов',
    };
  }
  if (workingMinutes <= workdayMinutes) {
    return {
      eventType: 'review_response_day',
      points: 10,
      description: 'Первая реакция не позднее рабочего дня',
    };
  }
  return {
    eventType: 'review_response',
    points: 0,
    description: 'Первая реакция на review',
  };
};

export const getMergeSpeedReward = (
  workingMinutes: number,
  workdayMinutes: number,
): GameReward | undefined => {
  if (workingMinutes <= workdayMinutes) {
    return {
      eventType: 'mr_fast_merge_day',
      points: GAME_POINTS.mrFastMergeDay,
      description: 'MR слит не позднее рабочего дня после готовности',
    };
  }
  if (workingMinutes <= workdayMinutes * 2) {
    return {
      eventType: 'mr_fast_merge_two_days',
      points: GAME_POINTS.mrFastMergeTwoDays,
      description: 'MR слит не позднее двух рабочих дней после готовности',
    };
  }
  return undefined;
};
