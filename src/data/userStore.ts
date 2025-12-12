import type { Collection, WithId } from 'mongodb';
import { getDb } from '../db/mongo';
import { users, type UserRecord } from './users';

type UserChatDocument = {
  telegramUserId: number;
  chatId: number;
  telegramUsername?: string;
  telegramUsernameLower?: string;
};

const COLLECTION_NAME = 'user_chats';

const normalizeUsername = (username: string): string => username.toLowerCase();

const getCollection = async (): Promise<Collection<UserChatDocument>> => {
  const db = await getDb();
  return db.collection<UserChatDocument>(COLLECTION_NAME);
};

export const getUserByTelegramUsername = (username?: string): UserRecord | undefined => {
  if (!username) {
    return undefined;
  }

  return users.find((user) => user.telegramUsername.toLowerCase() === username.toLowerCase());
};

export const getUserByGitlabUsername = (username?: string): UserRecord | undefined => {
  if (!username) {
    return undefined;
  }

  return users.find((user) => user.gitlabUsername?.toLowerCase() === username.toLowerCase());
};

export const persistUserChatId = async (
  telegramUserId: number,
  chatId: number,
  username?: string,
): Promise<void> => {
  const collection = await getCollection();
  const updateDoc: Record<string, unknown> = {
    telegramUserId,
    chatId,
  };

  if (username) {
    updateDoc.telegramUsername = username;
    updateDoc.telegramUsernameLower = normalizeUsername(username);
  }

  await collection.updateOne(
    { telegramUserId },
    {
      $set: updateDoc,
    },
    { upsert: true },
  );
};

export const getUserChatId = async (telegramUserId: number): Promise<number | undefined> => {
  const collection = await getCollection();
  const doc = await collection.findOne({ telegramUserId });
  return doc?.chatId;
};

export const getChatIdByUsername = async (username: string): Promise<number | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  const doc = await collection.findOne({ telegramUsernameLower: normalizeUsername(username) });
  return doc?.chatId;
};

export const getLeadUsers = (): UserRecord[] => users.filter((user) => user.isLead);
