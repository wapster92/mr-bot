import { getScoreVersion, listScoreTotals } from '../data/scoreEventRepository';
import { getSeasonKey } from './gameSeason';

export const REVIEW_REWARD_MIN_XP = 600;
export const REVIEW_REWARD_PLACES = 2;

let cached: {
  season: string;
  version: number;
  fetchedAt: number;
  promise: Promise<Set<string>>;
} | undefined;

export const getReviewExemptUsernames = async (now = new Date()): Promise<Set<string>> => {
  const season = getSeasonKey(now);
  const version = getScoreVersion();
  if (cached && cached.season === season && cached.version === version &&
    Date.now() - cached.fetchedAt < 60_000) {
    return new Set(await cached.promise);
  }
  const promise = listScoreTotals({ season, limit: REVIEW_REWARD_PLACES }).then((totals) =>
    new Set(totals
      .slice(0, REVIEW_REWARD_PLACES)
      .filter((total) => total.points >= REVIEW_REWARD_MIN_XP)
      .map((total) => total.usernameLower)),
  );
  const entry = { season, version, fetchedAt: Date.now(), promise };
  cached = entry;
  try {
    return new Set(await promise);
  } catch (error) {
    if (cached === entry) cached = undefined;
    throw error;
  }
};
