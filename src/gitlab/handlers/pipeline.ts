import { findMergeRequest, updateMergeRequest } from '../../data/mergeRequestRepository';
import { getChatIdByUsername, getUserByGitlabUsername } from '../../data/userStore';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';

const isLintPipeline = (payload: any): boolean => {
  const attrs = payload.object_attributes ?? {};
  const stages = (attrs.stages ?? []).map((stage: string) => stage?.toLowerCase());
  if (stages.includes('lint')) {
    return true;
  }

  const builds = payload.builds ?? [];
  return builds.some((build: any) => (build?.name ?? '').toLowerCase().includes('lint'));
};

const getMergeRequestInfo = (payload: any): { projectId?: number; iid?: number } => {
  const attrs = payload.object_attributes ?? {};
  const mergeRequest = attrs.merge_request ?? {};
  return {
    projectId: mergeRequest.target_project_id ?? mergeRequest.source_project_id,
    iid: mergeRequest.iid,
  };
};

export const handlePipelineEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const attrs = payload.object_attributes ?? {};
  if (attrs.source !== 'merge_request_event') {
    return;
  }

  if (!isLintPipeline(payload)) {
    return;
  }

  const status = attrs.status;
  const { projectId, iid } = getMergeRequestInfo(payload);
  if (!projectId || !iid) {
    return;
  }

  await updateMergeRequest(projectId, iid, { lastLintStatus: status });

  const doc = await findMergeRequest(projectId, iid);
  if (!doc) {
    console.warn(`[pipeline] Merge request ${projectId}/${iid} not found`);
    return;
  }

  if (status === 'failed' || status === 'canceled') {
    const authorUsername = doc.author.gitlabUsername;
    if (!authorUsername) {
      console.warn('[pipeline] MR author not set');
      return;
    }

    const userRecord = getUserByGitlabUsername(authorUsername);
    if (!userRecord?.telegramUsername) {
      console.warn(`[pipeline] Cannot notify MR author: ${authorUsername} not mapped to Telegram`);
      return;
    }
    const chatId = await getChatIdByUsername(userRecord.telegramUsername);
    if (!chatId) {
      console.warn(`[pipeline] Chat ID not found for ${userRecord.telegramUsername}`);
      return;
    }

    const parts = [
      `🚫 Линт упал в MR "${doc.title}". Проверь пайплайн и исправь ошибки.`,
      doc.url,
    ];
    if (doc.taskUrl) {
      parts.push(`Задача: ${doc.taskUrl}`);
    }

    await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
    return;
  }

  if (status === 'success') {
    const reviewers = doc.reviewers ?? [];
    if (!reviewers.length) {
      console.warn('[pipeline] No reviewers assigned for MR', doc.iid);
      return;
    }

    for (const reviewer of reviewers) {
      const userRecord = getUserByGitlabUsername(reviewer);
      if (!userRecord?.telegramUsername) {
        console.warn(`[pipeline] Cannot notify reviewer ${reviewer}: no Telegram mapping`);
        continue;
      }
      const chatId = await getChatIdByUsername(userRecord.telegramUsername);
      if (!chatId) {
        console.warn(`[pipeline] Chat ID not found for ${userRecord.telegramUsername}`);
        continue;
      }

      const parts = [
        `✅ MR "${doc.title}" прошёл линт. Пора провести ревью.`,
        doc.url,
      ];
      if (doc.taskUrl) {
        parts.push(`Задача: ${doc.taskUrl}`);
      }
      await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
    }
  }
};
