export type StoredCallbackAction = {
  actorTelegramId: number;
  giveawayId: string | null;
  action: string;
  payload: Record<string, unknown>;
  expiresAt: number;
  consumedAt: number | null;
};

export interface CallbackActionRepository {
  storeCallbackAction(input: StoredCallbackAction & {
    tokenHash: string;
    createdAt: number;
  }): Promise<void>;

  consumeCallbackAction(input: {
    tokenHash: string;
    actorTelegramId: number;
    now: number;
  }): Promise<StoredCallbackAction & { alreadyConsumed: boolean }>;
}
