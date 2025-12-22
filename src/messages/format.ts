import {
  getGitlabUserProfile,
  getTelegramUserIdByUsername,
  getUserByGitlabUsername,
} from '../data/userStore';

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const formatGitlabUserLabel = async (
  username?: string,
  fallbackName?: string,
): Promise<string> => {
  if (!username) {
    return escapeHtml(fallbackName ?? '—');
  }

  const profile = await getGitlabUserProfile(username);
  const mapped = await getUserByGitlabUsername(username);
  const displayName =
    profile?.name ||
    fallbackName ||
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
