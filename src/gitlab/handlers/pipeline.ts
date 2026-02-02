import { findMergeRequest, updateMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload } from './common';
import {
  buildLintFailedMessage,
  buildLintPassedLeadMessage,
  buildLintPassedMessage,
} from '../../messages/templates';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../../messages/send';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../../messages/recipients';
import { fetchPipelineJobs } from '../api';

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

export const handlePipelineEvent = async (payload: any, bot: Telegraf<BotContext>): Promise<void> => {
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

  await updateMergeRequest(projectId, iid, { lastLintStatus: lintStatus });

  const doc = await findMergeRequest(projectId, iid);
  if (!doc) {
    console.warn(`[pipeline] Merge request ${projectId}/${iid} not found`);
    return;
  }

  let reviewers = doc.reviewers ?? [];

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
    });
  }
};
