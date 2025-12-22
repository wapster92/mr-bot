import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../db/mongo';

export type NotificationQueueDocument = {
  _id?: ObjectId;
  chatId: number;
  text: string;
  createdAt: Date;
  deliveredAt?: Date | null;
  telegramUsername?: string;
  gitlabUsername?: string;
};

const COLLECTION_NAME = 'notification_queue';

const getCollection = async (): Promise<Collection<NotificationQueueDocument>> => {
  const db = await getDb();
  const collection = db.collection<NotificationQueueDocument>(COLLECTION_NAME);
  await collection.createIndex({ createdAt: 1 });
  await collection.createIndex({ deliveredAt: 1 });
  return collection;
};

export const enqueueNotification = async (doc: NotificationQueueDocument): Promise<ObjectId> => {
  const collection = await getCollection();
  const result = await collection.insertOne({ ...doc, deliveredAt: null });
  return result.insertedId;
};

export const listQueuedNotifications = async (
  limit = 200,
): Promise<NotificationQueueDocument[]> => {
  const collection = await getCollection();
  return collection
    .find({ deliveredAt: null })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
};

export const markNotificationDelivered = async (
  id: ObjectId,
  deliveredAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne({ _id: id }, { $set: { deliveredAt } });
};
