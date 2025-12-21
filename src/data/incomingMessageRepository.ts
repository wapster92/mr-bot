import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';

type IncomingMessageDocument = {
  messageId?: number;
  text: string;
  receivedAt: Date;
  isAuthorized: boolean;
  from?: {
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    isBot?: boolean;
  };
  chat?: {
    id?: number;
    type?: string;
    title?: string;
    username?: string;
  };
};

const COLLECTION_NAME = 'incoming_messages';

const getCollection = async (): Promise<Collection<IncomingMessageDocument>> => {
  const db = await getDb();
  const collection = db.collection<IncomingMessageDocument>(COLLECTION_NAME);
  await collection.createIndex({ receivedAt: -1 });
  return collection;
};

export const persistIncomingMessage = async (
  doc: IncomingMessageDocument,
): Promise<void> => {
  const collection = await getCollection();
  await collection.insertOne(doc);
};
