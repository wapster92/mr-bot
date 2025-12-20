import { Request, Response } from 'express';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { config } from '../config';
import { persistGitLabEvent } from './eventStore';
import { handleMergeRequestEvent } from './handlers/mergeRequest';
import { handlePipelineEvent } from './handlers/pipeline';
import { handleNoteEvent } from './handlers/note';
import { handlePushEvent } from './handlers/push';

const GITLAB_TOKEN_HEADER = 'x-gitlab-token';
const GITLAB_EVENT_HEADER = 'x-gitlab-event';

export const createGitLabWebhookHandler =
  (bot: Telegraf<BotContext>) =>
  (req: Request, res: Response): void => {
    const providedToken = req.header(GITLAB_TOKEN_HEADER);
    if (config.gitlab.token && providedToken !== config.gitlab.token) {
      res.status(401).json({ status: 'error', message: 'Invalid GitLab token' });
      return;
    }

    const payload = req.body ?? {};

    const eventType = req.header(GITLAB_EVENT_HEADER) ?? payload?.object_kind ?? 'unknown';
    const projectName = payload?.project?.path_with_namespace ?? 'unknown project';
    console.log(`[gitlab] event=${eventType} project=${projectName}`);

    if (config.logGitlabEvents) {
      persistGitLabEvent(eventType, payload).catch((error) => {
        console.error('Failed to persist GitLab event', error);
      });
    }

    if (payload?.object_kind === 'merge_request') {
      void handleMergeRequestEvent(payload, bot).catch((error) => {
        console.error('Failed to process merge request event', error);
      });
    } else if (payload?.object_kind === 'pipeline') {
      void handlePipelineEvent(payload, bot).catch((error) => {
        console.error('Failed to process pipeline event', error);
      });
    } else if (payload?.object_kind === 'note') {
      void handleNoteEvent(payload, bot).catch((error) => {
        console.error('Failed to process note event', error);
      });
    } else if (payload?.object_kind === 'push') {
      void handlePushEvent(payload, bot).catch((error) => {
        console.error('Failed to process push event', error);
      });
    }

    res.json({ status: 'ok' });
  };
