import { findMergeRequest, updateMergeRequest } from '../../data/mergeRequestRepository';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../bot';
import { persistGitlabUserProfileFromPayload, persistGitlabUserProfiles } from './common';
import {
  buildLintFailedMessage,
  buildLintPassedLeadMessage,
  buildLintPassedMessage,
} from '../../messages/templates';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../../messages/send';
import { getLeadRecipients, getRecipientByGitlabUsername } from '../../messages/recipients';
import { fetchMergeRequest, fetchUserByUsername, setMergeRequestReviewers } from '../api';
import { pullReviewers } from '../../data/reviewerQueue';
import {
  getGitlabUserIdByUsername,
  listLeadUsers,
  upsertGitlabUserProfile,
} from '../../data/userStore';

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

  await updateMergeRequest(projectId, iid, { lastLintStatus: status });

  const doc = await findMergeRequest(projectId, iid);
  if (!doc) {
    console.warn(`[pipeline] Merge request ${projectId}/${iid} not found`);
    return;
  }

  const apiMergeRequest = await fetchMergeRequest(projectId, iid);
  if (apiMergeRequest?.reviewers) {
    await persistGitlabUserProfiles(apiMergeRequest.reviewers);
  }

  let reviewers = doc.reviewers ?? [];
  if (apiMergeRequest) {
    const apiReviewerUsernames =
      apiMergeRequest.reviewers
        ?.map((reviewer) => reviewer.username)
        .filter((username): username is string => Boolean(username)) ?? [];
    reviewers = apiReviewerUsernames;
    await updateMergeRequest(projectId, iid, { reviewers });
  }

  if (status === 'failed' || status === 'canceled') {
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

  if (status === 'success') {
    if (!reviewers.length && apiMergeRequest) {
      const authorUsername = doc.author.gitlabUsername;
      const baseReviewers = await pullReviewers(
        authorUsername ? [authorUsername] : [],
      );
      const leads = await listLeadUsers();
      const leadUsername = leads.find((lead) => lead.gitlabUsername)?.gitlabUsername;
      const assignedReviewers = [...baseReviewers];
      if (
        leadUsername &&
        leadUsername !== authorUsername &&
        !assignedReviewers.some(
          (reviewer) => reviewer.toLowerCase() === leadUsername.toLowerCase(),
        )
      ) {
        assignedReviewers.push(leadUsername);
      }

      if (assignedReviewers.length) {
        await updateMergeRequest(projectId, iid, { reviewers: assignedReviewers });
        const reviewerIds: number[] = [];
        const missingIds: string[] = [];

        for (const username of assignedReviewers) {
          const storedId = await getGitlabUserIdByUsername(username);
          if (storedId) {
            reviewerIds.push(storedId);
            continue;
          }
          const apiUser = await fetchUserByUsername(username);
          if (apiUser?.id) {
            reviewerIds.push(apiUser.id);
            if (apiUser.username) {
              await upsertGitlabUserProfile(apiUser.username, apiUser.name, apiUser.id);
            }
            continue;
          }
          missingIds.push(username);
        }

        if (missingIds.length) {
          console.warn('[pipeline] Cannot resolve GitLab IDs for reviewers', missingIds.join(', '));
        } else {
          const assigned = await setMergeRequestReviewers(projectId, iid, reviewerIds);
          if (!assigned) {
            console.warn('[pipeline] Failed to assign reviewers via GitLab API', projectId, iid);
          }
        }

        reviewers = assignedReviewers;
      }
    }

    if (!reviewers.length) {
      console.warn('[pipeline] No reviewers assigned for MR', doc.iid);
      return;
    }

    const leadsMessage = buildLintPassedLeadMessage({
      title: doc.title ?? '—',
      url: doc.url ?? '—',
      taskUrl: doc.taskUrl,
    });
    await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), leadsMessage, {
      eventType: 'lint_passed_lead',
      projectId,
      mrIid: iid,
    });

    for (const reviewer of reviewers) {
      const reviewerRecipient = await getRecipientByGitlabUsername(reviewer);
      if (!reviewerRecipient) {
        console.warn(`[pipeline] Cannot notify reviewer ${reviewer}: no Telegram mapping`);
        continue;
      }
      const message = buildLintPassedMessage({
        title: doc.title ?? '—',
        url: doc.url ?? '—',
        taskUrl: doc.taskUrl,
      });
      await deliverHtmlMessage(bot, reviewerRecipient, message, {
        eventType: 'lint_passed_reviewer',
        projectId,
        mrIid: iid,
      });
    }
  }
};
