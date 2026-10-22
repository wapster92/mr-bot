import { clearMergeRequestGameReady, findMergeRequest, updateMergeRequest } from '../../data/mergeRequestRepository';
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
import { getUserByGitlabUsername } from '../../data/userStore';
import { withMergeRequestLock } from '../../services/mergeRequestLock';
import { syncMergeRequestFromGitlab } from '../../services/mergeRequestSync';
import { recordReviewCommentActivity } from '../../services/reviewResponsibility';

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

const handleNoteEventUnlocked = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
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
  const noteAttributes = payload.object_attributes ?? {};
  const isNewHumanComment =
    !noteAttributes.system && (!noteAttributes.action || noteAttributes.action === 'create');
  if (commenter && commenter.toLowerCase() === authorGitlab.toLowerCase()) {
    if (isNewHumanComment && !doc.isDraft && !['closed', 'merged'].includes(doc.state ?? '')) {
      const activity = recordReviewCommentActivity(doc, commenter, parseDate(noteAttributes.created_at));
      if (!Object.keys(activity).length) return;
      await updateMergeRequest(doc.projectId, doc.iid, activity);
      await syncMergeRequestFromGitlab(bot, doc.projectId, doc.iid, { lockHeld: true }).catch((error) => {
        console.warn(`[note] Failed to refresh responsibility ${doc.projectId}/${doc.iid}`, error);
      });
    }
    return;
  }
  const isAssignedReviewer = Boolean(
    commenter &&
      doc.reviewers?.some(
        (reviewer) => reviewer.toLowerCase() === commenter.toLowerCase(),
      ),
  );
  const commenterUser = commenter ? await getUserByGitlabUsername(commenter) : undefined;
  const noteId = noteAttributes.id;
  const discussionKey = noteAttributes.discussion_id ?? noteId;
  const activeCommenter = commenterUser && commenterUser.isActive !== false && commenterUser.isAllowed !== false;
  if (commenter && activeCommenter && isNewHumanComment) {
    const username = commenter.toLowerCase();
    const activity = recordReviewCommentActivity(doc, commenter, parseDate(noteAttributes.created_at));
    if (!doc.reviewCommenters?.some((name) => name.toLowerCase() === username)) {
      activity.reviewCommenters = [...(doc.reviewCommenters ?? []), username];
    }
    if (Object.keys(activity).length) await updateMergeRequest(doc.projectId, doc.iid, activity);
    if (!doc.approvedBy?.some((name) => name.toLowerCase() === username)) {
      await clearMergeRequestGameReady(doc.projectId, doc.iid);
    }
  }
  if (
    commenter &&
    commenterUser && commenterUser.isActive !== false && commenterUser.isAllowed !== false &&
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
  if (commenter && isAssignedReviewer && activeCommenter && isNewHumanComment) {
    await markReviewCompletedForReviewer(
      { projectId: doc.projectId, iid: doc.iid },
      commenter,
    );
  }

  if (commenter && activeCommenter && isNewHumanComment) {
    await syncMergeRequestFromGitlab(bot, doc.projectId, doc.iid, { lockHeld: true }).catch((error) => {
      console.warn(`[note] Failed to refresh approval requirements ${doc.projectId}/${doc.iid}`, error);
    });
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

export const handleNoteEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
  const mr = payload.merge_request;
  const projectId = mr?.target_project_id ?? mr?.source_project_id;
  const iid = mr?.iid;
  if (payload.object_attributes?.noteable_type !== 'MergeRequest' ||
    typeof projectId !== 'number' || typeof iid !== 'number') return;
  await withMergeRequestLock(projectId, iid, () => handleNoteEventUnlocked(payload, bot));
};
