import {
  findMergeRequest,
  listMergeRequestsReadyForGamePenalty,
} from '../data/mergeRequestRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import { recordMergeOverdueScore } from './gameScoring';
import { withMergeRequestLock } from './mergeRequestLock';
import { syncMergeRequestGameReadiness } from './mergeReadiness';
import { addWorkingMinutes, getWorkdayMinutes } from './workingHours';

const GAME_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
let schedulerRunning = false;
let schedulerStarted = false;

export const runGameScheduler = async (): Promise<void> => {
  if (schedulerRunning) {
    return;
  }
  schedulerRunning = true;
  try {
    const candidates = await listMergeRequestsReadyForGamePenalty(200);
    const now = new Date();
    for (const candidate of candidates) {
      await withMergeRequestLock(candidate.projectId, candidate.iid, async () => {
        await syncMergeRequestGameReadiness(candidate.projectId, candidate.iid, now);
        const mr = await findMergeRequest(candidate.projectId, candidate.iid);
        if (
          !mr?.gameReadyAt ||
          mr.gameMergeOverdueAt ||
          mr.isDraft ||
          ['merged', 'closed'].includes(mr.state ?? '')
        ) {
          return;
        }
        const authorUsername = mr.author.gitlabUsername;
        const author = authorUsername
          ? await getUserByGitlabUsername(authorUsername)
          : undefined;
        if (!author || author.isActive === false) {
          await recordMergeOverdueScore(mr, now);
          return;
        }
        const overdueAt = addWorkingMinutes(
          author,
          mr.gameReadyAt,
          getWorkdayMinutes(author) * 2,
        );
        if (now >= overdueAt) {
          await recordMergeOverdueScore(mr, overdueAt);
        }
      }).catch((error) => {
        console.warn(
          `[game] Failed to process merge timer ${candidate.projectId}/${candidate.iid}`,
          error,
        );
      });
    }
  } finally {
    schedulerRunning = false;
  }
};

export const startGameScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;
  const run = (): void => {
    void runGameScheduler().catch((error) => {
      console.error('[game] Scheduler failed', error);
    });
  };
  run();
  setInterval(run, GAME_SCHEDULER_INTERVAL_MS);
};
