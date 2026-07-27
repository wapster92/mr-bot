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
