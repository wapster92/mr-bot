import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../db/mongo';

export type NotificationQueueDocument = {
  _id?: ObjectId;
  chatId: number;
  text: string;
  createdAt: Date;
  updatedAt?: Date;
  status?: 'pending' | 'processing' | 'delivered' | 'error' | 'cancelled';
  processingAt?: Date | null;
  deliveredAt?: Date | null;
  errorAt?: Date | null;
  errorMessage?: string;
  cancelledAt?: Date | null;
  cancelReason?: string;
  telegramUsername?: string;
  gitlabUsername?: string;
  eventType?: string;
  mrKey?: string;
  dedupeKey?: string;
  deliveryKey?: string;
};

export type EnqueueNotificationResult = {
  id: ObjectId;
  shouldSend: boolean;
};

type InitialNotificationStatus = 'pending' | 'processing';

const COLLECTION_NAME = 'notification_queue';

const getCollection = async (): Promise<Collection<NotificationQueueDocument>> => {
  const db = await getDb();
  const collection = db.collection<NotificationQueueDocument>(COLLECTION_NAME);
  await collection.createIndex({ createdAt: 1 });
  await collection.createIndex({ deliveredAt: 1 });
  await collection.createIndex({ status: 1, createdAt: 1 });
  await collection.createIndex({ chatId: 1, dedupeKey: 1, status: 1 });
  await collection.createIndex({ deliveryKey: 1 }, { unique: true, sparse: true });
  return collection;
};

const buildDeliveryKey = (chatId: number, dedupeKey: string): string =>
  `${chatId}:${dedupeKey}`;

export const enqueueNotification = async (
  doc: NotificationQueueDocument,
  initialStatus: InitialNotificationStatus = 'pending',
): Promise<EnqueueNotificationResult> => {
  const collection = await getCollection();
  const now = new Date();
  if (doc.dedupeKey) {
    const deliveryKey = buildDeliveryKey(doc.chatId, doc.dedupeKey);
    try {
      const result = await collection.updateOne(
        { deliveryKey },
        {
          $setOnInsert: {
            ...doc,
            deliveryKey,
            status: initialStatus,
            createdAt: doc.createdAt ?? now,
            updatedAt: now,
            processingAt: initialStatus === 'processing' ? now : null,
            deliveredAt: null,
            errorAt: null,
          },
        },
        { upsert: true },
      );
      if (result.upsertedId) {
        return {
          id: result.upsertedId,
          shouldSend: initialStatus === 'processing',
        };
      }
    } catch (error) {
      // A concurrent upsert can win the unique-key race.
      const existing = await collection.findOne({ deliveryKey });
      if (!existing?._id) {
        throw error;
      }
      return { id: existing._id, shouldSend: false };
    }

    const existing = await collection.findOne({ deliveryKey });
    if (!existing?._id) {
      throw new Error(`Notification delivery key disappeared: ${deliveryKey}`);
    }
    return { id: existing._id, shouldSend: false };
  }
  const result = await collection.insertOne({
    ...doc,
    status: initialStatus,
    createdAt: doc.createdAt ?? now,
    updatedAt: now,
    processingAt: initialStatus === 'processing' ? now : null,
    deliveredAt: null,
    errorAt: null,
  });
  return {
    id: result.insertedId,
    shouldSend: initialStatus === 'processing',
  };
};

const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

export const listQueuedNotifications = async (
  limit = 200,
): Promise<NotificationQueueDocument[]> => {
  const collection = await getCollection();
  const staleProcessingAt = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
  return collection
    .find({
      $or: [
        { status: 'pending' },
        { status: { $exists: false } },
        { status: 'processing', processingAt: { $lte: staleProcessingAt } },
      ],
    })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
};

export const claimNotification = async (
  id: ObjectId,
  processingAt = new Date(),
): Promise<boolean> => {
  const collection = await getCollection();
  const staleProcessingAt = new Date(processingAt.getTime() - PROCESSING_TIMEOUT_MS);
  const result = await collection.updateOne(
    {
      _id: id,
      $or: [
        { status: 'pending' },
        { status: { $exists: false } },
        { status: 'processing', processingAt: { $lte: staleProcessingAt } },
      ],
    },
    {
      $set: {
        status: 'processing',
        processingAt,
        updatedAt: processingAt,
      },
    },
  );
  return result.modifiedCount === 1;
};

export const markNotificationDelivered = async (
  id: ObjectId,
  deliveredAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { _id: id },
    {
      $set: { deliveredAt, updatedAt: deliveredAt, status: 'delivered' },
      $unset: { processingAt: '' },
    },
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
      $unset: { processingAt: '' },
    },
  );
};

export const markNotificationCancelled = async (
  id: ObjectId,
  cancelReason: string,
  cancelledAt = new Date(),
): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { _id: id },
    {
      $set: {
        cancelledAt,
        updatedAt: cancelledAt,
        status: 'cancelled',
        cancelReason,
      },
      $unset: { processingAt: '' },
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
