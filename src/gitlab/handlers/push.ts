import {
  clearMergeRequestGameReady,
  findMergeRequestByBranch,
  updateMergeRequest,
  type MergeRequestDocument,
} from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import { buildPushUpdateMessage } from '../../messages/templates';
import { deliverHtmlMessageToRecipients } from '../../messages/send';
import { getRecipientByGitlabUsername, type DeliveryRecipient } from '../../messages/recipients';
import { recordAuthorChangesScore, runGameAction } from '../../services/gameScoring';
import { withMergeRequestLock } from '../../services/mergeRequestLock';
import { getUserByGitlabUsername } from '../../data/userStore';
import { fetchMergeRequest, fetchMergeRequestApprovals, fetchMergeRequestNotes } from '../api';
import { shouldNotifyReviewUpdate } from '../../services/pushReviewNotifications';

const normalizeRef = (ref?: string): string | undefined => {
  if (!ref) {
    return undefined;
  }
  return ref.replace('refs/heads/', '');
};

const parseDate = (value?: string): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const handlePushEventUnlocked = async (
  payload: any,
  bot: Telegraf<BotContext>,
  projectPath: string,
  branch: string,
): Promise<void> => {
  const doc = await findMergeRequestByBranch(projectPath, branch);
  if (!doc || ['merged', 'closed'].includes(doc.state ?? '')) {
    return;
  }

  const commitSha = payload.after ?? payload.checkout_sha;
  if (typeof commitSha !== 'string' || !commitSha) return;
  const isBranchDeletion =
    typeof commitSha === 'string' && /^0+$/.test(commitSha);
  if (isBranchDeletion || payload.total_commits_count === 0) return;

  const [apiMr, approvals, notes] = await Promise.all([
    fetchMergeRequest(doc.projectId, doc.iid),
    fetchMergeRequestApprovals(doc.projectId, doc.iid),
    doc.reviewCommentsSyncedAt ? undefined : fetchMergeRequestNotes(doc.projectId, doc.iid),
  ]);
  const update: Partial<MergeRequestDocument> = { lastLintStatus: 'pending' };
  if (apiMr?.state !== undefined) update.state = apiMr.state;
  if (apiMr) {
    update.isDraft = Boolean(apiMr.draft || apiMr.work_in_progress || /^draft[: ]/i.test(apiMr.title ?? doc.title));
  }
  if (approvals && Array.isArray(approvals.approved_by)) {
    update.approvedBy = approvals.approved_by
      .map((item) => item.user?.username)
      .filter((name): name is string => Boolean(name));
  }
  if (notes) {
    update.reviewCommenters = [...new Set([
      ...(doc.reviewCommenters ?? []),
      ...notes.filter((note) => !note.system && note.authorUsername)
        .map((note) => note.authorUsername!),
    ].map((name) => name.toLowerCase()))];
    update.reviewCommentsSyncedAt = new Date();
  }
  const current = { ...doc, ...update };
  const pushedAt = parseDate(payload.event_created_at) ?? new Date();
  await updateMergeRequest(doc.projectId, doc.iid, update);
  await clearMergeRequestGameReady(doc.projectId, doc.iid);

  const actorUsername = payload.user_username ?? payload.user?.username;
  if (
    actorUsername &&
    doc.author.gitlabUsername?.toLowerCase() === actorUsername.toLowerCase()
  ) {
    await runGameAction(`author changes ${doc.projectId}/${doc.iid}`, () =>
      recordAuthorChangesScore({ mr: doc, pushedAt }),
    );
  }

  if (current.isDraft || ['closed', 'merged'].includes(current.state ?? '')) {
    return;
  }

  const dedupeId = `${branch}:${commitSha}`;

  const recipients: DeliveryRecipient[] = [];
  for (const username of new Set(current.reviewCommenters ?? [])) {
    const user = await getUserByGitlabUsername(username);
    if (!user || !shouldNotifyReviewUpdate(current, user)) continue;
    const recipient = await getRecipientByGitlabUsername(username);
    if (recipient) recipients.push(recipient);
  }
  await deliverHtmlMessageToRecipients(bot, recipients, buildPushUpdateMessage(current), {
    eventType: 'mr_push',
    projectId: doc.projectId,
    mrIid: doc.iid,
    dedupeId,
  });
};

export const handlePushEvent = async (
  payload: any,
  bot: Telegraf<BotContext>,
): Promise<void> => {
  await persistGitlabUserProfileFromPayload(payload);
  const branch = normalizeRef(payload.ref);
  const projectPath = payload.project?.path_with_namespace;
  if (!branch || !projectPath) {
    return;
  }

  const doc = await findMergeRequestByBranch(projectPath, branch);
  if (!doc || ['merged', 'closed'].includes(doc.state ?? '')) {
    return;
  }
  await withMergeRequestLock(doc.projectId, doc.iid, () =>
    handlePushEventUnlocked(payload, bot, projectPath, branch),
  );
};
