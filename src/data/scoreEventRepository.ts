import { MongoServerError } from 'mongodb';
import type { Collection, Filter, ObjectId } from 'mongodb';
import { getDb } from '../db/mongo';
import { getSeasonKey } from '../services/gameSeason';

export type ScoreCategory = 'review' | 'author';

export type ScoreEventType =
  | 'review_comment'
  | 'review_approved'
  | 'review_unapproved'
  | 'review_response_3h'
  | 'review_response_day'
  | 'review_response'
  | 'review_overdue'
  | 'author_changes'
  | 'lint_first_pass'
  | 'mr_merged'
  | 'mr_fast_merge_day'
  | 'mr_fast_merge_two_days'
  | 'merge_overdue';

export type ScoreEventMetadata = {
  assignmentKey?: string;
  assignedAt?: string;
  discussionKey?: string;
  noteId?: string;
  workingMinutes?: number;
  position?: number;
  overdueDay?: 1 | 2;
};

export type ScoreEventDocument = {
  _id?: ObjectId;
  eventKey: string;
  username: string;
  usernameLower: string;
  category: ScoreCategory;
  eventType: ScoreEventType;
  points: number;
  projectId: number;
  iid: number;
  occurredAt: Date;
  recordedAt?: Date;
  season: string;
  description: string;
  commentSlotKey?: string;
  metadata?: ScoreEventMetadata;
};

export type ScoreTotal = {
  username: string;
  usernameLower: string;
  points: number;
  reviewPoints: number;
  authorPoints: number;
  reviewEarned: number;
  authorEarned: number;
  penalties: number;
  events: number;
};

const COLLECTION_NAME = 'score_events';
let collectionInitialization: Promise<Collection<ScoreEventDocument>> | undefined;

const initializeCollection = async (): Promise<Collection<ScoreEventDocument>> => {
  const db = await getDb();
  const collection = db.collection<ScoreEventDocument>(COLLECTION_NAME);
  await collection.createIndex({ eventKey: 1 }, { unique: true });
  await collection.createIndex({ season: 1, usernameLower: 1, occurredAt: -1 });
  await collection.createIndex({ usernameLower: 1, occurredAt: -1 });
  await collection.createIndex({ projectId: 1, iid: 1, eventType: 1 });
  await collection.createIndex({ 'metadata.assignmentKey': 1, eventType: 1 });
  await collection.createIndex({ commentSlotKey: 1 }, { unique: true, sparse: true });
  await collection.createIndex({ season: 1, category: 1, recordedAt: 1 });
  return collection;
};

const getCollection = async (): Promise<Collection<ScoreEventDocument>> => {
  if (!collectionInitialization) {
    collectionInitialization = initializeCollection().catch((error: unknown) => {
      collectionInitialization = undefined;
      throw error;
    });
  }
  return collectionInitialization;
};

export const addScoreEvent = async (
  input: Omit<ScoreEventDocument, '_id' | 'usernameLower' | 'season'>,
): Promise<boolean> => {
  const collection = await getCollection();
  try {
    await collection.insertOne({
      ...input,
      usernameLower: input.username.toLowerCase(),
      season: getSeasonKey(input.occurredAt),
      recordedAt: new Date(),
    });
    console.info(
      `[game] ${input.username} ${input.points >= 0 ? '+' : ''}${input.points} ${input.eventType} ${input.projectId}/${input.iid}`,
    );
    return true;
  } catch (error) {
    if (
      (error instanceof MongoServerError && error.code === 11000) ||
      (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
    ) {
      return false;
    }
    throw error;
  }
};

export const hasScoreEvent = async (eventKey: string): Promise<boolean> => {
  const collection = await getCollection();
  return Boolean(await collection.findOne({ eventKey }, { projection: { _id: 1 } }));
};

export const findScoreEvent = async (eventKey: string): Promise<ScoreEventDocument | null> => {
  const collection = await getCollection();
  return collection.findOne({ eventKey });
};

export type ReviewScoreBalance = { usernameLower: string; points: number };
export type ReviewScoreActivity = ReviewScoreBalance & { at: Date; eventKey: string };

export const loadReviewScoreBaseline = async (
  season: string,
  dayStart: Date,
): Promise<ReviewScoreBalance[]> => {
  const collection = await getCollection();
  return collection.aggregate<ReviewScoreBalance>([
    { $match: { season, category: 'review', $expr: {
      $lt: [{ $ifNull: ['$recordedAt', '$occurredAt'] }, dayStart],
    } } },
    { $group: { _id: '$usernameLower', points: { $sum: '$points' } } },
    { $project: { _id: 0, usernameLower: '$_id', points: 1 } },
  ]).toArray();
};

export const listReviewScoreActivity = async (
  season: string,
  dayStart: Date,
  now: Date,
): Promise<ReviewScoreActivity[]> => {
  const collection = await getCollection();
  return collection.aggregate<ReviewScoreActivity>([
    { $match: { season, category: 'review' } },
    { $project: {
      _id: 0, usernameLower: 1, points: 1, eventKey: 1,
      at: { $ifNull: ['$recordedAt', '$occurredAt'] },
    } },
    { $match: { at: { $gte: dayStart, $lte: now } } },
    { $sort: { at: 1, usernameLower: 1, eventKey: 1 } },
  ]).toArray();
};

export const countReviewCommentScores = async (
  assignmentKey: string,
): Promise<number> => {
  const collection = await getCollection();
  return collection.countDocuments({
    eventType: 'review_comment',
    'metadata.assignmentKey': assignmentKey,
  });
};

export const hasScoredReviewComment = async (
  projectId: number,
  iid: number,
  occurredBefore?: Date,
): Promise<boolean> => {
  const collection = await getCollection();
  return Boolean(
    await collection.findOne(
      {
        projectId,
        iid,
        eventType: 'review_comment',
        ...(occurredBefore ? { occurredAt: { $lte: occurredBefore } } : {}),
      },
      { projection: { _id: 1 } },
    ),
  );
};

export const hasReviewFeedbackScore = async (
  projectId: number,
  iid: number,
  username: string,
): Promise<boolean> => {
  const collection = await getCollection();
  return Boolean(await collection.findOne({
    projectId, iid, usernameLower: username.toLowerCase(),
    eventType: { $in: ['review_comment', 'review_approved'] },
  }, { projection: { _id: 1 } }));
};

const buildScoreFilter = (input: {
  username?: string;
  usernames?: string[];
  season?: string;
  category?: ScoreCategory;
}): Filter<ScoreEventDocument> => ({
  ...(input.username ? { usernameLower: input.username.toLowerCase() }
    : input.usernames ? { usernameLower: { $in: input.usernames.map((name) => name.toLowerCase()) } } : {}),
  ...(input.season ? { season: input.season } : {}),
  ...(input.category ? { category: input.category } : {}),
});

export const listScoreTotals = async (input: {
  username?: string;
  usernames?: string[];
  season?: string;
  category?: ScoreCategory;
  limit?: number;
}): Promise<ScoreTotal[]> => {
  const collection = await getCollection();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return collection
    .aggregate<ScoreTotal>([
      { $match: buildScoreFilter(input) },
      {
        $group: {
          _id: '$usernameLower',
          username: { $first: '$username' },
          usernameLower: { $first: '$usernameLower' },
          points: { $sum: '$points' },
          reviewPoints: {
            $sum: { $cond: [{ $eq: ['$category', 'review'] }, '$points', 0] },
          },
          authorPoints: {
            $sum: { $cond: [{ $eq: ['$category', 'author'] }, '$points', 0] },
          },
          reviewEarned: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$category', 'review'] },
                    { $gt: ['$points', 0] },
                  ],
                },
                '$points',
                0,
              ],
            },
          },
          authorEarned: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$category', 'author'] },
                    { $gt: ['$points', 0] },
                  ],
                },
                '$points',
                0,
              ],
            },
          },
          penalties: {
            $sum: { $cond: [{ $lt: ['$points', 0] }, '$points', 0] },
          },
          events: { $sum: 1 },
        },
      },
      { $sort: { points: -1, usernameLower: 1 } },
      { $limit: limit },
      { $project: { _id: 0 } },
    ])
    .toArray();
};

export const getUserScoreTotal = async (input: {
  username: string;
  season?: string;
}): Promise<ScoreTotal | undefined> => {
  const totals = await listScoreTotals({
    username: input.username,
    ...(input.season ? { season: input.season } : {}),
    limit: 1,
  });
  return totals.find((item) => item.usernameLower === input.username.toLowerCase());
};

export const listRecentScoreEvents = async (
  username: string,
  limit = 5,
): Promise<ScoreEventDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({ ...buildScoreFilter({ username }), points: { $ne: 0 } })
    .sort({ occurredAt: -1 })
    .limit(Math.max(1, Math.min(limit, 20)))
    .toArray();
};

export const countUserScoreEvents = async (
  username: string,
  eventTypes: ScoreEventType[],
): Promise<number> => {
  if (!eventTypes.length) {
    return 0;
  }
  const collection = await getCollection();
  return collection.countDocuments({
    usernameLower: username.toLowerCase(),
    eventType: { $in: eventTypes },
  });
};
