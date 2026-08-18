import { findMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import { buildMergeRequestCommentMessage } from '../../messages/templates';
import { deliverHtmlMessageToRecipients } from '../../messages/send';
import {
  getLeadRecipients,
  getRecipientByGitlabUsername,
  type DeliveryRecipient,
} from '../../messages/recipients';
import { markReviewCompletedForReviewer } from '../../services/reviewReminderService';
import { recordReviewCommentScore, runGameAction } from '../../services/gameScoring';

const parseDate = (value?: string): Date => {
  if (!value) {
    return new Date();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

export const buildCommentRecipients = (
  authorRecipient: DeliveryRecipient | undefined,
  leadRecipients: DeliveryRecipient[],
): DeliveryRecipient[] => [
  ...(authorRecipient ? [authorRecipient] : []),
  ...leadRecipients,
];

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
  const isAssignedReviewer = Boolean(
    commenter &&
      doc.reviewers?.some(
        (reviewer) => reviewer.toLowerCase() === commenter.toLowerCase(),
      ),
  );
  const noteAttributes = payload.object_attributes ?? {};
  const noteId = noteAttributes.id;
  const discussionKey = noteAttributes.discussion_id ?? noteId;
  const isNewHumanComment =
    !noteAttributes.system &&
    (!noteAttributes.action || noteAttributes.action === 'create');
  if (
    commenter &&
    isAssignedReviewer &&
    isNewHumanComment &&
    noteId !== undefined &&
    discussionKey !== undefined
  ) {
    await runGameAction(`review comment ${doc.projectId}/${doc.iid}`, () =>
      recordReviewCommentScore({
        mr: doc,
        reviewerUsername: commenter,
        noteId: String(noteId),
        discussionKey: String(discussionKey),
        occurredAt: parseDate(noteAttributes.created_at),
      }),
    );
  }
  if (commenter && isAssignedReviewer) {
    await markReviewCompletedForReviewer(
      { projectId: doc.projectId, iid: doc.iid },
      commenter,
    );
  }

  const authorRecipient = await getRecipientByGitlabUsername(authorGitlab);
  if (!authorRecipient) {
    console.warn('[note] No Telegram mapping for MR author', authorGitlab);
  }

  const noteText = noteAttributes.note ?? '';
  const commenterName = payload.user?.name ?? commenter ?? 'Ревьюер';

  const message = buildMergeRequestCommentMessage({
    title: doc.title ?? '—',
    url: doc.url ?? '—',
    taskUrl: doc.taskUrl,
    commenterName,
    noteText,
  });
  const recipients = buildCommentRecipients(
    authorRecipient,
    await getLeadRecipients(),
  );
  await deliverHtmlMessageToRecipients(bot, recipients, message, {
    eventType: 'mr_comment',
    projectId: doc.projectId,
    mrIid: doc.iid,
    ...(noteId ? { dedupeId: String(noteId) } : {}),
  });
};
