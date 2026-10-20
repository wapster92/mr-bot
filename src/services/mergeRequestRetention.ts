import type { MergeRequestDocument } from '../data/mergeRequestRepository';

export const MERGE_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const getMergeRequestFinishedAt = (
  current: MergeRequestDocument,
  previous: MergeRequestDocument | null,
  terminalDate?: Date,
  now = new Date(),
): Date | null => {
  if (!['closed', 'merged'].includes(current.state ?? '')) return null;
  if (terminalDate) return terminalDate;
  if (previous && previous.state === current.state) {
    return previous.finishedAt ?? previous.updatedAt ?? current.updatedAt ?? now;
  }
  return now;
};
