import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';
import { listActiveReviewers } from './userStore';

const COLLECTION_NAME = 'reviewer_queue';

type ReviewerQueueDocument = {
  queue: string[];
  updatedAt: Date;
};

const getCollection = async (): Promise<Collection<ReviewerQueueDocument>> => {
  const db = await getDb();
  return db.collection<ReviewerQueueDocument>(COLLECTION_NAME);
};

const baseReviewerList = async (): Promise<string[]> => {
  const reviewers = await listActiveReviewers();
  return reviewers;
};

export const refreshQueue = async (): Promise<string[]> => {
  const queue = await baseReviewerList();
  const collection = await getCollection();
  await collection.updateOne(
    {},
    { $set: { queue, updatedAt: new Date() } },
    { upsert: true },
  );
  return queue;
};

export const fetchQueue = async (): Promise<string[]> => {
  const collection = await getCollection();
  const doc = await collection.findOne({});
  if (!doc || !doc.queue?.length) {
    return refreshQueue();
  }
  return doc.queue;
};

export const saveQueue = async (queue: string[]): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {},
    { $set: { queue, updatedAt: new Date() } },
    { upsert: true },
  );
};

export const pullReviewers = async (exclude: string[]): Promise<string[]> => {
  const normalizedExclude = exclude.map((item) => item.toLowerCase());
  let queue = await fetchQueue();
  const selected: string[] = [];

  while (selected.length < 2) {
    if (!queue.length) {
      queue = await refreshQueue();
    }

    const next = queue.shift();
    if (!next) {
      break;
    }

    if (
      normalizedExclude.includes(next.toLowerCase()) ||
      selected.map((n) => n.toLowerCase()).includes(next.toLowerCase())
    ) {
      continue;
    }

    selected.push(next);
  }

  await saveQueue(queue);
  return selected;
};
