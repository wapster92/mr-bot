import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import type { UserRecord } from '../data/userTypes';
import { isReviewerEnabled } from '../data/userTypes';
import {
  hasRequiredMergeApprovals,
  summarizeMergeRequestApprovals,
} from './approvalPolicy';
import { addWorkingMinutes, getWorkdayMinutes } from './workingHours';

export type ReviewLabel = { name: string; color: string };
export type ReviewUrgency = 'normal' | 'warning' | 'danger';

export const MERGE_READY_LABEL: ReviewLabel = {
  name: 'Можно сливать',
  color: '#2da44e',
};

const URGENCY_COLORS: Record<ReviewUrgency, string> = {
  normal: '#428bca',
  warning: '#ed9121',
  danger: '#d9534f',
};

export const getReviewUrgency = (
  user: UserRecord,
  requestedAt: Date | undefined,
  now: Date,
): ReviewUrgency => {
  if (!requestedAt) return 'normal';
  const workdayMinutes = getWorkdayMinutes(user);
  if (now >= addWorkingMinutes(user, requestedAt, workdayMinutes * 2)) return 'danger';
  if (now >= addWorkingMinutes(user, requestedAt, workdayMinutes)) return 'warning';
  return 'normal';
};

export const buildPersonalReviewLabel = (
  user: UserRecord,
  displayName: string,
  urgency: ReviewUrgency,
): ReviewLabel => {
  const prefix = urgency === 'warning' ? '⚠️ ' : urgency === 'danger' ? '🚨 ' : '';
  // Labels are sent as a comma-separated list to GitLab.
  const name = displayName.replace(/,/g, ' ').trim() || user.gitlabUsername;
  return {
    name: `${prefix}${name}`,
    color: URGENCY_COLORS[urgency],
  };
};

export const buildReviewLabelPlan = (
  mr: MergeRequestDocument,
  users: UserRecord[],
  now = new Date(),
): { labels: ReviewLabel[]; approvalRequestedAt: Record<string, Date> } => {
  if (mr.isDraft || ['closed', 'merged'].includes(mr.state ?? '')) {
    return { labels: [], approvalRequestedAt: {} };
  }
  const available = [...new Map(users
    .filter((user) => user.isActive !== false && user.isAllowed !== false)
    .map((user) => [user.gitlabUsername.toLowerCase(), user])).values()];
  const leads = available.filter((user) => user.isLead);
  const reviewers = available.filter(isReviewerEnabled);
  const summary = summarizeMergeRequestApprovals(
    mr,
    new Set(leads.map((user) => user.gitlabUsername.toLowerCase())),
    new Set(reviewers.map((user) => user.gitlabUsername.toLowerCase())),
    new Set(available.map((user) => user.gitlabUsername.toLowerCase())),
  );
  if (hasRequiredMergeApprovals(summary)) {
    return { labels: [MERGE_READY_LABEL], approvalRequestedAt: {} };
  }
  const approvers = new Set((mr.approvedBy ?? []).map((name) => name.toLowerCase()));
  const assigned = new Set((mr.reviewers ?? []).map((name) => name.toLowerCase()));
  const pendingLeads = new Set(summary.pendingLeadUsernames);
  const pendingCommenters = new Set(summary.pendingCommenterUsernames);
  const pending = available.filter((user) => {
    const username = user.gitlabUsername.toLowerCase();
    return !approvers.has(username) &&
      (pendingCommenters.has(username) ||
        (user.isLead ? pendingLeads.has(username) : isReviewerEnabled(user) && assigned.has(username)));
  });
  const approvalRequestedAt: Record<string, Date> = {};
  const labels = pending.map((user): ReviewLabel => {
    const username = user.gitlabUsername.toLowerCase();
    const trackingEnabled = !user.isLead || summary.developerApprovers.length > 0;
    const requestedAt = trackingEnabled
      ? mr.approvalRequestedAt?.[username] ?? now
      : undefined;
    if (requestedAt) approvalRequestedAt[username] = requestedAt;
    return buildPersonalReviewLabel(
      user,
      user.name ?? user.gitlabUsername,
      getReviewUrgency(user, requestedAt, now),
    );
  });
  return { labels, approvalRequestedAt };
};
