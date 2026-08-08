import { createStoredToken, hashToken } from '../domain/tokens.js';
import type { CallbackActionRepository } from './ports/callback-action-repository.js';

type CallbackActionDependencies = {
  createToken: typeof createStoredToken;
  lifetimeMs: number;
  now: () => number;
};

const defaultDependencies: CallbackActionDependencies = {
  createToken: createStoredToken,
  lifetimeMs: 15 * 60 * 1000,
  now: Date.now,
};

export class CallbackActionService {
  readonly #repository: CallbackActionRepository;
  readonly #dependencies: CallbackActionDependencies;

  constructor(
    repository: CallbackActionRepository,
    dependencies: Partial<CallbackActionDependencies> = {},
  ) {
    this.#repository = repository;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async issue(input: {
    actorTelegramId: number;
    giveawayId: string | null;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<{ token: string; expiresAt: number }> {
    const now = this.#dependencies.now();
    const expiresAt = now + this.#dependencies.lifetimeMs;
    const { token, tokenHash } = this.#dependencies.createToken();
    await this.#repository.storeCallbackAction({
      ...input,
      tokenHash,
      expiresAt,
      consumedAt: null,
      createdAt: now,
    });
    return { token, expiresAt };
  }

  async consume(token: string, actorTelegramId: number) {
    return this.#repository.consumeCallbackAction({
      tokenHash: hashToken(token),
      actorTelegramId,
      now: this.#dependencies.now(),
    });
  }
}
