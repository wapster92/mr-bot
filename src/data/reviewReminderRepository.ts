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
};

const COLLECTION_NAME = 'review_reminders';

const getCollection = async (): Promise<Collection<ReviewReminderDocument>> => {
  const db = await getDb();
  const collection = db.collection<ReviewReminderDocument>(COLLECTION_NAME);
  await collection.createIndex({ projectId: 1, iid: 1, reviewerUsernameLower: 1 }, { unique: true });
  await collection.createIndex({ reviewCompletedAt: 1 });
  await collection.createIndex({ escalatedAt: 1 });
  await collection.createIndex({ inactiveAt: 1 });
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
      },
      $unset: {
        lastReminderAt: '',
        reviewCompletedAt: '',
        escalatedAt: '',
        inactiveAt: '',
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
    { $set: { inactiveAt } },
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
    { $set: { reviewCompletedAt: completedAt } },
  );
};

export const markEscalated = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  escalatedAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
    },
    { $set: { escalatedAt } },
  );
};

export const incrementReminder = async (
  projectId: number,
  iid: number,
  reviewerUsername: string,
  reminderAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    {
      projectId,
      iid,
      reviewerUsernameLower: reviewerUsername.toLowerCase(),
    },
    {
      $inc: { reminderCount: 1 },
      $set: { lastReminderAt: reminderAt },
    },
  );
};
