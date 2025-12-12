import { findMergeRequestByBranch } from '../../data/mergeRequestRepository';
import { getChatIdByUsername, getUserByGitlabUsername } from '../../data/userStore';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';

const normalizeRef = (ref?: string): string | undefined => {
  if (!ref) {
    return undefined;
  }
  return ref.replace('refs/heads/', '');
};

export const handlePushEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const branch = normalizeRef(payload.ref);
  if (!branch) {
    return;
  }

  const projectPath = payload.project?.path_with_namespace;
  if (!projectPath) {
    return;
  }

  const doc = await findMergeRequestByBranch(projectPath, branch);
  if (!doc || !doc.reviewers?.length) {
    return;
  }

  for (const reviewer of doc.reviewers) {
    const userRecord = getUserByGitlabUsername(reviewer);
    if (!userRecord?.telegramUsername) {
      continue;
    }
    const chatId = await getChatIdByUsername(userRecord.telegramUsername);
    if (!chatId) {
      continue;
    }

    const parts = [
      `✏️ В MR "${doc.title}" появились новые коммиты. Проверь обновления.`,
      doc.url,
    ];
    if (doc.taskUrl) {
      parts.push(`Задача: ${doc.taskUrl}`);
    }

    await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
  }
};
