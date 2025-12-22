import { findMergeRequestByBranch } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import { buildPushUpdateMessage } from '../../messages/templates';
import { deliverHtmlMessage } from '../../messages/send';
import { getRecipientByGitlabUsername } from '../../messages/recipients';

const normalizeRef = (ref?: string): string | undefined => {
  if (!ref) {
    return undefined;
  }
  return ref.replace('refs/heads/', '');
};

export const handlePushEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  await persistGitlabUserProfileFromPayload(payload);
  const branch = normalizeRef(payload.ref);
  if (!branch) {
    return;
  }

  const projectPath = payload.project?.path_with_namespace;
  if (!projectPath) {
    return;
  }

  const doc = await findMergeRequestByBranch(projectPath, branch);
  if (!doc || ['merged', 'closed'].includes(doc.state ?? '')) {
    return;
  }

  if (!doc.reviewers?.length) {
    return;
  }

  for (const reviewer of doc.reviewers) {
    const reviewerRecipient = await getRecipientByGitlabUsername(reviewer);
    if (!reviewerRecipient) {
      continue;
    }

    const message = buildPushUpdateMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessage(bot, reviewerRecipient, message);
  }
};
