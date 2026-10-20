import type { Collection, Filter } from 'mongodb';
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
  finishedAt?: Date | null;
  action?: string;
  isDraft?: boolean;
  reviewers?: string[];
  reviewerLabels?: string[];
  approvalRequestedAt?: Record<string, Date>;
  approvedBy?: string[];
  reviewCommenters?: string[];
  reviewCommentsSyncedAt?: Date;
  reviewCommentRequirementsSyncedAt?: Date;
  reviewCommentHistorySyncPending?: boolean;
  reviewCommentHistoryLastAttemptAt?: Date;
  lastLintStatus?: string;
  finalReviewNotified?: boolean;
  finalReviewNotifiedFor?: string[];
  authorMergeNotified?: boolean;
  authorMergeNotificationVersion?: number;
  gameStartedAt?: Date;
  gameLintFailed?: boolean;
  gameLintFirstPassEvaluated?: boolean;
  gameReadyAt?: Date;
  gameMergeOverdueAt?: Date;
  reviewersSyncedAt?: Date;
  reviewersSyncFailedAt?: Date;
  reviewersSyncError?: string;
  reviewerLabelsCleanupPending?: boolean;
};

const COLLECTION_NAME = 'merge_requests';

const getCollection = async (): Promise<Collection<MergeRequestDocument>> => {
  const db = await getDb();
  const collection = db.collection<MergeRequestDocument>(COLLECTION_NAME);
  await collection.createIndex({ projectId: 1, iid: 1 }, { unique: true });
  await collection.createIndex({ state: 1, finishedAt: 1, updatedAt: 1 });
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
  return collection.findOne({ projectId, iid }, { projection: { _id: 0 } });
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

export const startMergeRequestGameReady = async (
  projectId: number,
  iid: number,
  readyAt = new Date(),
): Promise<boolean> => {
  const collection = await getCollection();
  const result = await collection.updateOne(
    {
      projectId,
      iid,
      gameReadyAt: { $exists: false },
    },
    { $set: { gameReadyAt: readyAt } },
  );
  return result.modifiedCount === 1;
};

export const clearMergeRequestGameReady = async (
  projectId: number,
  iid: number,
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { projectId, iid, gameReadyAt: { $exists: true } },
    { $unset: { gameReadyAt: '' } },
  );
};

export const markMergeRequestGameOverdue = async (
  projectId: number,
  iid: number,
  overdueAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { projectId, iid },
    { $set: { gameMergeOverdueAt: overdueAt } },
  );
};

export const listMergeRequestsReadyForGamePenalty = async (
  limit = 200,
): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      gameReadyAt: { $type: 'date' },
      gameMergeOverdueAt: { $exists: false },
      isDraft: { $ne: true },
      $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }],
    })
    .sort({ gameReadyAt: 1 })
    .limit(limit)
    .toArray();
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
      $or: [
        { state: { $exists: false } },
        { state: { $nin: ['merged', 'closed'] } },
        { reviewerLabelsCleanupPending: true },
      ],
    })
    .sort({ updatedAt: -1 })
    .toArray();
};

export const listProjectIds = async (): Promise<number[]> => {
  const collection = await getCollection();
  const db = await getDb();
  const ids = [
    ...await collection.distinct('projectId'),
    ...await db.collection('gitlab_projects').distinct('projectId'),
  ];
  return [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
};

const expiredMergeRequestFilter = (cutoff: Date): Filter<MergeRequestDocument> => ({
  state: { $in: ['closed', 'merged'] },
  reviewerLabelsCleanupPending: { $ne: true },
  $or: [
    { finishedAt: { $type: 'date', $lte: cutoff } },
    // Legacy records have no closure timestamp. Last modification is a
    // conservative fallback; never use creation time to expire an MR.
    { finishedAt: null, updatedAt: { $type: 'date', $lte: cutoff } },
  ],
});

export const listExpiredMergeRequests = async (
  cutoff: Date,
  limit = 200,
): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection.find(expiredMergeRequestFilter(cutoff))
    .limit(limit)
    .toArray();
};

export const deleteExpiredMergeRequest = async (
  projectId: number,
  iid: number,
  cutoff: Date,
): Promise<boolean> => {
  const collection = await getCollection();
  // Backfill discovers projects from stored MRs. Keep the project ID even
  // after its last completed MR is removed, without retaining the whole MR.
  const db = await getDb();
  await db.collection<{ _id: string; projectId: number }>('gitlab_projects').updateOne(
    { _id: String(projectId) }, { $setOnInsert: { projectId } }, { upsert: true },
  );
  // Recheck all conditions in the atomic delete, not only in the earlier scan.
  const result = await collection.deleteOne({ projectId, iid, ...expiredMergeRequestFilter(cutoff) });
  return result.deletedCount === 1;
};

export const listPendingReviewsForReviewer = async (
  gitlabUsername: string,
  limit = 10,
): Promise<MergeRequestDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      $or: [
        { reviewers: { $regex: `^${escapeRegex(gitlabUsername)}$`, $options: 'i' } },
        { reviewCommenters: { $regex: `^${escapeRegex(gitlabUsername)}$`, $options: 'i' } },
      ],
      approvedBy: { $not: new RegExp(`^${escapeRegex(gitlabUsername)}$`, 'i') },
      'author.gitlabUsername': { $not: new RegExp(`^${escapeRegex(gitlabUsername)}$`, 'i') },
      isDraft: { $ne: true },
      $and: [
        { $or: [{ state: { $exists: false } }, { state: { $nin: ['merged', 'closed'] } }] },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
};
