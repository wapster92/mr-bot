import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';
import { listActiveReviewers } from './userStore';

const COLLECTION_NAME = 'reviewer_queue';
let queueOperation = Promise.resolve();

type ReviewerQueueDocument = {
  queue: string[];
  updatedAt: Date;
};

const getCollection = async (): Promise<Collection<ReviewerQueueDocument>> => {
  const db = await getDb();
  return db.collection<ReviewerQueueDocument>(COLLECTION_NAME);
};

const baseReviewerList = async (): Promise<string[]> => {
  return listActiveReviewers();
};

const withQueueOperation = async <T>(task: () => Promise<T>): Promise<T> => {
  const previous = queueOperation;
  let release = (): void => {};
  queueOperation = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
};

const refreshQueueUnlocked = async (): Promise<string[]> => {
  const queue = await baseReviewerList();
  const collection = await getCollection();
  await collection.updateOne(
    {},
    { $set: { queue, updatedAt: new Date() } },
    { upsert: true },
  );
  return queue;
};

export const refreshQueue = async (): Promise<string[]> =>
  withQueueOperation(refreshQueueUnlocked);

const fetchQueue = async (): Promise<string[]> => {
  const collection = await getCollection();
  const doc = await collection.findOne({});
  if (!doc || !doc.queue?.length) {
    return refreshQueueUnlocked();
  }
  return doc.queue;
};

const saveQueue = async (queue: string[]): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {},
    { $set: { queue, updatedAt: new Date() } },
    { upsert: true },
  );
};

const pullReviewersUnlocked = async (exclude: string[]): Promise<string[]> => {
  const normalizedExclude = new Set(exclude.map((item) => item.toLowerCase()));
  const activeReviewers = await baseReviewerList();
  const activeSet = new Set(activeReviewers.map((item) => item.toLowerCase()));
  let queue = await fetchQueue();
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  let refreshed = false;

  while (selected.length < 2) {
    if (!queue.length) {
      if (refreshed) {
        break;
      }
      queue = await refreshQueueUnlocked();
      refreshed = true;
    }

    const next = queue.shift();
    if (!next) {
      break;
    }

    const normalizedNext = next.toLowerCase();
    if (
      !activeSet.has(normalizedNext) ||
      normalizedExclude.has(normalizedNext) ||
      selectedSet.has(normalizedNext)
    ) {
      continue;
    }

    selected.push(next);
    selectedSet.add(normalizedNext);
  }

  await saveQueue(queue);
  return selected;
};

export const pullReviewers = async (exclude: string[]): Promise<string[]> => {
  return withQueueOperation(() => pullReviewersUnlocked(exclude));
};
