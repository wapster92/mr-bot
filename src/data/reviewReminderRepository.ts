import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';

export type ReviewReminderDocument = {
  projectId: number;
  iid: number;
  reviewerUsername: string;
  reviewerUsernameLower: string;
  assignedAt: Date;
  reminderCount: number;
  lastReminderAt?: Date;
  reviewCompletedAt?: Date;
  escalatedAt?: Date;
  inactiveAt?: Date;
  processingAt?: Date;
  gameStartedAt?: Date;
};

const COLLECTION_NAME = 'review_reminders';

const getCollection = async (): Promise<Collection<ReviewReminderDocument>> => {
  const db = await getDb();
  const collection = db.collection<ReviewReminderDocument>(COLLECTION_NAME);
  await collection.createIndex({ projectId: 1, iid: 1, reviewerUsernameLower: 1 }, { unique: true });
  await collection.createIndex({ reviewCompletedAt: 1 });
  await collection.createIndex({ escalatedAt: 1 });
  await collection.createIndex({ inactiveAt: 1 });
  await collection.createIndex({ processingAt: 1 });
  return collection;
};

export const listPendingReviewReminders = async (
  limit = 200,
): Promise<ReviewReminderDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({
      reviewCompletedAt: { $exists: false },
      escalatedAt: { $exists: false },
      inactiveAt: { $exists: false },
    })
    .sort({ assignedAt: 1 })
    .limit(limit)
    .toArray();
};

export const listReviewRemindersForMr = async (
  projectId: number,
  iid: number,
): Promise<ReviewReminderDocument[]> => {
  const collection = await getCollection();
  return collection.find({ projectId, iid }).toArray();
};

export const findReviewReminderForReviewer = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
): Promise<ReviewReminderDocument | null> => {
  const collection = await getCollection();
  return collection.findOne({
    projectId,
    iid,
    reviewerUsernameLower: reviewerUsername.toLowerCase(),
  });
};

export const ensureReviewReminderGameStarted = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  startedAt = new Date(),
): Promise<ReviewReminderDocument | null> => {
  const collection = await getCollection();
  const filter = {
    projectId,
    iid,
    reviewerUsernameLower: reviewerUsername.toLowerCase(),
  };
  await collection.updateOne(
    { ...filter, gameStartedAt: { $exists: false } },
    { $set: { gameStartedAt: startedAt } },
  );
  return collection.findOne(filter);
};

export const upsertReviewReminder = async (input: {
  projectId: number;
  iid: number;
  reviewerUsername: string;
  assignedAt: Date;
}): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId: input.projectId,
      iid: input.iid,
      reviewerUsernameLower: input.reviewerUsername.toLowerCase(),
    },
    {
      $setOnInsert: {
        projectId: input.projectId,
        iid: input.iid,
        reviewerUsername: input.reviewerUsername,
        reviewerUsernameLower: input.reviewerUsername.toLowerCase(),
        assignedAt: input.assignedAt,
        reminderCount: 0,
      },
      $unset: { inactiveAt: '' },
    },
    { upsert: true },
  );
  await collection.updateOne(
    {
      projectId: input.projectId,
      iid: input.iid,
      reviewerUsernameLower: input.reviewerUsername.toLowerCase(),
      gameStartedAt: { $exists: false },
    },
    { $set: { gameStartedAt: input.assignedAt } },
  );
};

export const resetReviewReminder = async (input: {
  projectId: number;
  iid: number;
  reviewerUsername: string;
  assignedAt: Date;
}): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId: input.projectId,
      iid: input.iid,
      reviewerUsernameLower: input.reviewerUsername.toLowerCase(),
    },
    {
      $set: {
        assignedAt: input.assignedAt,
        reminderCount: 0,
        gameStartedAt: input.assignedAt,
      },
      $unset: {
        lastReminderAt: '',
        reviewCompletedAt: '',
        escalatedAt: '',
        inactiveAt: '',
        processingAt: '',
      },
    },
  );
};

export const markReminderInactive = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  inactiveAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
    },
    {
      $set: { inactiveAt },
      $unset: { processingAt: '' },
    },
  );
};

export const markReviewCompleted = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  completedAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
    },
    {
      $set: { reviewCompletedAt: completedAt },
      $unset: { processingAt: '' },
    },
  );
};

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

export const claimReviewReminder = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  processingAt = new Date(),
): Promise<boolean> => {
  const collection = await getCollection();
  const staleProcessingAt = new Date(processingAt.getTime() - PROCESSING_TIMEOUT_MS);
  const result = await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
      reviewCompletedAt: { $exists: false },
      escalatedAt: { $exists: false },
      inactiveAt: { $exists: false },
      $or: [
        { processingAt: { $exists: false } },
        { processingAt: { $lte: staleProcessingAt } },
      ],
    },
    { $set: { processingAt } },
  );
  return result.modifiedCount === 1;
};

export const releaseReviewReminderClaim = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  processingAt: Date,
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
      processingAt,
    },
    { $unset: { processingAt: '' } },
  );
};

export const markEscalated = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  escalatedAt = new Date(),
  processingAt?: Date,
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
      ...(processingAt ? { processingAt } : {}),
    },
    {
      $set: { escalatedAt },
      $unset: { processingAt: '' },
    },
  );
};

export const incrementReminder = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  reminderAt = new Date(),
  processingAt?: Date,
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
      ...(processingAt ? { processingAt } : {}),
    },
    {
      $inc: { reminderCount: 1 },
      $set: { lastReminderAt: reminderAt },
      $unset: { processingAt: '' },
    },
  );
};
