import { findMergeRequest, updateMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import {
  buildLintFailedMessage,
  buildLintPassedMessage,
} from '../../messages/templates';
import { deliverHtmlMessage } from '../../messages/send';
import { getRecipientByGitlabUsername } from '../../messages/recipients';
import { fetchPipelineJobs } from '../api';
import { recordLintFirstPassScore, runGameAction } from '../../services/gameScoring';
import { syncMergeRequestGameReadiness } from '../../services/mergeReadiness';
import { withMergeRequestLock } from '../../services/mergeRequestLock';

const parseDate = (value?: string): Date => {
  if (!value) {
    return new Date();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

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
  const mergeRequest = payload.merge_request ?? attrs.merge_request ?? {};
  return {
    projectId: mergeRequest.target_project_id ?? mergeRequest.source_project_id,
    iid: mergeRequest.iid,
  };
};

const handlePipelineEventUnlocked = async (
  payload: any,
  bot: Telegraf<BotContext>,
): Promise<void> => {
  await persistGitlabUserProfileFromPayload(payload);
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

  let lintStatus = status;
  const pipelineId = attrs.id;
  if (typeof pipelineId === 'number') {
    const jobs = await fetchPipelineJobs(projectId, pipelineId);
    const lintJobs = (jobs ?? []).filter((job) =>
      ((job.stage ?? '').toLowerCase().includes('lint') ||
        (job.name ?? '').toLowerCase().includes('lint')),
    );
    if (lintJobs.length) {
      // Prefer failed/canceled over success, then default to first status.
      if (lintJobs.some((job) => job.status === 'failed')) {
        lintStatus = 'failed';
      } else if (lintJobs.some((job) => job.status === 'canceled')) {
        lintStatus = 'canceled';
      } else if (lintJobs.every((job) => job.status === 'success')) {
        lintStatus = 'success';
      } else {
        lintStatus = lintJobs[0]?.status ?? status;
      }
    }
  }
  const dedupeId =
    typeof pipelineId === 'number' || typeof pipelineId === 'string'
      ? `${pipelineId}:${String(lintStatus)}`
      : undefined;

  const doc = await findMergeRequest(projectId, iid);
  if (!doc) {
    console.warn(`[pipeline] Merge request ${projectId}/${iid} not found`);
    return;
  }
  const occurredAt = parseDate(attrs.finished_at ?? attrs.updated_at);
  const terminalLint = ['failed', 'canceled', 'success'].includes(lintStatus);
  const lintUpdate: Parameters<typeof updateMergeRequest>[2] = {
    lastLintStatus: lintStatus,
  };
  if (terminalLint && doc.gameStartedAt && !doc.gameLintFirstPassEvaluated) {
    if (lintStatus === 'success' && !doc.gameLintFailed) {
      await runGameAction(`first lint ${projectId}/${iid}`, () =>
        recordLintFirstPassScore(doc, occurredAt),
      );
    }
    lintUpdate.gameLintFirstPassEvaluated = true;
  }
  if (lintStatus === 'failed' || lintStatus === 'canceled') {
    lintUpdate.gameLintFailed = true;
  }
  await updateMergeRequest(projectId, iid, lintUpdate);
  await runGameAction(`readiness after lint ${projectId}/${iid}`, async () => {
    await syncMergeRequestGameReadiness(projectId, iid, occurredAt);
  });

  const reviewers = doc.reviewers ?? [];

  if (lintStatus === 'failed' || lintStatus === 'canceled') {
    const authorUsername = doc.author.gitlabUsername;
    if (!authorUsername) {
      console.warn('[pipeline] MR author not set');
      return;
    }

    const authorRecipient = await getRecipientByGitlabUsername(authorUsername);
    if (!authorRecipient) {
      console.warn(`[pipeline] Cannot notify MR author: ${authorUsername} not mapped to Telegram`);
      return;
    }

    const message = buildLintFailedMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessage(bot, authorRecipient, message, {
      eventType: 'lint_failed',
      projectId,
      mrIid: iid,
      ...(dedupeId ? { dedupeId } : {}),
    });
    return;
  }

  if (lintStatus === 'success') {
    if (!reviewers.length) {
      console.warn('[pipeline] No reviewers assigned for MR', doc.iid);
      return;
    }

    const authorUsername = doc.author.gitlabUsername;
    if (!authorUsername) {
      console.warn('[pipeline] MR author not set for lint success');
      return;
    }
    const authorRecipient = await getRecipientByGitlabUsername(authorUsername);
    if (!authorRecipient) {
      console.warn(`[pipeline] Cannot notify MR author on lint success: ${authorUsername} not mapped`);
      return;
    }
    const message = buildLintPassedMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessage(bot, authorRecipient, message, {
      eventType: 'lint_passed_author',
      projectId,
      mrIid: iid,
      ...(dedupeId ? { dedupeId } : {}),
    });
  }
};

export const handlePipelineEvent = async (
  payload: any,
  bot: Telegraf<BotContext>,
): Promise<void> => {
  const { projectId, iid } = getMergeRequestInfo(payload);
  if (!projectId || !iid) {
    await handlePipelineEventUnlocked(payload, bot);
    return;
  }
  await withMergeRequestLock(projectId, iid, () =>
    handlePipelineEventUnlocked(payload, bot),
  );
};
