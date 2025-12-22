import { upsertGitlabUserProfile } from '../../data/userStore';

export const persistGitlabUserProfileFromPayload = async (payload: any): Promise<void> => {
  const username = payload.user?.username;
  const name = payload.user?.name;
  if (!username || !name) {
    return;
  }
  try {
    await upsertGitlabUserProfile(username, name);
  } catch (error) {
    console.warn('[gitlab] Failed to store user profile', error);
  }
};
