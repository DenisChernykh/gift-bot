import type { GiveawayLifecycleRepository } from './ports/giveaway-lifecycle-repository.js';

type PostSynchronization = {
  recoverInterrupted(): Promise<void>;
  synchronizePending(): Promise<number>;
  waitForIdle(): Promise<void>;
};

type CancellationDependencies = {
  createId: (kind: 'sync_task') => string;
  now: () => number;
};

const defaultDependencies: CancellationDependencies = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
  now: Date.now,
};

export class GiveawayCancellationService {
  readonly #repository: GiveawayLifecycleRepository;
  readonly #synchronization: PostSynchronization;
  readonly #dependencies: CancellationDependencies;

  constructor(
    repository: GiveawayLifecycleRepository,
    synchronization: PostSynchronization,
    dependencies: Partial<CancellationDependencies> = {},
  ) {
    this.#repository = repository;
    this.#synchronization = synchronization;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async cancel(giveawayId: string): Promise<{
    kind: 'cancelled' | 'already_cancelled';
    pendingSyncTasks: number;
  }> {
    const targetCount = await this.#repository.getCancellationTargetCount(
      giveawayId,
    );
    const prepared = await this.#repository.prepareCancellation({
      giveawayId,
      syncTaskIds: Array.from({ length: targetCount }, () =>
        this.#dependencies.createId('sync_task'),
      ),
      now: this.#dependencies.now(),
    });
    await this.#synchronization.synchronizePending();
    const pending = await this.#repository.listPendingCancellationSyncTasks();
    return {
      kind: prepared.kind,
      pendingSyncTasks: pending.filter((task) => task.giveawayId === giveawayId)
        .length,
    };
  }

  async retryPendingSynchronization(): Promise<number> {
    return this.#synchronization.synchronizePending();
  }

  async recoverInterrupted(): Promise<void> {
    await this.#synchronization.recoverInterrupted();
  }

  async waitForIdle(): Promise<void> {
    await this.#synchronization.waitForIdle();
  }
}
