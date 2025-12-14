import { config } from '../../config';
import {
  upsertMergeRequest,
  type MergeRequestDocument,
  findMergeRequest,
  updateMergeRequest,
} from '../../data/mergeRequestRepository';
import { getLeadUsers, getUserByGitlabUsername, getChatIdByUsername } from '../../data/userStore';
import { pullReviewers } from '../../data/reviewerQueue';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';

const ISSUE_KEY_REGEX = /([A-Z]+-\d+)/;

const extractTaskInfo = (sourceBranch?: string): { taskKey?: string; taskUrl?: string } => {
  if (!sourceBranch) {
    return {};
  }

  const match = sourceBranch.match(ISSUE_KEY_REGEX);
  const taskKey = match?.[1];
  if (!taskKey) {
    return {};
  }

  const result: { taskKey?: string; taskUrl?: string } = { taskKey };

  if (config.jira.baseUrl) {
    const base = config.jira.baseUrl.replace(/\/$/, '');
    result.taskUrl = `${base}/${taskKey}`;
  }

  return result;
};

const parseDate = (value?: string): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const isDraft = (attrs: any): boolean => {
  if (attrs.work_in_progress) {
    return true;
  }
  const title: string = attrs.title ?? '';
  return /^draft[: ]/i.test(title.trim());
};

export const handleMergeRequestEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const project = payload.project ?? {};
  const attrs = payload.object_attributes ?? {};
  const gitlabAuthorUsername =
    payload.object_attributes?.author?.username ?? payload.user?.username;
  const userRecord = getUserByGitlabUsername(gitlabAuthorUsername);
  const { taskKey, taskUrl } = extractTaskInfo(attrs.source_branch);
  const existingDoc = await findMergeRequest(project.id, attrs.iid);

  const author = {
    ...(gitlabAuthorUsername ? { gitlabUsername: gitlabAuthorUsername } : {}),
    ...(userRecord?.telegramUsername ? { telegramUsername: userRecord.telegramUsername } : {}),
    ...(payload.object_attributes?.author?.name
      ? { name: payload.object_attributes.author.name }
      : payload.user?.name
      ? { name: payload.user.name }
      : {}),
  };

  const doc: MergeRequestDocument = {
    projectId: project.id,
    projectPath: project.path_with_namespace,
    mrId: attrs.id,
    iid: attrs.iid,
    title: attrs.title,
    sourceBranch: attrs.source_branch,
    targetBranch: attrs.target_branch,
    url: attrs.url,
    author,
    action: attrs.action,
  };

  if (attrs.description) {
    doc.description = attrs.description;
  }
  if (attrs.state) {
    doc.state = attrs.state;
  }
  if (attrs.merge_status) {
    doc.mergeStatus = attrs.merge_status;
  }
  if (attrs.detailed_merge_status) {
    doc.detailedMergeStatus = attrs.detailed_merge_status;
  }

  if (typeof attrs.approvals_required === 'number') {
    doc.approvalsRequired = attrs.approvals_required;
  }
  if (typeof attrs.approvals_left === 'number') {
    doc.approvalsLeft = attrs.approvals_left;
  }
  if (taskKey) {
    doc.taskKey = taskKey;
  }
  if (taskUrl) {
    doc.taskUrl = taskUrl;
  }
  const createdAt = parseDate(attrs.created_at);
  if (createdAt) {
    doc.createdAt = createdAt;
  }
  const updatedAt = parseDate(attrs.updated_at);
  if (updatedAt) {
    doc.updatedAt = updatedAt;
  }

  if (attrs.action === 'open' && !isDraft(attrs)) {
    const reviewers = await pullReviewers([gitlabAuthorUsername ?? ''].filter(Boolean) as string[]);
    if (reviewers.length) {
      doc.reviewers = reviewers;
      const reviewerList = reviewers.join(', ');
      const parts = [
        `🆕 Создан MR "${doc.title}" от ${doc.author.name ?? doc.author.gitlabUsername ?? ''}.`,
        `Ревьюеры: ${reviewerList}`,
        doc.url,
      ];
      if (doc.taskUrl) {
        parts.push(`Задача: ${doc.taskUrl}`);
      }
      const leads = getLeadUsers();
      for (const lead of leads) {
        if (!lead.telegramUsername) continue;
        const chatId = await getChatIdByUsername(lead.telegramUsername);
        if (!chatId) continue;
        await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
      }
      if (doc.author.telegramUsername) {
        const authorChatId = await getChatIdByUsername(doc.author.telegramUsername);
        if (authorChatId) {
          await bot.telegram.sendMessage(authorChatId, parts.filter(Boolean).join('\n'));
        }
      }
    }
  }

  await upsertMergeRequest(doc);

  if (attrs.action === 'close' || attrs.action === 'merge') {
    const leads = getLeadUsers();
    const closerName = payload.user?.name ?? payload.user?.username ?? 'Кто-то';
    const originalAuthorName = doc.author.name ?? doc.author.gitlabUsername ?? '—';
    const actionText = attrs.action === 'merge' ? 'слит' : 'закрыт';
    const parts = [
      `ℹ️ MR "${doc.title}" был ${actionText}. Автор MR: ${originalAuthorName}. Действие выполнил: ${closerName}.`,
      doc.url,
    ];
    if (doc.taskUrl) {
      parts.push(`Задача: ${doc.taskUrl}`);
    }
    for (const lead of leads) {
      if (!lead.telegramUsername) continue;
      const chatId = await getChatIdByUsername(lead.telegramUsername);
      if (!chatId) continue;
      await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
    }
    if (doc.author.telegramUsername) {
      const authorChatId = await getChatIdByUsername(doc.author.telegramUsername);
      if (authorChatId) {
        await bot.telegram.sendMessage(authorChatId, parts.filter(Boolean).join('\n'));
      }
    }
    return;
  }

  if (typeof attrs.approvals_left === 'number' && attrs.approvals_left === 0 && !existingDoc?.finalReviewNotified) {
    const leads = getLeadUsers();
    for (const lead of leads) {
      if (!lead.telegramUsername) {
        continue;
      }
      const chatId = await getChatIdByUsername(lead.telegramUsername);
      if (!chatId) {
        continue;
      }
      const parts = [
        `✅ MR "${doc.title}" набрал все апрувы. Проведи финальную проверку.`,
        doc.url,
      ];
      if (doc.taskUrl) {
        parts.push(`Задача: ${doc.taskUrl}`);
      }
      await bot.telegram.sendMessage(chatId, parts.filter(Boolean).join('\n'));
    }
    await updateMergeRequest(doc.projectId, doc.iid, { finalReviewNotified: true });
  }
};
