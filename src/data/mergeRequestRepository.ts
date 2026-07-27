import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';

export type MergeRequestDocument = {
  projectId: number;
  projectPath: string;
  mrId: number;
  iid: number;
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  taskKey?: string;
  taskUrl?: string;
  author: {
    gitlabUsername?: string;
    telegramUsername?: string;
    name?: string;
  };
  state?: string;
  mergeStatus?: string;
  detailedMergeStatus?: string;
  approvalsRequired?: number;
  approvalsLeft?: number;
  updatedAt?: Date;
  createdAt?: Date;
  action?: string;
  isDraft?: boolean;
  reviewers?: string[];
  reviewerLabels?: string[];
  approvedBy?: string[];
  lastLintStatus?: string;
  finalReviewNotified?: boolean;
  authorMergeNotified?: boolean;
  reviewersSyncedAt?: Date;
  reviewersSyncFailedAt?: Date;
  reviewersSyncError?: string;
};

const COLLECTION_NAME = 'merge_requests';

const getCollection = async (): Promise<Collection<MergeRequestDocument>> => {
  const db = await getDb();
  const collection = db.collection<MergeRequestDocument>(COLLECTION_NAME);
  await collection.createIndex({ projectId: 1, iid: 1 }, { unique: true });
  return collection;
};

export const upsertMergeRequest = async (doc: MergeRequestDocument): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { projectId: doc.projectId, iid: doc.iid },
    { $set: doc },
    { upsert: true },
  );
};

export const findMergeRequest = async (projectId: number, iid: number): Promise<MergeRequestDocument | null> => {
  const collection = await getCollection();
  return collection.findOne({ projectId, iid });
};

export const findMergeRequestByBranch = async (
  projectPath: string,
  sourceBranch: string,
): Promise<MergeRequestDocument | null> => {
  const collection = await getCollection();
  return collection.findOne({ projectPath, sourceBranch });
};

export const updateMergeRequest = async (
  projectId: number,
  iid: number,
  update: Partial<MergeRequestDocument>,
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne({ projectId, iid }, { $set: update });
};

export const listActiveMergeRequests = async (limit = 10): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      $and: [
        { $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }] },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listActiveMergeRequestsByAuthor = async (
  gitlabUsername: string,
  limit = 10,
): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      'author.gitlabUsername': {
        $regex: `^${escapeRegex(gitlabUsername)}$`,
        $options: 'i',
      },
      $and: [
        { $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }] },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
};

export const listOpenMergeRequests = async (): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      $and: [
        { $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }] },
      ],
    })
    .sort({ updatedAt: -1 })
    .toArray();
};

export const listProjectIds = async (): Promise<number[]> => {
  const collection = await getCollection();
  const ids = await collection.distinct('projectId');
  return ids.filter((id): id is number => typeof id === 'number');
};

export const listPendingReviewsForReviewer = async (
  gitlabUsername: string,
  limit = 10,
): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      reviewers: gitlabUsername,
      approvedBy: { $ne: gitlabUsername },
      $and: [
        { $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }] },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
};
