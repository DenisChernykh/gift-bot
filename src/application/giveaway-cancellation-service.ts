import type {
  CancellationSyncTask,
  GiveawayLifecycleRepository,
} from './ports/giveaway-lifecycle-repository.js';
import type { TelegramGateway } from './ports/telegram-gateway.js';

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
  readonly #gateway: TelegramGateway;
  readonly #dependencies: CancellationDependencies;

  constructor(
    repository: GiveawayLifecycleRepository,
    gateway: TelegramGateway,
    dependencies: Partial<CancellationDependencies> = {},
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
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
    await this.#processTasks(prepared.tasks);
    const pending = await this.#repository.listPendingCancellationSyncTasks();
    return {
      kind: prepared.kind,
      pendingSyncTasks: pending.filter((task) => task.giveawayId === giveawayId)
        .length,
    };
  }

  async retryPendingSynchronization(): Promise<number> {
    const tasks = await this.#repository.listPendingCancellationSyncTasks();
    await this.#processTasks(tasks);
    return tasks.length;
  }

  async #processTasks(tasks: CancellationSyncTask[]): Promise<void> {
    for (const task of tasks) {
      try {
        await this.#gateway.editCancelledMessage({
          chatId: task.chatId,
          messageId: task.messageId,
          kind: task.messageKind,
          text: task.text,
        });
        await this.#repository.completeCancellationSyncTask(
          task.id,
          this.#dependencies.now(),
        );
      } catch {
        await this.#repository.failCancellationSyncTask(
          task.id,
          this.#dependencies.now(),
        );
      }
    }
  }
}
