import type { SafeLogger } from './logger.js';

type BotLifecycle = {
  start(): Promise<void>;
  stop(): Promise<void> | void;
};

type PublicationRecovery = {
  recoverPublications(): Promise<unknown>;
};

type CancellationSynchronization = {
  retryPendingSynchronization(): Promise<number>;
};

type RuntimeDependencies = {
  logger: SafeLogger;
  schedule: (operation: () => void, milliseconds: number) => unknown;
  clearSchedule: (handle: unknown) => void;
  synchronizationIntervalMs: number;
};

const defaultDependencies: Omit<RuntimeDependencies, 'logger'> = {
  schedule: (operation, milliseconds) => setInterval(operation, milliseconds),
  clearSchedule: (handle) => clearInterval(handle as NodeJS.Timeout),
  synchronizationIntervalMs: 60_000,
};

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
    await this.#bot.stop();
    await this.#closeDatabase();
    this.#dependencies.logger.info('bot_stopped', { signal });
  }
}
