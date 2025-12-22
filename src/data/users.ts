export type UserRecord = {
  telegramUsername: string;
  telegramUserId?: number;
  telegramChatId?: number;
  firstName?: string;
  lastName?: string;
  gitlabEmail?: string;
  gitlabUsername?: string;
  isActive?: boolean;
  isLead?: boolean;
  workHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  ignoreWorkHours?: boolean;
};

/**
 * Список разрешённых пользователей. Заполни недостающие поля (ID, чаты, почты),
 * чтобы бот мог фильтровать и отправлять персональные уведомления.
 * Если сотрудник в отпуске — поставь isActive: false, тогда он не попадёт в очередь ревью.
 * Для исключений по графику можно указать workHours (например, { start: "10:00", end: "19:00", timezone: "Europe/Moscow" }).
 */
export const users: UserRecord[] = [
  {
    telegramUsername: 'wapster92',
    firstName: 'Тимур',
    gitlabEmail: '',
    gitlabUsername: 'tursunbaev.ti',
    isLead: true,
    ignoreWorkHours: true,
  },
  {
    telegramUsername: 'and_lap',
    firstName: 'Андрей',
    gitlabEmail: '',
    gitlabUsername: 'laptev.ap',
  },
  {
    telegramUsername: 'reasonov',
    firstName: 'Илья',
    gitlabEmail: '',
    gitlabUsername: 'kunovskii.iv',
  },
  {
    telegramUsername: 'Irina_kanisheva',
    firstName: 'Ирина',
    gitlabEmail: '',
    gitlabUsername: 'sorokina.iv',
  },
  {
    telegramUsername: 'kaleevaFrontend',
    firstName: 'Виктория',
    gitlabEmail: '',
    gitlabUsername: 'kaleeva.va',
  },
  {
    telegramUsername: 'aa_zolotov',
    firstName: 'Антон',
    gitlabEmail: '',
    gitlabUsername: 'zolotov.aa',
  },
  {
    telegramUsername: 'neelmachine',
    firstName: 'Эрик',
    gitlabEmail: '',
    gitlabUsername: 'nasirov.ef',
  },
  {
    telegramUsername: 'dmitry_sazonov',
    firstName: 'Дима',
    gitlabEmail: '',
    gitlabUsername: 'sazonov.dr',
  },
];
