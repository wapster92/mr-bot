import type { DailyReviewGrant } from '../data/reviewRewardRepository';
import type { ReviewScoreActivity, ReviewScoreBalance } from '../data/scoreEventRepository';

export const REVIEW_REWARD_MIN_XP = 600;
export const REVIEW_REWARD_PLACES = 1;
export const MIN_REVIEWERS_AFTER_REWARD = 3;

export const selectInitialReviewGrants = (
  baseline: ReviewScoreBalance[],
  participants: Set<string>,
  dayStart: Date,
): DailyReviewGrant[] => baseline
  .filter((total) => participants.has(total.usernameLower) && total.points >= REVIEW_REWARD_MIN_XP)
  .sort((left, right) => right.points - left.points ||
    (left.usernameLower < right.usernameLower ? -1 : left.usernameLower > right.usernameLower ? 1 : 0))
  .slice(0, REVIEW_REWARD_PLACES)
  .map((total) => ({ ...total, grantedAt: dayStart }));

export const fillDailyReviewGrants = (
  baseline: ReviewScoreBalance[],
  existing: DailyReviewGrant[],
  activity: ReviewScoreActivity[],
  participants: Set<string>,
): DailyReviewGrant[] => {
  const grants = [...existing];
  const claimed = new Set(grants.map((grant) => grant.usernameLower));
  const balances = new Map(baseline.map((balance) => [balance.usernameLower, balance.points]));
  const ordered = [...activity].sort((left, right) => left.at.getTime() - right.at.getTime() ||
    (left.usernameLower < right.usernameLower ? -1 : left.usernameLower > right.usernameLower ? 1 : 0) ||
    (left.eventKey < right.eventKey ? -1 : left.eventKey > right.eventKey ? 1 : 0));
  for (const event of ordered) {
    if (grants.length >= REVIEW_REWARD_PLACES) break;
    const points = (balances.get(event.usernameLower) ?? 0) + event.points;
    balances.set(event.usernameLower, points);
    if (points >= REVIEW_REWARD_MIN_XP && participants.has(event.usernameLower) && !claimed.has(event.usernameLower)) {
      grants.push({ usernameLower: event.usernameLower, points, grantedAt: event.at });
      claimed.add(event.usernameLower);
    }
  }
  return grants;
};
