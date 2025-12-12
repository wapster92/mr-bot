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
  reviewers?: string[];
  lastLintStatus?: string;
  finalReviewNotified?: boolean;
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
