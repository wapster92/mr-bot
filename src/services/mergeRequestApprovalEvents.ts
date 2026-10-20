import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import type { GitlabApprovals } from '../gitlab/api';
import { recordReviewApprovalScore, recordReviewUnapprovalScore, runGameAction } from './gameScoring';

type ApprovalState = Pick<MergeRequestDocument, 'approvedBy' | 'approvalsRequired' | 'approvalsLeft'>;

export type MergeRequestApprovalEvent = {
  action?: string | undefined;
  system?: boolean | undefined;
  actorUsername?: string | undefined;
  approvalsRequired?: number | undefined;
  approvalsLeft?: number | undefined;
};

const classifyEvent = (event: MergeRequestApprovalEvent): 'approval' | 'unapproval' | 'system_reset' | 'none' => {
  if (event.action === 'approval' || event.action === 'approved') return 'approval';
  if (event.action === 'unapproval' || event.action === 'unapproved') {
    return event.system === true ? 'system_reset' : 'unapproval';
  }
  return 'none';
};

// GitLab's counters are display data, not the bot's merge policy. Keep their
// legacy fallbacks separate from the required-reviewer/lead/commenter rules.
export const resolveMergeRequestApprovals = (
  previous: ApprovalState | null,
  api: GitlabApprovals | undefined,
  event: MergeRequestApprovalEvent,
  defaultRequired: number,
): ApprovalState => {
  const next: ApprovalState = {};
  if (previous?.approvedBy !== undefined) next.approvedBy = previous.approvedBy;
  if (previous?.approvalsRequired !== undefined) next.approvalsRequired = previous.approvalsRequired;
  if (previous?.approvalsLeft !== undefined) next.approvalsLeft = previous.approvalsLeft;
  if (api) {
    if (typeof api.approvals_required === 'number') next.approvalsRequired = api.approvals_required;
    if (typeof api.approvals_left === 'number') next.approvalsLeft = api.approvals_left;
    next.approvedBy = (Array.isArray(api.approved_by) ? api.approved_by : []).map((item) => item.user?.username)
      .filter((name): name is string => Boolean(name));
  } else {
    if (typeof event.approvalsRequired === 'number') next.approvalsRequired = event.approvalsRequired;
    if (typeof event.approvalsLeft === 'number') next.approvalsLeft = event.approvalsLeft;
  }
  if (next.approvalsRequired === undefined) {
    const required = previous?.approvalsRequired ?? defaultRequired;
    if (Number.isFinite(required)) next.approvalsRequired = required;
  }
  if (typeof next.approvalsLeft !== 'number') {
    const fallback = typeof event.approvalsLeft === 'number' ? event.approvalsLeft : previous?.approvalsLeft;
    if (typeof fallback === 'number') next.approvalsLeft = fallback;
    else if (typeof next.approvalsRequired === 'number') next.approvalsLeft = next.approvalsRequired;
    else next.approvalsLeft = defaultRequired;
  }
  if (next.approvalsLeft < 0) next.approvalsLeft = 0;
  if (typeof next.approvalsRequired === 'number' && next.approvalsRequired > 0 && next.approvalsLeft === 0) {
    next.approvalsLeft = Math.max(next.approvalsRequired - (next.approvedBy ?? []).length, 0);
  }

  // With no API response, only the explicit actor/reset can change the known
  // approve list. Preserve the order of the old counter and event processing.
  const kind = classifyEvent(event);
  if (!api && kind !== 'none') {
    if (kind === 'system_reset') next.approvedBy = [];
    else if (event.actorUsername) {
      const actor = event.actorUsername;
      const others = (previous?.approvedBy ?? []).filter(
        (name) => name.toLowerCase() !== actor.toLowerCase(),
      );
      next.approvedBy = kind === 'approval' ? [...others, actor] : others;
    }
  }
  return next;
};

// Invoke only after saving the MR, inside its lock. System resets reverse only
// approvals actually absent from a verified API snapshot, not from an outage.
export const recordMergeRequestApprovalEvent = async (
  mr: MergeRequestDocument,
  previous: MergeRequestDocument | null,
  event: MergeRequestApprovalEvent,
  apiAvailable: boolean,
  occurredAt?: Date,
): Promise<void> => {
  const kind = classifyEvent(event);
  if (kind === 'none') return;
  const approvedBy = mr.approvedBy ?? previous?.approvedBy;
  const scoreMr = { ...previous, ...mr, ...(approvedBy ? { approvedBy } : {}) };
  await runGameAction(`approval ${mr.projectId}/${mr.iid}`, async () => {
    if (kind === 'approval' && event.actorUsername) {
      await recordReviewApprovalScore({
        mr: scoreMr, username: event.actorUsername, occurredAt: occurredAt ?? new Date(),
      });
    } else if (kind === 'unapproval' && event.actorUsername) {
      await recordReviewUnapprovalScore({
        mr: scoreMr, username: event.actorUsername, occurredAt: occurredAt ?? new Date(),
      });
    } else if (kind === 'system_reset' && apiAvailable) {
      const approved = new Set((mr.approvedBy ?? []).map((name) => name.toLowerCase()));
      for (const username of previous?.approvedBy ?? []) {
        if (!approved.has(username.toLowerCase())) {
          await recordReviewUnapprovalScore({ mr: scoreMr, username, occurredAt: occurredAt ?? new Date() });
        }
      }
    }
  });
};
