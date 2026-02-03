import type { Telegraf } from 'telegraf';
import type { BotContext } from '../bot';
import { findMergeRequest } from '../data/mergeRequestRepository';
import {
  incrementReminder,
  listPendingReviewReminders,
  markEscalated,
  markReminderInactive,
} from '../data/reviewReminderRepository';
import { getUserByGitlabUsername } from '../data/userStore';
import type { UserRecord } from '../data/userTypes';
import { formatGitlabUserLabel } from '../messages/format';
import { getLeadRecipients, isWithinWorkingHours, getRecipientByGitlabUsername } from '../messages/recipients';
import { deliverHtmlMessage, deliverHtmlMessageToRecipients } from '../messages/send';
import { buildReviewEscalationMessage, buildReviewReminderMessage } from '../messages/templates';

const REMINDER_STEP_MINUTES = 15;
const REMINDER_INTERVAL_MINUTES = 180;
const ESCALATION_DAYS = 2;
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

const parseTimeToMinutes = (value: string): number | null => {
  const [hoursText, minutesText] = value.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '18:00';
const DEFAULT_TIMEZONE = 'Europe/Moscow';

const isDraftTitle = (title?: string): boolean =>
  /^draft[: ]/i.test((title ?? '').trim());

const getWorkdayMinutes = (user: UserRecord): number => {
  if (user.ignoreWorkHours) {
    return 24 * 60;
  }
  const startText = user.workHours?.start ?? DEFAULT_WORK_START;
  const endText = user.workHours?.end ?? DEFAULT_WORK_END;
  const startMinutes = parseTimeToMinutes(startText) ?? parseTimeToMinutes(DEFAULT_WORK_START) ?? 540;
  const endMinutes = parseTimeToMinutes(endText) ?? parseTimeToMinutes(DEFAULT_WORK_END) ?? 1080;
  if (startMinutes === endMinutes) {
    return 24 * 60;
  }
  if (startMinutes < endMinutes) {
    return endMinutes - startMinutes;
  }
  return 24 * 60 - (startMinutes - endMinutes);
};

const addWorkingMinutes = (user: UserRecord, from: Date, minutes: number): Date => {
  if (minutes <= 0) {
    return from;
  }
  let remaining = minutes;
  let cursor = new Date(from.getTime());
  let guard = 0;
  const stepMs = REMINDER_STEP_MINUTES * 60 * 1000;

  while (remaining > 0 && guard < 10000) {
    cursor = new Date(cursor.getTime() + stepMs);
    if (isWithinWorkingHours(user, cursor)) {
      remaining -= REMINDER_STEP_MINUTES;
    }
    guard += 1;
  }

  return cursor;
};

const getReminderLevel = (reminderCount: number): 1 | 2 | 3 => {
  if (reminderCount <= 0) return 1;
  if (reminderCount === 1) return 2;
  return 3;
};

export const runReviewReminderScheduler = async (bot: Telegraf<BotContext>): Promise<void> => {
  const reminders = await listPendingReviewReminders(200);
  if (!reminders.length) {
    return;
  }

  const now = new Date();
  for (const reminder of reminders) {
    const mr = await findMergeRequest(reminder.projectId, reminder.iid);
    if (!mr || ['merged', 'closed'].includes(mr.state ?? '')) {
      await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
      continue;
    }
    if (mr.isDraft || isDraftTitle(mr.title)) {
      await markReminderInactive(reminder.projectId, reminder.iid, reminder.reviewerUsername);
      continue;
    }

    const reviewer = await getUserByGitlabUsername(reminder.reviewerUsername);
    if (!reviewer) {
      continue;
    }

    const workdayMinutes = getWorkdayMinutes(reviewer);
    const escalationAt = addWorkingMinutes(
      reviewer,
      reminder.assignedAt,
      workdayMinutes * ESCALATION_DAYS,
    );

    if (now >= escalationAt) {
      const reviewerLabel = await formatGitlabUserLabel(
        reviewer.gitlabUsername,
        reviewer.name,
      );
      const message = buildReviewEscalationMessage({
        title: mr.title ?? '—',
        url: mr.url ?? '—',
        taskUrl: mr.taskUrl,
        reviewerLabel,
      });
      await deliverHtmlMessageToRecipients(bot, await getLeadRecipients(), message, {
        eventType: 'mr_review_escalation',
        projectId: mr.projectId,
        mrIid: mr.iid,
        dedupeId: `${reminder.reviewerUsername}:escalation`,
      });
      await markEscalated(reminder.projectId, reminder.iid, reminder.reviewerUsername);
      continue;
    }

    const nextReminderAt = addWorkingMinutes(
      reviewer,
      reminder.assignedAt,
      REMINDER_INTERVAL_MINUTES * (reminder.reminderCount + 1),
    );

    if (now < nextReminderAt) {
      continue;
    }

    if (!isWithinWorkingHours(reviewer, now)) {
      continue;
    }

    const recipient = await getRecipientByGitlabUsername(reminder.reviewerUsername);
    if (!recipient) {
      continue;
    }

    const level = getReminderLevel(reminder.reminderCount);
    const message = buildReviewReminderMessage({
      title: mr.title ?? '—',
      url: mr.url ?? '—',
      taskUrl: mr.taskUrl,
      level,
    });
    await deliverHtmlMessage(bot, recipient, message, {
      eventType: 'mr_review_reminder',
      projectId: mr.projectId,
      mrIid: mr.iid,
      dedupeId: `${reminder.reviewerUsername}:${reminder.reminderCount + 1}`,
    });
    await incrementReminder(reminder.projectId, reminder.iid, reminder.reviewerUsername, now);
  }
};

export const startReviewReminderScheduler = (bot: Telegraf<BotContext>): void => {
  void runReviewReminderScheduler(bot);
  setInterval(() => {
    void runReviewReminderScheduler(bot);
  }, SCHEDULER_INTERVAL_MS);
};
