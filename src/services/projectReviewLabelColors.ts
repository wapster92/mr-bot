import { listOpenMergeRequests } from '../data/mergeRequestRepository';
import { listUsersForReviewLabels } from '../data/userStore';
import { buildProjectPersonalReviewLabels } from './reviewLabelPlan';
import { syncProjectPersonalLabelColors } from './reviewerLabelSync';

// Call after persisting MR changes. This only changes project label definitions,
// never MR assignments, timers or labels attached to other MRs.
export const refreshProjectReviewLabelColors = async (
  projectId: number,
  now?: Date,
): Promise<boolean> => {
  try {
    const ok = await syncProjectPersonalLabelColors(projectId, async () => {
      const [mergeRequests, users] = await Promise.all([
        listOpenMergeRequests(projectId), listUsersForReviewLabels(),
      ]);
      return buildProjectPersonalReviewLabels(
        mergeRequests.filter((mr) => mr.projectId === projectId), users, now ?? new Date(),
      );
    });
    if (!ok) console.warn(`[review-label-colors] Project ${projectId} colors deferred`);
    return ok;
  } catch (error) {
    console.warn(`[review-label-colors] Failed to refresh project ${projectId}`, error);
    return false;
  }
};
