const GAME_TIMEZONE = 'Europe/Moscow';

const getDatePart = (
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string => parts.find((part) => part.type === type)?.value ?? '';

export const getSeasonKey = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: GAME_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  return `${getDatePart(parts, 'year')}-${getDatePart(parts, 'month')}`;
};

export const formatSeasonLabel = (season: string): string => {
  const match = /^(\d{4})-(\d{2})$/.exec(season);
  if (!match?.[1] || !match[2]) {
    return season;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const month = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    month: 'long',
  }).format(date);
  return `${month} ${match[1]}`;
};

export const shiftSeason = (season: string, months: number): string => {
  const [year, month] = season.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + months, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const formatSeasonInput = (season: string): string => {
  const [year, month] = season.split('-');
  return `${month}.${year}`;
};

export const parseSeasonInput = (input: string, now = new Date()): string | undefined => {
  const match = /^(0[1-9]|1[0-2])\.(\d{4})$/.exec(input.trim());
  if (!match || Number(match[2]) < 1970) return undefined;
  const season = `${match[2]}-${match[1]}`;
  return season <= getSeasonKey(now) ? season : undefined;
};
