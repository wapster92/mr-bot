import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../db/mongo';

export type NotificationQueueDocument = {
  _id?: ObjectId;
  chatId: number;
  text: string;
  createdAt: Date;
  updatedAt?: Date;
  status?: 'pending' | 'delivered' | 'error';
  deliveredAt?: Date | null;
  errorAt?: Date | null;
  errorMessage?: string;
  telegramUsername?: string;
  gitlabUsername?: string;
  eventType?: string;
  mrKey?: string;
  dedupeKey?: string;
};

const COLLECTION_NAME = 'notification_queue';

const getCollection = async (): Promise<Collection<NotificationQueueDocument>> => {
  const db = await getDb();
  const collection = db.collection<NotificationQueueDocument>(COLLECTION_NAME);
  await collection.createIndex({ createdAt: 1 });
  await collection.createIndex({ deliveredAt: 1 });
  await collection.createIndex({ status: 1, createdAt: 1 });
  await collection.createIndex({ chatId: 1, dedupeKey: 1, status: 1 });
  return collection;
};

const findExistingByDedupeKey = async (
  chatId: number,
  dedupeKey: string,
): Promise<NotificationQueueDocument | null> => {
  const collection = await getCollection();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return collection.findOne({
    chatId,
    dedupeKey,
    $or: [
      { status: 'pending' },
      { status: { $exists: false } },
      { status: 'delivered', updatedAt: { $gte: oneDayAgo } },
    ],
  });
};

export const enqueueNotification = async (
  doc: NotificationQueueDocument,
): Promise<ObjectId> => {
  const collection = await getCollection();
  const now = new Date();
  if (doc.dedupeKey) {
    const existing = await findExistingByDedupeKey(doc.chatId, doc.dedupeKey);
    if (existing?._id) {
      await collection.updateOne(
        { _id: existing._id },
        {
          $set: {
            text: doc.text,
            updatedAt: now,
            status: 'pending',
            ...(doc.eventType ? { eventType: doc.eventType } : {}),
            ...(doc.mrKey ? { mrKey: doc.mrKey } : {}),
            ...(doc.gitlabUsername ? { gitlabUsername: doc.gitlabUsername } : {}),
            ...(doc.telegramUsername ? { telegramUsername: doc.telegramUsername } : {}),
          },
          $setOnInsert: { createdAt: doc.createdAt ?? now },
        },
      );
      return existing._id;
    }
  }
  const result = await collection.insertOne({
    ...doc,
    status: 'pending',
    createdAt: doc.createdAt ?? now,
    updatedAt: now,
    deliveredAt: null,
    errorAt: null,
  });
  return result.insertedId;
};

export const listQueuedNotifications = async (
  limit = 200,
): Promise<NotificationQueueDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({ $or: [{ status: 'pending' }, { status: { $exists: false } }] })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
};

export const markNotificationDelivered = async (
  id: ObjectId,
  deliveredAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { _id: id },
    { $set: { deliveredAt, updatedAt: deliveredAt, status: 'delivered' } },
  );
};

export const markNotificationError = async (
  id: ObjectId,
  errorMessage: string,
  errorAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { _id: id },
    {
      $set: {
        errorAt,
        updatedAt: errorAt,
        status: 'error',
        errorMessage,
      },
    },
  );
};

export const listErroredNotifications = async (
  limit = 20,
): Promise<NotificationQueueDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({ status: 'error' })
    .sort({ errorAt: -1 })
    .limit(limit)
    .toArray();
};
