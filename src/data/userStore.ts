import type { Collection } from 'mongodb';
import { getDb } from '../db/mongo';
import type { UserRecord } from './userTypes';

export type UserDocument = UserRecord & {
  gitlabUsernameLower: string;
  telegramUsernameLower?: string;
};

const COLLECTION_NAME = 'users';

const normalizeUsername = (username: string): string => username.toLowerCase();

const getCollection = async (): Promise<Collection<UserDocument>> => {
  const db = await getDb();
  const collection = db.collection<UserDocument>(COLLECTION_NAME);
  await collection.createIndex({ gitlabUsernameLower: 1 }, { unique: true });
  await collection.createIndex({ gitlabUserId: 1 }, { unique: true, sparse: true });
  await collection.createIndex({ telegramUsernameLower: 1 }, { unique: true, sparse: true });
  await collection.createIndex({ telegramUserId: 1 }, { unique: true, sparse: true });
  await collection.createIndex({ chatId: 1 }, { unique: true, sparse: true });
  return collection;
};

export const getUserByTelegramUsername = async (
  username?: string,
): Promise<UserDocument | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  return (
    (await collection.findOne({
      telegramUsernameLower: normalizeUsername(username),
      isAllowed: true,
    })) ?? undefined
  );
};

export const getReviewerByTelegramUsername = async (
  username?: string,
): Promise<UserDocument | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  return (
    (await collection.findOne({
      telegramUsernameLower: normalizeUsername(username),
      gitlabUsername: { $type: 'string' },
      $or: [{ isAllowed: true }, { isActive: true }],
    })) ?? undefined
  );
};

export const getUserByGitlabUsername = async (
  username?: string,
): Promise<UserDocument | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  return (
    (await collection.findOne({
      gitlabUsernameLower: normalizeUsername(username),
      isAllowed: true,
    })) ?? undefined
  );
};

export const listLeadUsers = async (): Promise<UserDocument[]> => {
  const collection = await getCollection();
  return collection.find({ isLead: true, isAllowed: true }).toArray();
};

export const listActiveReviewers = async (): Promise<string[]> => {
  const collection = await getCollection();
  const docs = await collection
    .find({
      isAllowed: true,
      isLead: { $ne: true },
      isActive: { $ne: false },
      gitlabUsername: { $type: 'string' },
    })
    .project({ gitlabUsername: 1 })
    .toArray();
  return docs.map((doc) => doc.gitlabUsername).filter(Boolean);
};

export const persistUserChatId = async (
  telegramUserId: number,
  chatId: number,
  username?: string,
): Promise<void> => {
  if (!username) {
    return;
  }
  const collection = await getCollection();
  await collection.updateOne(
    { telegramUsernameLower: normalizeUsername(username), isAllowed: true },
    {
      $set: {
        telegramUsername: username,
        telegramUsernameLower: normalizeUsername(username),
        telegramUserId,
        chatId,
        updatedAt: new Date(),
      },
    },
  );
};

export const upsertAllowedUser = async (input: {
  telegramUsername: string;
  gitlabUsername: string;
  name?: string;
}): Promise<void> => {
  const collection = await getCollection();
  await collection.updateOne(
    { gitlabUsernameLower: normalizeUsername(input.gitlabUsername) },
    {
      $set: {
        gitlabUsername: input.gitlabUsername,
        gitlabUsernameLower: normalizeUsername(input.gitlabUsername),
        telegramUsername: input.telegramUsername,
        telegramUsernameLower: normalizeUsername(input.telegramUsername),
        ...(input.name ? { name: input.name } : {}),
        isAllowed: true,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        isActive: true,
        isLead: false,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
};

export const getUserChatId = async (telegramUserId: number): Promise<number | undefined> => {
  const collection = await getCollection();
  const doc = await collection.findOne({ telegramUserId, isAllowed: true });
  return doc?.chatId;
};

export const getTelegramUserIdByUsername = async (
  username: string,
): Promise<number | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  const doc = await collection.findOne({
    telegramUsernameLower: normalizeUsername(username),
    isAllowed: true,
  });
  return doc?.telegramUserId;
};

export const getChatIdByUsername = async (username: string): Promise<number | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  const doc = await collection.findOne({
    telegramUsernameLower: normalizeUsername(username),
    isAllowed: true,
  });
  return doc?.chatId;
};

export const upsertGitlabUserProfile = async (
  username: string,
  name?: string,
  gitlabUserId?: number,
): Promise<void> => {
  if (!username) {
    return;
  }
  const collection = await getCollection();
  const setPayload: Record<string, unknown> = {
    gitlabUsername: username,
    gitlabUsernameLower: normalizeUsername(username),
    updatedAt: new Date(),
  };
  if (name) {
    setPayload.name = name;
  }
  if (gitlabUserId) {
    setPayload.gitlabUserId = gitlabUserId;
  }
  await collection.updateOne(
    { gitlabUsernameLower: normalizeUsername(username), isAllowed: true },
    {
      $set: setPayload,
    },
  );
};

export const getGitlabUserProfile = async (
  username: string,
): Promise<UserDocument | null> => {
  if (!username) {
    return null;
  }
  const collection = await getCollection();
  return collection.findOne({
    gitlabUsernameLower: normalizeUsername(username),
    isAllowed: true,
  });
};

export const getGitlabUserIdByUsername = async (
  username?: string,
): Promise<number | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  const doc = await collection.findOne({
    gitlabUsernameLower: normalizeUsername(username),
    isAllowed: true,
  });
  return doc?.gitlabUserId;
};
