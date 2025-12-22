export type UserRecord = {
  gitlabUsername: string;
  telegramUsername?: string;
  telegramUserId?: number;
  chatId?: number;
  name?: string;
  isAllowed?: boolean;
  isActive?: boolean;
  isLead?: boolean;
  workHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  ignoreWorkHours?: boolean;
};
