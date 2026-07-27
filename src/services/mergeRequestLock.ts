const mergeRequestLocks = new Map<string, Promise<void>>();

export const withMergeRequestLock = async <T>(
  projectId: number,
  iid: number,
  task: () => Promise<T>,
): Promise<T> => {
  const key = `${projectId}:${iid}`;
  const previous = mergeRequestLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  mergeRequestLocks.set(key, queued);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (mergeRequestLocks.get(key) === queued) {
      mergeRequestLocks.delete(key);
    }
  }
};
