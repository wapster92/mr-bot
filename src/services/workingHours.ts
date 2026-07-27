import { DEFAULT_WORK_HOURS } from '../data/userTypes';
import type { UserRecord } from '../data/userTypes';

const WEEKEND_DAYS = new Set(['Sat', 'Sun']);

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

const getLocalDateTime = (
  date: Date,
  timeZone: string,
): { day: string; minutes: number } => {
  const format = (resolvedTimeZone: string): { day: string; minutes: number } => {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: resolvedTimeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date);
    const day = parts.find((part) => part.type === 'weekday')?.value ?? '';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    return { day, minutes: hour * 60 + minute };
  };

  try {
    return format(timeZone);
  } catch (error) {
    if (error instanceof RangeError) {
      return format(DEFAULT_WORK_HOURS.timezone);
    }
    throw error;
  }
};

export const getWorkdayMinutes = (user: UserRecord): number => {
  if (user.ignoreWorkHours) {
    return 24 * 60;
  }
  const startMinutes =
    parseTimeToMinutes(user.workHours?.start ?? DEFAULT_WORK_HOURS.start) ?? 9 * 60;
  const endMinutes =
    parseTimeToMinutes(user.workHours?.end ?? DEFAULT_WORK_HOURS.end) ?? 18 * 60;
  if (startMinutes === endMinutes) {
    return 24 * 60;
  }
  if (startMinutes < endMinutes) {
    return endMinutes - startMinutes;
  }
  return 24 * 60 - (startMinutes - endMinutes);
};

export const isWithinWorkingHours = (user: UserRecord, now: Date): boolean => {
  if (user.isAllowed === false || user.isActive === false) {
    return false;
  }

  const timeZone = user.workHours?.timezone ?? DEFAULT_WORK_HOURS.timezone;
  const localDateTime = getLocalDateTime(now, timeZone);
  if (WEEKEND_DAYS.has(localDateTime.day)) {
    return false;
  }

  if (user.ignoreWorkHours) {
    return true;
  }

  const startMinutes =
    parseTimeToMinutes(user.workHours?.start ?? DEFAULT_WORK_HOURS.start) ?? 9 * 60;
  const endMinutes =
    parseTimeToMinutes(user.workHours?.end ?? DEFAULT_WORK_HOURS.end) ?? 18 * 60;
  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return localDateTime.minutes >= startMinutes && localDateTime.minutes < endMinutes;
  }
  return localDateTime.minutes >= startMinutes || localDateTime.minutes < endMinutes;
};
