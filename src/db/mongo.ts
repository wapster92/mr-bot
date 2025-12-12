import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

let clientPromise: Promise<MongoClient> | null = null;
let hasConnected = false;

const getClient = (): Promise<MongoClient> => {
  if (!config.mongo.uri) {
    throw new Error('MONGODB_URI is not defined. Set it in .env to enable persistence.');
  }

  if (!clientPromise) {
    clientPromise = MongoClient.connect(config.mongo.uri)
      .then((client) => {
        hasConnected = true;
        console.log('[mongo] Connected');
        return client;
      })
      .catch((error) => {
        console.error('[mongo] Connection failed', error);
        throw error;
      });
  }

  return clientPromise;
};

export const getDb = async (): Promise<Db> => {
  const client = await getClient();
  return client.db(config.mongo.dbName);
};

export const ensureMongoConnection = async (): Promise<void> => {
  if (!config.mongo.uri) {
    console.warn('[mongo] Skipping connection (MONGODB_URI is not set)');
    return;
  }

  await getClient();
};
