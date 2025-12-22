import { getChatIdByUsername, listLeadUsers, getUserByGitlabUsername } from '../data/userStore';
import type { UserRecord } from '../data/userTypes';

const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '18:00';
const DEFAULT_TIMEZONE = 'Europe/Moscow';

const parseTimeToMinutes = (value: string): number | null => {
  const [hoursText, minutesText] = value.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

const getMinutesInTimezone = (date: Date, timeZone: string): number => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
};

export const isWithinWorkingHours = (user: UserRecord, now: Date): boolean => {
  if (user.ignoreWorkHours) {
    return true;
  }
  if (user.isActive === false) {
    return false;
  }
  const startText = user.workHours?.start ?? DEFAULT_WORK_START;
  const endText = user.workHours?.end ?? DEFAULT_WORK_END;
  const timeZone = user.workHours?.timezone ?? DEFAULT_TIMEZONE;
  const startMinutes = parseTimeToMinutes(startText) ?? parseTimeToMinutes(DEFAULT_WORK_START) ?? 540;
  const endMinutes = parseTimeToMinutes(endText) ?? parseTimeToMinutes(DEFAULT_WORK_END) ?? 1080;
  const nowMinutes = getMinutesInTimezone(now, timeZone);
  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
};

export type DeliveryRecipient = {
  chatId: number;
  telegramUsername?: string | undefined;
  gitlabUsername?: string | undefined;
  isWithinHours: boolean;
};

const toRecipient = async (
  user: UserRecord,
  now: Date,
): Promise<DeliveryRecipient | undefined> => {
  if (!user.telegramUsername) {
    return undefined;
  }
  const chatId = await getChatIdByUsername(user.telegramUsername);
  if (!chatId) {
    return undefined;
  }
  return {
    chatId,
    telegramUsername: user.telegramUsername ?? undefined,
    gitlabUsername: user.gitlabUsername ?? undefined,
    isWithinHours: isWithinWorkingHours(user, now),
  };
};

export const getLeadChatIds = async (): Promise<number[]> => {
  const leads = await listLeadUsers();
  const chatIds: number[] = [];
  const now = new Date();
  for (const lead of leads) {
    if (!lead.telegramUsername) continue;
    if (!isWithinWorkingHours(lead, now)) continue;
    const chatId = await getChatIdByUsername(lead.telegramUsername);
    if (chatId) {
      chatIds.push(chatId);
    }
  }
  return chatIds;
};

export const getLeadRecipients = async (): Promise<DeliveryRecipient[]> => {
  const leads = await listLeadUsers();
  const now = new Date();
  const recipients: DeliveryRecipient[] = [];
  for (const lead of leads) {
    const recipient = await toRecipient(lead, now);
    if (recipient) {
      recipients.push(recipient);
    }
  }
  return recipients;
};

export const getChatIdByGitlabUsername = async (
  gitlabUsername: string,
): Promise<number | undefined> => {
  const userRecord = await getUserByGitlabUsername(gitlabUsername);
  if (!userRecord?.telegramUsername) {
    return undefined;
  }
  if (!isWithinWorkingHours(userRecord, new Date())) {
    return undefined;
  }
  return getChatIdByUsername(userRecord.telegramUsername);
};

export const getRecipientByGitlabUsername = async (
  gitlabUsername: string,
): Promise<DeliveryRecipient | undefined> => {
  const userRecord = await getUserByGitlabUsername(gitlabUsername);
  if (!userRecord) {
    return undefined;
  }
  return toRecipient(userRecord, new Date());
};
