export type WorkHours = {
  start: string;
  end: string;
  timezone?: string;
};

export const DEFAULT_WORK_HOURS: Required<WorkHours> = {
  start: '09:00',
  end: '18:00',
  timezone: 'Europe/Moscow',
};

export const createDefaultWorkHours = (): Required<WorkHours> => ({
  ...DEFAULT_WORK_HOURS,
});

export type UserRecord = {
  gitlabUsername: string;
  gitlabUserId?: number;
  telegramUsername?: string;
  telegramUserId?: number;
  chatId?: number;
  name?: string;
  isAllowed?: boolean;
  isActive?: boolean;
  isLead?: boolean;
  workHours?: WorkHours;
  ignoreWorkHours?: boolean;
};
