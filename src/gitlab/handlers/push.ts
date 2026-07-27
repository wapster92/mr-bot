import {
  clearMergeRequestGameReady,
  findMergeRequestByBranch,
  updateMergeRequest,
} from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import { buildPushUpdateMessage } from '../../messages/templates';
import { deliverHtmlMessage } from '../../messages/send';
import { getRecipientByGitlabUsername } from '../../messages/recipients';
import { recordAuthorChangesScore, runGameAction } from '../../services/gameScoring';
import { withMergeRequestLock } from '../../services/mergeRequestLock';

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
  const isBranchDeletion =
    typeof commitSha === 'string' && /^0+$/.test(commitSha);
  const pushedAt = parseDate(payload.event_created_at) ?? new Date();
  await updateMergeRequest(doc.projectId, doc.iid, { lastLintStatus: 'pending' });
  await clearMergeRequestGameReady(doc.projectId, doc.iid);

  const actorUsername = payload.user_username ?? payload.user?.username;
  if (
    !isBranchDeletion &&
    actorUsername &&
    doc.author.gitlabUsername?.toLowerCase() === actorUsername.toLowerCase()
  ) {
    await runGameAction(`author changes ${doc.projectId}/${doc.iid}`, () =>
      recordAuthorChangesScore({ mr: doc, pushedAt }),
    );
  }

  if (!doc.reviewers?.length) {
    return;
  }

  const dedupeId =
    typeof commitSha === 'string' && commitSha
      ? `${branch}:${commitSha}`
      : undefined;

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
    await deliverHtmlMessage(bot, reviewerRecipient, message, {
      eventType: 'mr_push',
      projectId: doc.projectId,
      mrIid: doc.iid,
      ...(dedupeId ? { dedupeId } : {}),
    });
  }
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
