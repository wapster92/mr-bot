import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { escapeHtml, formatGitlabUserLabel } from '../messages/format';
import { listActiveReviewers, listActiveUsernames, listLeadUsers } from '../data/userStore';
import { summarizeMergeRequestApprovals } from './approvalPolicy';

export const buildMergeRequestMessages = async (
  mergeRequests: MergeRequestDocument[],
): Promise<string[]> => {
  const messages: string[] = [];
  const [leads, activeReviewers, users] = await Promise.all([listLeadUsers(), listActiveReviewers(), listActiveUsernames()]);
  const leadUsernames = new Set(leads.map((lead) => lead.gitlabUsername.toLowerCase()));
  const reviewerUsernames = new Set(activeReviewers.map((name) => name.toLowerCase()));
  const commenterUsernames = new Set(users.map((name) => name.toLowerCase()));

  for (const mr of mergeRequests) {
    const reviewers = mr.reviewers ?? [];
    const approvedBy = mr.approvedBy ?? [];
    const reviewerLabels = reviewers.length
      ? await Promise.all(reviewers.map((reviewer) => formatGitlabUserLabel(reviewer)))
      : [];
    const approvedLabels = approvedBy.length
      ? await Promise.all(approvedBy.map((approver) => formatGitlabUserLabel(approver)))
      : [];
    const approvedSet = new Set(approvedBy.map((name) => name.toLowerCase()));
    const pendingReviewers = reviewers.filter((reviewer) => !approvedSet.has(reviewer.toLowerCase()));
    const pendingLabels = pendingReviewers.length
      ? await Promise.all(pendingReviewers.map((reviewer) => formatGitlabUserLabel(reviewer)))
      : [];
    const reviewerNames = reviewerLabels.length ? reviewerLabels.join(', ') : 'не назначены';

    const authorLabel = await formatGitlabUserLabel(
      mr.author.gitlabUsername,
      mr.author.name,
    );

    const summary = summarizeMergeRequestApprovals(mr, leadUsernames, reviewerUsernames, commenterUsernames);
    const approvalsLine = `Апрувы: ревьюер ${Math.min(summary.developerApprovers.length, 1)}/1, ` +
      `лиды ${summary.leadApprovers.length}/${summary.requiredLeadCount}`;
    const pendingLeadLabels = await Promise.all(
      summary.pendingLeadUsernames.map((username) => formatGitlabUserLabel(username)),
    );
    const pendingCommenterLabels = await Promise.all(
      summary.pendingCommenterUsernames.map((username) => formatGitlabUserLabel(username)),
    );
    const approvedLine = approvedLabels.length
      ? `Апрувнули: ${approvedLabels.join(', ')}`
      : 'Апрувнули: —';
    const pendingLine = pendingLabels.length
      ? `Ревьюеры без апрува: ${pendingLabels.join(', ')}`
      : reviewers.length
      ? 'Ревьюеры без апрува: —'
      : 'Ревьюеры без апрува: нет данных';
    const parts = [
      `#${mr.iid}: ${escapeHtml(mr.title ?? '—')}`,
      `Автор: ${authorLabel}`,
      approvalsLine,
      approvedLine,
      pendingLine,
      `Лиды без апрува: ${pendingLeadLabels.join(', ') || '—'}`,
      ...(summary.requiredCommenterUsernames.length
        ? [`Комментаторы без обязательного апрува: ${pendingCommenterLabels.join(', ') || '—'}`] : []),
      ...(!summary.commentHistoryReady ? ['История комментариев ещё сверяется: готовность не подтверждена.'] : []),
      `Ревьюеры: ${reviewerNames}`,
      `Линт: ${escapeHtml(mr.lastLintStatus ?? 'не запускался')}`,
      escapeHtml(mr.url),
    ];
    if (mr.taskUrl) {
      parts.push(`Задача: ${escapeHtml(mr.taskUrl)}`);
    }
    messages.push(parts.filter(Boolean).join('\n'));
  }

  return messages;
};
