import { promises as fs } from 'fs';
import path from 'path';

const EVENTS_DIR = path.resolve(process.cwd(), 'logs', 'gitlab-events');

const sanitize = (value: string): string => value.replace(/[^a-z0-9-_]/gi, '_');

export const persistGitLabEvent = async (eventType: string, payload: unknown): Promise<void> => {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}-${sanitize(eventType || 'unknown')}.json`;
  const filePath = path.join(EVENTS_DIR, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
};
