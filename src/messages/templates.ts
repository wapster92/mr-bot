import { escapeHtml } from './format';

type MergeRequestMessageInput = {
  title: string;
  url: string;
  taskUrl?: string | undefined;
};

const buildMrParts = (input: MergeRequestMessageInput, header: string): string[] => {
  const parts = [header, escapeHtml(input.url)];
  if (input.taskUrl) {
    parts.push(`Задача: ${escapeHtml(input.taskUrl)}`);
  }
  return parts;
};

export const buildMergeRequestCreatedMessage = (
  input: MergeRequestMessageInput & {
    authorLabel: string;
    reviewerList: string;
  },
): string => {
  const header = `🆕 Создан MR "${escapeHtml(input.title)}" от ${input.authorLabel}.`;
  const parts = buildMrParts(input, header);
  parts.splice(1, 0, `Ревьюеры: ${input.reviewerList}`);
  return parts.filter(Boolean).join('\n');
};

export const buildMergeRequestClosedMessage = (
  input: MergeRequestMessageInput & {
    actionText: string;
    authorLabel: string;
    closerLabel: string;
  },
): string => {
  const header = `ℹ️ MR "${escapeHtml(input.title)}" был ${input.actionText}. Автор MR: ${input.authorLabel}. Действие выполнил: ${input.closerLabel}.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildFinalReviewMessage = (input: MergeRequestMessageInput): string => {
  const header = `✅ MR "${escapeHtml(input.title)}" набрал все апрувы. Проведи финальную проверку.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildLintFailedMessage = (input: MergeRequestMessageInput): string => {
  const header = `🚫 Линт упал в MR "${escapeHtml(input.title)}". Проверь пайплайн и исправь ошибки.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildLintPassedMessage = (input: MergeRequestMessageInput): string => {
  const header = `✅ MR "${escapeHtml(input.title)}" прошёл линт. Пора провести ревью.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildLintPassedLeadMessage = (input: MergeRequestMessageInput): string => {
  const header = `ℹ️ MR "${escapeHtml(input.title)}" прошёл линт.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildPushUpdateMessage = (input: MergeRequestMessageInput): string => {
  const header = `✏️ В MR "${escapeHtml(input.title)}" появились новые коммиты. Проверь обновления.`;
  const parts = buildMrParts(input, header);
  return parts.filter(Boolean).join('\n');
};

export const buildMergeRequestCommentMessage = (
  input: MergeRequestMessageInput & {
    commenterName: string;
    noteText: string;
  },
): string => {
  const header = `💬 ${escapeHtml(input.commenterName)} оставил комментарий в MR "${escapeHtml(input.title)}":`;
  const parts = buildMrParts(input, header);
  parts.splice(1, 0, escapeHtml(input.noteText));
  return parts.filter(Boolean).join('\n');
};
