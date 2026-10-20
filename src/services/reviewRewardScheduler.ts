import { getReviewExemptUsernames } from './reviewRewards';

let running = false;
let started = false;

export const runReviewRewardScheduler = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    await getReviewExemptUsernames();
  } finally {
    running = false;
  }
};

export const startReviewRewardScheduler = (): void => {
  if (started) return;
  started = true;
  const run = (): void => {
    void runReviewRewardScheduler().catch((error) => {
      console.warn('[review-rewards] Failed to refresh daily grants', error);
    });
  };
  run();
  setInterval(run, 60_000);
};
