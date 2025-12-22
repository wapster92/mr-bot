import type { UserRecord } from './userTypes';

/**
 * Список разрешённых пользователей. Используется как seed при миграциях.
 * Если сотрудник в отпуске — поставь isActive: false, тогда он не попадёт в очередь ревью.
 * Для исключений по графику можно указать workHours (например, { start: "10:00", end: "19:00", timezone: "Europe/Moscow" }).
 */
export const users: UserRecord[] = [
  {
    telegramUsername: 'wapster92',
    gitlabUsername: 'tursunbaev.ti',
    isLead: true,
    ignoreWorkHours: true,
  },
  {
    telegramUsername: 'and_lap',
    gitlabUsername: 'laptev.ap',
  },
  {
    telegramUsername: 'reasonov',
    gitlabUsername: 'kunovskii.iv',
  },
  {
    telegramUsername: 'Irina_kanisheva',
    gitlabUsername: 'sorokina.iv',
  },
  {
    telegramUsername: 'kaleevaFrontend',
    gitlabUsername: 'kaleeva.va',
  },
  {
    telegramUsername: 'aa_zolotov',
    gitlabUsername: 'zolotov.aa',
  },
  {
    telegramUsername: 'neelmachine',
    gitlabUsername: 'nasirov.ef',
  },
  {
    telegramUsername: 'dmitry_sazonov',
    gitlabUsername: 'sazonov.dr',
  },
];
