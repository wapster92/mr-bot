export type UserDeletionTarget = {
  userId: string;
  gitlabUsername: string;
  displayName: string;
};

export type PendingUserDeletion = UserDeletionTarget & {
  phrase: string;
  expiresAt: Date;
};

export type UserDeletionConfirmationResult =
  | { status: 'confirmed'; target: UserDeletionTarget }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'mismatch'; expectedPhrase: string };

export const buildUserDeletionPhrase = (gitlabUsername: string): string =>
  `УДАЛИТЬ ${gitlabUsername}`;

export class UserDeletionConfirmations {
  private readonly pending = new Map<number, PendingUserDeletion>();

  public constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  public request(
    actorTelegramId: number,
    target: UserDeletionTarget,
    now = new Date(),
  ): PendingUserDeletion {
    const pending: PendingUserDeletion = {
      ...target,
      phrase: buildUserDeletionPhrase(target.gitlabUsername),
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };
    this.pending.set(actorTelegramId, pending);
    return pending;
  }

  public confirm(
    actorTelegramId: number,
    messageText: string,
    now = new Date(),
  ): UserDeletionConfirmationResult {
    const pending = this.pending.get(actorTelegramId);
    if (!pending) {
      return { status: 'missing' };
    }
    if (now >= pending.expiresAt) {
      this.pending.delete(actorTelegramId);
      return { status: 'expired' };
    }
    if (messageText.trim() !== pending.phrase) {
      return { status: 'mismatch', expectedPhrase: pending.phrase };
    }
    this.pending.delete(actorTelegramId);
    return {
      status: 'confirmed',
      target: {
        userId: pending.userId,
        gitlabUsername: pending.gitlabUsername,
        displayName: pending.displayName,
      },
    };
  }
}
