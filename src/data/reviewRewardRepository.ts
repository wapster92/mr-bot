import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';
import type { ReviewScoreBalance } from './scoreEventRepository';

export type DailyReviewGrant = {
  usernameLower: string;
  points: number;
  grantedAt: Date;
};

export type ReviewRewardDay = {
  day: string;
  season: string;
  baseline: ReviewScoreBalance[];
  grants: DailyReviewGrant[];
  revision: number;
  createdAt: Date;
};

let initialization: Promise<Collection<ReviewRewardDay>> | undefined;

const getCollection = async (): Promise<Collection<ReviewRewardDay>> => {
  if (!initialization) {
    initialization = (async () => {
      const db = await getDb();
      const collection = db.collection<ReviewRewardDay>('review_reward_days');
      await collection.createIndex({ day: 1 }, { unique: true });
      return collection;
    })().catch((error: unknown) => { initialization = undefined; throw error; });
  }
  return initialization;
};

export const listReviewRewardParticipants = async (): Promise<string[]> => {
  const db = await getDb();
  const users = await db.collection<{ gitlabUsernameLower: string }>('users').find({
    isAllowed: true, isActive: { $ne: false }, isLead: { $ne: true }, isReviewer: { $ne: false },
    gitlabUsernameLower: { $type: 'string' },
  }, { projection: { gitlabUsernameLower: 1 } }).toArray();
  return users.map((user) => user.gitlabUsernameLower);
};

export const findReviewRewardDay = async (day: string): Promise<ReviewRewardDay | null> => {
  const collection = await getCollection();
  return collection.findOne({ day });
};

export const ensureReviewRewardDay = async (input: ReviewRewardDay): Promise<ReviewRewardDay> => {
  const collection = await getCollection();
  try {
    await collection.updateOne({ day: input.day }, { $setOnInsert: input }, { upsert: true });
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
  }
  const stored = await collection.findOne({ day: input.day });
  if (!stored) throw new Error(`Daily review reward disappeared: ${input.day}`);
  return stored;
};

export const saveDailyReviewGrants = async (
  day: string,
  revision: number,
  grants: DailyReviewGrant[],
): Promise<boolean> => {
  const collection = await getCollection();
  const result = await collection.updateOne(
    { day, revision },
    { $set: { grants }, $inc: { revision: 1 } },
  );
  return result.modifiedCount === 1;
};
