import type { ScoreCategory, ScoreEventDocument } from '../data/scoreEventRepository';
import {
  countUserScoreEvents,
  getUserScoreTotal,
  listRecentScoreEvents,
  listScoreTotals,
} from '../data/scoreEventRepository';
import { escapeHtml, formatGitlabUserLabel } from '../messages/format';
import { formatSeasonLabel, getSeasonKey } from './gameSeason';
import { getUserByGitlabUsername } from '../data/userStore';
import { isReviewerEnabled } from '../data/userTypes';
import { getReviewRewardStatus, REVIEW_REWARD_MIN_XP } from './reviewRewards';
import { listReviewRewardParticipants } from '../data/reviewRewardRepository';

type GameLevel = {
  minXp: number;
  title: string;
};

const GAME_LEVELS: GameLevel[] = [
  { minXp: 0, title: 'Стажёр' },
  { minXp: 250, title: 'Исследователь' },
  { minXp: 750, title: 'Ревьюер' },
  { minXp: 1_500, title: 'Хранитель кода' },
  { minXp: 3_000, title: 'Архитектор' },
  { minXp: 6_000, title: 'Легенда команды' },
];

const getLevel = (xp: number): { current: GameLevel; next?: GameLevel } => {
  const safeXp = Math.max(0, xp);
  let current = GAME_LEVELS[0] as GameLevel;
  let next: GameLevel | undefined;
  for (const level of GAME_LEVELS) {
    if (safeXp >= level.minXp) {
      current = level;
    } else {
      next = level;
      break;
    }
  }
  return { current, ...(next ? { next } : {}) };
};

const formatPoints = (points: number): string =>
  `${points > 0 ? '+' : ''}${points} XP`;

const formatEvent = (event: ScoreEventDocument): string => {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  }).format(event.occurredAt);
  return `${event.points > 0 ? '+' : ''}${event.points} · ${escapeHtml(event.description)} · MR !${event.iid} · ${date}`;
};

const getAchievements = async (username: string): Promise<string[]> => {
  const [fastResponses, reviewResponses, overdueReviews, fastMerges] =
    await Promise.all([
      countUserScoreEvents(username, ['review_response_3h']),
      countUserScoreEvents(username, [
        'review_response_3h',
        'review_response_day',
        'review_response',
      ]),
      countUserScoreEvents(username, ['review_overdue']),
      countUserScoreEvents(username, ['mr_fast_merge_day']),
    ]);
  const achievements: string[] = [];
  if (fastResponses > 0) {
    achievements.push('⚡ Быстрая реакция');
  }
  if (reviewResponses >= 10 && overdueReviews === 0) {
    achievements.push('🛡 Надёжный ревьюер');
  }
  if (fastMerges >= 5) {
    achievements.push('🚀 Быстрый релиз');
  }
  return achievements;
};

export const buildGameProfileMessage = async (
  username: string,
): Promise<string> => {
  const season = getSeasonKey();
  const [seasonTotals, allTime, recentEvents, achievements, rewardStatus, user] = await Promise.all([
    listScoreTotals({ season, limit: 500 }),
    getUserScoreTotal({ username }),
    listRecentScoreEvents(username, 5),
    getAchievements(username),
    getReviewRewardStatus(),
    getUserByGitlabUsername(username),
  ]);
  const usernameLower = username.toLowerCase();
  const seasonPosition = seasonTotals.findIndex(
    (item) => item.usernameLower === usernameLower,
  );
  const seasonTotal =
    seasonPosition >= 0 ? seasonTotals[seasonPosition] : undefined;
  const totalXp = allTime?.points ?? 0;
  const level = getLevel(totalXp);
  const userLabel = await formatGitlabUserLabel(username);
  const lines = [
    '🎮 <b>Игровой профиль</b>',
    userLabel,
    '',
    `Сезон: ${escapeHtml(formatSeasonLabel(season))}`,
    `Место: ${seasonPosition >= 0 ? `#${seasonPosition + 1} из ${seasonTotals.length}` : 'пока нет'}`,
    `XP сезона: ${seasonTotal?.points ?? 0}`,
    `Review: ${formatPoints(seasonTotal?.reviewEarned ?? 0)}`,
    `Свои MR: ${formatPoints(seasonTotal?.authorEarned ?? 0)}`,
    `Штрафы: ${formatPoints(seasonTotal?.penalties ?? 0)}`,
    '',
    `Общий XP: ${totalXp}`,
    `Уровень: ${escapeHtml(level.current.title)}`,
  ];
  if (level.next) {
    lines.push(
      `До уровня «${escapeHtml(level.next.title)}»: ${Math.max(0, level.next.minXp - Math.max(0, totalXp))} XP`,
    );
  }
  if (user?.isLead) {
    lines.push('', 'Лиды участвуют в топе, но не освобождаются от ревью.');
  } else if (user && isReviewerEnabled(user) && rewardStatus.paused) {
    lines.push('', `Программа освобождения приостановлена: доступны ${rewardStatus.activeReviewers} разработчика. После освобождения одного должны оставаться минимум трое.`);
  } else if (user && isReviewerEnabled(user) && rewardStatus.exemptUsernames.has(usernameLower)) {
    lines.push('', '🎁 Ты освобождён от новых назначений до конца сегодняшнего дня по Москве. Уже назначенные MR остаются за тобой. Пересчёт — в 00:00.');
  }
  if (achievements.length) {
    lines.push('', '<b>Достижения</b>', ...achievements);
  }
  if (recentEvents.length) {
    lines.push('', '<b>Последние начисления</b>', ...recentEvents.map(formatEvent));
  }
  return lines.join('\n');
};

const getTopTitle = (category?: ScoreCategory): string => {
  if (category === 'review') {
    return 'Топ ревьюеров';
  }
  if (category === 'author') {
    return 'Топ авторов';
  }
  return 'Общий топ';
};

export const buildGameTopMessage = async (
  category?: ScoreCategory,
  season = getSeasonKey(),
): Promise<string> => {
  const totals = await listScoreTotals({
    season,
    ...(category ? { category } : {}),
    limit: 10,
  });
  const lines = [
    `🏆 <b>${getTopTitle(category)} — ${escapeHtml(formatSeasonLabel(season))}</b>`,
  ];
  if (!totals.length) {
    lines.push('', season === getSeasonKey()
      ? 'В этом сезоне пока нет начислений.'
      : 'За этот месяц нет сохранённых начислений. История ведётся с момента запуска игровой системы.');
    return lines.join('\n');
  }
  const medals = ['🥇', '🥈', '🥉'];
  const currentSeason = season === getSeasonKey();
  const showReviewRewards = currentSeason && category !== 'author';
  const rewardStatus = showReviewRewards ? await getReviewRewardStatus() : undefined;
  const exempt = rewardStatus?.exemptUsernames ?? new Set<string>();
  for (let index = 0; index < totals.length; index += 1) {
    const total = totals[index];
    if (!total) continue;
    const userLabel = await formatGitlabUserLabel(total.username);
    let reward = '';
    if (showReviewRewards) {
      const user = await getUserByGitlabUsername(total.username);
      reward = user?.isLead
        ? ' · лид, вне программы'
        : user && isReviewerEnabled(user) && exempt.has(total.usernameLower)
          ? ' · 🎁 освобождён сегодня' : '';
    }
    lines.push(
      `${medals[index] ?? `${index + 1}.`} ${userLabel} — ${total.points} XP${reward}`,
    );
  }
  if (showReviewRewards) {
    const winners = await Promise.all([...exempt].map((name) => formatGitlabUserLabel(name)));
    if (category === 'review') {
      const participants = await listReviewRewardParticipants();
      const standings = await listScoreTotals({ season, category: 'review', usernames: participants, limit: 10 });
      lines.push('', '<b>Зачёт разработчиков для освобождения</b>');
      for (let index = 0; index < standings.length; index += 1) {
        const total = standings[index]!;
        lines.push(`${index + 1}. ${await formatGitlabUserLabel(total.username)} — ${total.points} review XP`);
      }
      if (!standings.length) lines.push('Пока нет начислений.');
    }
    lines.push('', rewardStatus?.paused
      ? `Программа приостановлена: доступны ${rewardStatus.activeReviewers} разработчика, для освобождения одного нужно минимум четверо.`
      : `🎁 Освобождён сегодня: ${winners.join(', ') || 'пока никто'}.`,
      `Отдельный зачёт за ревью без лидов, порог ${REVIEW_REWARD_MIN_XP} XP. Одно место закреплено до 00:00 по Москве; свободное можно занять в течение дня.`);
  }
  return lines.join('\n');
};
