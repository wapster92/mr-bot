import type { MergeApprovalAudit, MergeRequestDocument } from '../data/mergeRequestRepository';
import { listActiveReviewers, listActiveUsernames, listLeadUsers } from '../data/userStore';
import { hasRequiredMergeApprovals, summarizeMergeRequestApprovals } from './approvalPolicy';
import { loadReviewCommentHistory } from './reviewCommentHistory';

type MergeActor = { username?: string; name?: string; id?: number };

// Caller holds the MR lock and persists the result before delivering notifications.
// Keep this snapshot: later role changes or repeated webhooks must not change the verdict.
export const auditMergeApprovals = async (
  mr: MergeRequestDocument,
  merger: MergeActor,
  approvalsVerified: boolean,
): Promise<MergeApprovalAudit> => {
  if (mr.mergeApprovalAudit) return mr.mergeApprovalAudit;
  const leads = await listLeadUsers();
  const audit: MergeApprovalAudit = {
    status: 'unverified', missingApprovals: [],
    ...(merger.username ? { mergerUsername: merger.username } : {}),
    ...(merger.name ? { mergerName: merger.name } : {}),
  };
  const mergingLead = leads.find((lead) =>
    (merger.username && lead.gitlabUsername.toLowerCase() === merger.username.toLowerCase()) ||
    (merger.id !== undefined && lead.gitlabUserId === merger.id),
  );
  if (mergingLead) return { ...audit, status: 'lead_override', mergerUsername: mergingLead.gitlabUsername };

  // Merge is the last chance to recover a missed comment, even with a fresh cache.
  Object.assign(mr, await loadReviewCommentHistory(mr, { mergeAudit: true }));
  if (!approvalsVerified) return audit;
  const [reviewers, users] = await Promise.all([listActiveReviewers(), listActiveUsernames()]);
  const summary = summarizeMergeRequestApprovals(mr,
    new Set(leads.map((lead) => lead.gitlabUsername)), new Set(reviewers), new Set(users));
  if (!summary.developerApprovers.length) audit.missingApprovals.push('нет апрува назначенного ревьюера');
  if (summary.pendingLeadUsernames.length) {
    audit.missingApprovals.push(`нет апрувов лидов: ${summary.pendingLeadUsernames.join(', ')}`);
  } else if (summary.leadApprovers.length < summary.requiredLeadCount) {
    audit.missingApprovals.push('недостаточно апрувов лидов');
  }
  if (summary.pendingCommenterUsernames.length) {
    audit.missingApprovals.push(`нет апрувов комментаторов: ${summary.pendingCommenterUsernames.join(', ')}`);
  }
  if (audit.missingApprovals.length) audit.status = 'missing_approvals';
  else if (hasRequiredMergeApprovals(summary)) audit.status = 'approved';
  return audit;
};
