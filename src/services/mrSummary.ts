import type { MergeRequestDocument } from '../data/mergeRequestRepository';
import { escapeHtml, formatGitlabUserLabel } from '../messages/format';

export const buildMergeRequestMessages = async (
  mergeRequests: MergeRequestDocument[],
): Promise<string[]> => {
  const messages: string[] = [];

  for (const mr of mergeRequests) {
    const reviewers = mr.reviewers ?? [];
    const approvedBy = mr.approvedBy ?? [];
    const reviewerLabels = reviewers.length
      ? await Promise.all(reviewers.map((reviewer) => formatGitlabUserLabel(reviewer)))
      : [];
    const approvedLabels = approvedBy.length
      ? await Promise.all(approvedBy.map((approver) => formatGitlabUserLabel(approver)))
      : [];
    const pendingReviewers = reviewers.filter((reviewer) => !approvedBy.includes(reviewer));
    const pendingLabels = pendingReviewers.length
      ? await Promise.all(pendingReviewers.map((reviewer) => formatGitlabUserLabel(reviewer)))
      : [];
    const reviewerNames = reviewerLabels.length ? reviewerLabels.join(', ') : 'не назначены';

    const authorLabel = await formatGitlabUserLabel(
      mr.author.gitlabUsername,
      mr.author.name,
    );

    const approvalsRequired =
      typeof mr.approvalsRequired === 'number' ? mr.approvalsRequired : undefined;
    const approvalsLeft = typeof mr.approvalsLeft === 'number' ? mr.approvalsLeft : undefined;
    const approvalsGiven =
      approvalsRequired !== undefined && approvalsLeft !== undefined
        ? Math.max(approvalsRequired - approvalsLeft, 0)
        : undefined;
    const approvalsFromReviewers =
      approvalsRequired === undefined && approvalsLeft === undefined && reviewers.length
        ? `${Math.min(approvedBy.length, reviewers.length)}/${reviewers.length}`
        : undefined;
    const approvalsLine =
      approvalsRequired !== undefined && approvalsLeft !== undefined
        ? `Апрувы: ${approvalsGiven}/${approvalsRequired} (осталось ${Math.max(
            approvalsLeft,
            0,
          )})`
        : approvalsFromReviewers
        ? `Апрувы: ${approvalsFromReviewers}`
        : 'Апрувы: нет данных';
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
