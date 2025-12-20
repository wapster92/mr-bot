import type { Collection, WithId } from 'mongodb';
import { getDb } from '../db/mongo';
import { users, type UserRecord } from './users';

type UserChatDocument = {
  telegramUserId: number;
  chatId: number;
  telegramUsername?: string;
  telegramUsernameLower?: string;
};

type GitlabUserDocument = {
  username: string;
  usernameLower: string;
  name?: string;
  updatedAt: Date;
};

const COLLECTION_NAME = 'user_chats';
const GITLAB_USERS_COLLECTION = 'gitlab_users';

const normalizeUsername = (username: string): string => username.toLowerCase();

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const getCollection = async (): Promise<Collection<UserChatDocument>> => {
  const db = await getDb();
  return db.collection<UserChatDocument>(COLLECTION_NAME);
};

const getGitlabUsersCollection = async (): Promise<Collection<GitlabUserDocument>> => {
  const db = await getDb();
  const collection = db.collection<GitlabUserDocument>(GITLAB_USERS_COLLECTION);
  await collection.createIndex({ usernameLower: 1 }, { unique: true });
  return collection;
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

export const getTelegramUserIdByUsername = async (username: string): Promise<number | undefined> => {
  if (!username) {
    return undefined;
  }
  const collection = await getCollection();
  const doc = await collection.findOne({ telegramUsernameLower: normalizeUsername(username) });
  return doc?.telegramUserId;
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

export const upsertGitlabUserProfile = async (username: string, name?: string): Promise<void> => {
  if (!username || !name) {
    return;
  }
  const collection = await getGitlabUsersCollection();
  await collection.updateOne(
    { usernameLower: normalizeUsername(username) },
    {
      $set: {
        username,
        usernameLower: normalizeUsername(username),
        name,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
};

export const getGitlabUserProfile = async (username: string): Promise<GitlabUserDocument | null> => {
  if (!username) {
    return null;
  }
  const collection = await getGitlabUsersCollection();
  return collection.findOne({ usernameLower: normalizeUsername(username) });
};

export const formatGitlabUserLabel = async (
  username?: string,
  fallbackName?: string,
): Promise<string> => {
  if (!username) {
    return escapeHtml(fallbackName ?? '—');
  }

  const profile = await getGitlabUserProfile(username);
  const mapped = getUserByGitlabUsername(username);
  const displayName =
    profile?.name ||
    fallbackName ||
    [mapped?.firstName, mapped?.lastName].filter(Boolean).join(' ') ||
    mapped?.telegramUsername ||
    username;

  if (mapped?.telegramUsername) {
    const telegramUserId = await getTelegramUserIdByUsername(mapped.telegramUsername);
    const label = escapeHtml(displayName);
    if (telegramUserId) {
      return `<a href="tg://user?id=${telegramUserId}">${label}</a>`;
    }
    return `<a href="https://t.me/${escapeHtml(mapped.telegramUsername)}">${label}</a>`;
  }

  return escapeHtml(displayName);
};
