import { getChatIdByUsername, getUserByGitlabUsername } from '../../data/userStore';
import { findMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';

export const handleNoteEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  if (payload.object_attributes?.noteable_type !== 'MergeRequest') {
    return;
  }

  const mr = payload.merge_request;
  if (!mr) {
    return;
  }

  const doc = await findMergeRequest(mr.target_project_id ?? mr.source_project_id, mr.iid);
  if (!doc) {
    console.warn('[note] MR not found for comment', mr.iid);
    return;
  }

  const authorGitlab = doc.author.gitlabUsername;
  if (!authorGitlab) {
    return;
  }

  const commenter = payload.user?.username;
  if (commenter && commenter.toLowerCase() === authorGitlab.toLowerCase()) {
    return;
  }

  const userRecord = getUserByGitlabUsername(authorGitlab);
  if (!userRecord?.telegramUsername) {
    console.warn('[note] No Telegram mapping for MR author', authorGitlab);
    return;
  }

  const chatId = await getChatIdByUsername(userRecord.telegramUsername);
  if (!chatId) {
    console.warn('[note] Chat ID not found for', userRecord.telegramUsername);
    return;
  }

  const noteText = payload.object_attributes?.note ?? '';
  const commenterName = payload.user?.name ?? commenter ?? 'Ревьюер';

  const parts = [
    `💬 ${commenterName} оставил комментарий в MR "${doc.title}":`,
    noteText,
    doc.url,
  ];
  if (doc.taskUrl) {
    parts.push(`Задача: ${doc.taskUrl}`);
  }

  await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
};
