import { getChatIdByUsername, getLeadUsers, getUserByGitlabUsername } from '../data/userStore';

export const getLeadChatIds = async (): Promise<number[]> => {
  const leads = getLeadUsers();
  const chatIds: number[] = [];
  for (const lead of leads) {
    if (!lead.telegramUsername) continue;
    const chatId = await getChatIdByUsername(lead.telegramUsername);
    if (chatId) {
      chatIds.push(chatId);
    }
  }
  return chatIds;
};

export const getChatIdByGitlabUsername = async (
  gitlabUsername: string,
): Promise<number | undefined> => {
  const userRecord = getUserByGitlabUsername(gitlabUsername);
  if (!userRecord?.telegramUsername) {
    return undefined;
  }
  return getChatIdByUsername(userRecord.telegramUsername);
};
