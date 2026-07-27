import { getChatIdByUsername, listLeadUsers, getUserByGitlabUsername } from '../data/userStore';
import type { UserRecord } from '../data/userTypes';
import { isWithinWorkingHours } from '../services/workingHours';

export { isWithinWorkingHours } from '../services/workingHours';

export type DeliveryRecipient = {
  chatId: number;
  telegramUsername?: string | undefined;
  gitlabUsername?: string | undefined;
  isWithinHours: boolean;
};

export const hasGitlabUserApproved = (
  approvedBy: string[],
  gitlabUsername?: string,
): boolean =>
  Boolean(
    gitlabUsername &&
      approvedBy.some(
        (username) => username.toLowerCase() === gitlabUsername.toLowerCase(),
      ),
  );

export const filterRecipientsWithoutApproval = (
  recipients: DeliveryRecipient[],
  approvedBy: string[],
): DeliveryRecipient[] => {
  return recipients.filter(
    (recipient) => !hasGitlabUserApproved(approvedBy, recipient.gitlabUsername),
  );
};

const toRecipient = async (
  user: UserRecord,
  now: Date,
): Promise<DeliveryRecipient | undefined> => {
  if (user.isAllowed === false || user.isActive === false || !user.telegramUsername) {
    return undefined;
  }
  const chatId = await getChatIdByUsername(user.telegramUsername);
  if (!chatId) {
    return undefined;
  }
  return {
    chatId,
    telegramUsername: user.telegramUsername ?? undefined,
    gitlabUsername: user.gitlabUsername ?? undefined,
    isWithinHours: isWithinWorkingHours(user, now),
  };
};

export const getLeadChatIds = async (): Promise<number[]> => {
  const leads = await listLeadUsers();
  const chatIds: number[] = [];
  const now = new Date();
  for (const lead of leads) {
    if (!lead.telegramUsername) continue;
    if (!isWithinWorkingHours(lead, now)) continue;
    const chatId = await getChatIdByUsername(lead.telegramUsername);
    if (chatId) {
      chatIds.push(chatId);
    }
  }
  return chatIds;
};

export const getLeadRecipients = async (): Promise<DeliveryRecipient[]> => {
  const leads = await listLeadUsers();
  const now = new Date();
  const recipients: DeliveryRecipient[] = [];
  for (const lead of leads) {
    const recipient = await toRecipient(lead, now);
    if (recipient) {
      recipients.push(recipient);
    }
  }
  return recipients;
};

export const getChatIdByGitlabUsername = async (
  gitlabUsername: string,
): Promise<number | undefined> => {
  const userRecord = await getUserByGitlabUsername(gitlabUsername);
  if (!userRecord?.telegramUsername) {
    return undefined;
  }
  if (!isWithinWorkingHours(userRecord, new Date())) {
    return undefined;
  }
  return getChatIdByUsername(userRecord.telegramUsername);
};

export const getRecipientByGitlabUsername = async (
  gitlabUsername: string,
): Promise<DeliveryRecipient | undefined> => {
  const userRecord = await getUserByGitlabUsername(gitlabUsername);
  if (!userRecord) {
    return undefined;
  }
  return toRecipient(userRecord, new Date());
};
