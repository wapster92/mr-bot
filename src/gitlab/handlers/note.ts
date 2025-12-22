import { findMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import { buildMergeRequestCommentMessage } from '../../messages/templates';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../../messages/send';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../../messages/recipients';

export const handleNoteEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  await persistGitlabUserProfileFromPayload(payload);
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

  const authorRecipient = await getRecipientByGitlabUsername(authorGitlab);
  if (!authorRecipient) {
    console.warn('[note] No Telegram mapping for MR author', authorGitlab);
    return;
  }

  const noteText = payload.object_attributes?.note ?? '';
  const commenterName = payload.user?.name ?? commenter ?? 'Ревьюер';

  const message = buildMergeRequestCommentMessage({
    title: doc.title ?? '—',
    url: doc.url ?? '—',
    taskUrl: doc.taskUrl,
    commenterName,
    noteText,
  });
  await deliverHtmlMessage(bot, authorRecipient, message);
  await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message);
};
