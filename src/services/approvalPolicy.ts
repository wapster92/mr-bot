export type ApprovalSummary = {
  leadApprovers: string[];
  developerApprovers: string[];
};

export const summarizeApprovals = (
  approvedBy: string[],
  leadUsernames: Set<string>,
): ApprovalSummary => {
  const normalizedLeads = new Set(
    [...leadUsernames].map((username) => username.toLowerCase()),
  );
  const uniqueApprovers = Array.from(
    new Set(approvedBy.map((username) => username.toLowerCase())),
  );
  return {
    leadApprovers: uniqueApprovers.filter((username) => normalizedLeads.has(username)),
    developerApprovers: uniqueApprovers.filter(
      (username) => !normalizedLeads.has(username),
    ),
  };
};

export const needsLeadReview = (summary: ApprovalSummary): boolean =>
  summary.developerApprovers.length >= 1 && summary.leadApprovers.length === 0;

export const hasRequiredMergeApprovals = (summary: ApprovalSummary): boolean =>
  summary.developerApprovers.length >= 1 && summary.leadApprovers.length >= 1;

export const hasLeadApproval = (summary: ApprovalSummary): boolean =>
  summary.leadApprovers.length >= 1;
