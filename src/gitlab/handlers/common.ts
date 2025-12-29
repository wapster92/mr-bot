import { upsertGitlabUserProfile } from '../../data/userStore';

type GitlabUser = {
  id?: number;
  username?: string;
  name?: string;
};

export const persistGitlabUserProfileFromPayload = async (payload: any): Promise<void> => {
  const username = payload.user?.username;
  const name = payload.user?.name;
  const id = payload.user?.id;
  if (!username || !name) {
    return;
  }
  try {
    await upsertGitlabUserProfile(username, name, typeof id === 'number' ? id : undefined);
  } catch (error) {
    console.warn('[gitlab] Failed to store user profile', error);
  }
};

export const persistGitlabUserProfiles = async (users: GitlabUser[]): Promise<void> => {
  const updates = users.filter((user) => user.username && (user.name || user.id));
  if (!updates.length) {
    return;
  }
  for (const user of updates) {
    try {
      await upsertGitlabUserProfile(
        user.username as string,
        user.name as string | undefined,
        typeof user.id === 'number' ? user.id : undefined,
      );
    } catch (error) {
      console.warn('[gitlab] Failed to store user profile', error);
    }
  }
};
