import { deleteExpiredMergeRequest, listExpiredMergeRequests } from '../data/mergeRequestRepository';
import { withMergeRequestLock } from './mergeRequestLock';
import { MERGE_REQUEST_RETENTION_MS } from './mergeRequestRetention';

let running = false;
let started = false;

export const runMergeRequestCleanup = async (now = new Date()): Promise<number> => {
  if (running) return 0;
  running = true;
  try {
    const cutoff = new Date(now.getTime() - MERGE_REQUEST_RETENTION_MS);
    const expired = await listExpiredMergeRequests(cutoff);
    let deleted = 0;
    for (const mr of expired) {
      await withMergeRequestLock(mr.projectId, mr.iid, async () => {
        if (await deleteExpiredMergeRequest(mr.projectId, mr.iid, cutoff)) deleted += 1;
      });
    }
    if (deleted) console.info(`[mr-cleanup] Deleted ${deleted} closed/merged MR records older than 30 days`);
    return deleted;
  } finally {
    running = false;
  }
};

export const startMergeRequestCleanup = (): void => {
  if (started) return;
  started = true;
  const run = (): void => {
    void runMergeRequestCleanup().catch((error) => {
      console.warn('[mr-cleanup] Failed to remove expired MR records', error);
    });
  };
  run();
  setInterval(run, 60 * 60 * 1000);
};
