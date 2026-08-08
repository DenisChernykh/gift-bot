import type { Context, MiddlewareFn } from 'grammy';

import type { SafeLogger } from './logger.js';

type BotLifecycle = {
  start(): Promise<void>;
  stop(): Promise<void> | void;
};

type PublicationRecovery = {
  recoverPublications(): Promise<unknown>;
};

type CancellationSynchronization = {
  recoverInterrupted(): Promise<void>;
  retryPendingSynchronization(): Promise<number>;
  waitForIdle(): Promise<void>;
};

type UpdateDrain = {
  stopAccepting(): void;
  waitForIdle(): Promise<void>;
};

type RuntimeDependencies = {
  logger: SafeLogger;
  schedule: (operation: () => void, milliseconds: number) => unknown;
  clearSchedule: (handle: unknown) => void;
  synchronizationIntervalMs: number;
  updateDrain: UpdateDrain;
};

const defaultDependencies: Omit<RuntimeDependencies, 'logger'> = {
  schedule: (operation, milliseconds) => setInterval(operation, milliseconds),
  clearSchedule: (handle) => clearInterval(handle as NodeJS.Timeout),
  synchronizationIntervalMs: 60_000,
  updateDrain: {
    stopAccepting: () => undefined,
    waitForIdle: async () => undefined,
  },
};

export class InFlightUpdateTracker implements UpdateDrain {
  #accepting = true;
  #inFlight = 0;
  readonly #idleWaiters = new Set<() => void>();

  middleware<C extends Context>(): MiddlewareFn<C> {
    return async (_context, next) => {
      if (!this.#accepting) return;
      this.#inFlight += 1;
      try {
        await next();
      } finally {
        this.#inFlight -= 1;
        if (this.#inFlight === 0) {
          for (const resolve of this.#idleWaiters) resolve();
          this.#idleWaiters.clear();
        }
      }
    };
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async waitForIdle(): Promise<void> {
    if (this.#inFlight === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }
}

export class GiftBotRuntime {
  readonly #bot: BotLifecycle;
  readonly #recovery: PublicationRecovery;
  readonly #cancellation: CancellationSynchronization;
  readonly #closeDatabase: () => Promise<void>;
  readonly #dependencies: RuntimeDependencies;
  #timer: unknown;
  #stopped = false;

  constructor(
    bot: BotLifecycle,
    recovery: PublicationRecovery,
    cancellation: CancellationSynchronization,
    closeDatabase: () => Promise<void>,
    dependencies: Partial<RuntimeDependencies> & Pick<RuntimeDependencies, 'logger'>,
  ) {
    this.#bot = bot;
    this.#recovery = recovery;
    this.#cancellation = cancellation;
    this.#closeDatabase = closeDatabase;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async start(): Promise<void> {
    const recovered = await this.#recovery.recoverPublications();
    await this.#cancellation.recoverInterrupted();
    const synchronized = await this.#cancellation.retryPendingSynchronization();
    this.#dependencies.logger.info('startup_recovery_completed', {
      recoveredPublicationCount: Array.isArray(recovered) ? recovered.length : 0,
      synchronizedCancellationCount: synchronized,
    });
    this.#timer = this.#dependencies.schedule(() => {
      void this.#cancellation.retryPendingSynchronization().catch((error) => {
        this.#dependencies.logger.error('cancellation_sync_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
    }, this.#dependencies.synchronizationIntervalMs);
    await this.#bot.start();
  }

  async stop(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#dependencies.clearSchedule(this.#timer);
    this.#dependencies.logger.info('bot_stopping', { signal });
    const stopPolling = Promise.resolve(this.#bot.stop());
    this.#dependencies.updateDrain.stopAccepting();
    await stopPolling;
    await this.#dependencies.updateDrain.waitForIdle();
    await this.#cancellation.waitForIdle();
    await this.#closeDatabase();
    this.#dependencies.logger.info('bot_stopped', { signal });
  }
}
