import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

const EVENTS_DIR = path.resolve(process.cwd(), 'logs', 'gitlab-events');
const MAX_EVENTS_SIZE_BYTES = Math.max(1, config.logGitlabMaxMb) * 1024 * 1024;

const sanitize = (value: string): string => value.replace(/[^a-z0-9-_]/gi, '_');

const pruneOldEvents = async (): Promise<void> => {
  const entries = await fs.readdir(EVENTS_DIR, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (!files.length) {
    return;
  }

  const stats = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(EVENTS_DIR, file);
      const stat = await fs.stat(filePath);
      return { file, filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    }),
  );

  let totalSize = stats.reduce((sum, item) => sum + item.size, 0);
  if (totalSize <= MAX_EVENTS_SIZE_BYTES) {
    return;
  }

  const sorted = stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of sorted) {
    if (totalSize <= MAX_EVENTS_SIZE_BYTES) {
      break;
    }
    await fs.unlink(item.filePath);
    totalSize -= item.size;
  }
};

export const persistGitLabEvent = async (eventType: string, payload: unknown): Promise<void> => {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}-${sanitize(eventType || 'unknown')}.json`;
  const filePath = path.join(EVENTS_DIR, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  await pruneOldEvents();
};
