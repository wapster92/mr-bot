import {
  ensureReviewRewardDay,
  findReviewRewardDay,
  listReviewRewardParticipants,
  saveDailyReviewGrants,
} from '../data/reviewRewardRepository';
import { listReviewScoreActivity, loadReviewScoreBaseline } from '../data/scoreEventRepository';
import { getGameDayKey, getGameDayStart, getSeasonKey } from './gameSeason';
import {
  fillDailyReviewGrants, selectInitialReviewGrants, REVIEW_REWARD_PLACES, MIN_REVIEWERS_AFTER_REWARD,
} from './reviewRewardPolicy';

export { REVIEW_REWARD_MIN_XP, REVIEW_REWARD_PLACES } from './reviewRewardPolicy';

export type ReviewRewardStatus = {
  exemptUsernames: Set<string>;
  awardedUsernames: string[];
  paused: boolean;
  activeReviewers: number;
};

const buildStatus = (awardedUsernames: string[], participants: Set<string>): ReviewRewardStatus => {
  awardedUsernames = awardedUsernames.slice(0, REVIEW_REWARD_PLACES);
  const paused = participants.size < MIN_REVIEWERS_AFTER_REWARD + REVIEW_REWARD_PLACES;
  return {
    awardedUsernames,
    exemptUsernames: new Set(paused ? [] : awardedUsernames.filter((name) => participants.has(name))),
    paused,
    activeReviewers: participants.size,
  };
};

export const getReviewRewardStatus = async (now = new Date()): Promise<ReviewRewardStatus> => {
  const day = getGameDayKey(now);
  const dayStart = getGameDayStart(now);
  const season = getSeasonKey(now);
  let stored = await findReviewRewardDay(day);
  const participants = new Set(await listReviewRewardParticipants());
  if (!stored) {
    const baseline = await loadReviewScoreBaseline(season, dayStart);
    stored = await ensureReviewRewardDay({
      day, season, baseline, revision: 0, createdAt: now,
      grants: selectInitialReviewGrants(baseline, participants, dayStart),
    });
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (stored.grants.length >= REVIEW_REWARD_PLACES) {
      return buildStatus(stored.grants.map((grant) => grant.usernameLower), participants);
    }
    const activity = await listReviewScoreActivity(season, dayStart, now);
    const grants = fillDailyReviewGrants(stored.baseline, stored.grants, activity, participants);
    if (grants.length === stored.grants.length) {
      return buildStatus(stored.grants.map((grant) => grant.usernameLower), participants);
    }
    if (await saveDailyReviewGrants(day, stored.revision, grants)) {
      return buildStatus(grants.map((grant) => grant.usernameLower), participants);
    }
    const latest = await findReviewRewardDay(day);
    if (!latest) throw new Error(`Daily review reward disappeared: ${day}`);
    stored = latest;
  }
  throw new Error(`Daily review rewards remained busy: ${day}`);
};

export const getReviewExemptUsernames = async (now = new Date()): Promise<Set<string>> =>
  (await getReviewRewardStatus(now)).exemptUsernames;
