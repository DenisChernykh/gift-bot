import type {
  PostSynchronizationRepository,
  PostSynchronizationTask,
} from './ports/post-synchronization-repository.js';
import {
  TelegramDeliveryError,
  type TelegramPostEdit,
} from './ports/telegram-gateway.js';
import { GiveawayResultRenderingError } from '../domain/giveaway-result-rendering.js';

type PostEditGateway = {
  editGiveawayPost(input: TelegramPostEdit): Promise<void>;
};

type SynchronizationDependencies = {
  now: () => number;
  retryIntervalMs: number;
};

const defaultDependencies: SynchronizationDependencies = {
  now: Date.now,
  retryIntervalMs: 60_000,
};

export class GiveawayPostSynchronizationService {
  readonly #repository: PostSynchronizationRepository;
  readonly #gateway: PostEditGateway;
  readonly #dependencies: SynchronizationDependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    repository: PostSynchronizationRepository,
    gateway: PostEditGateway,
    dependencies: Partial<SynchronizationDependencies> = {},
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  recoverInterrupted(): Promise<void> {
    return this.#repository.recoverInterrupted(this.#dependencies.now());
  }

  synchronizePending(): Promise<number> {
    let result!: number;
    let failure: unknown;
    const run = this.#tail.then(async () => {
      try {
        result = await this.#run();
      } catch (error) {
        failure = error;
      }
    });
    this.#tail = run;
    return run.then(() => {
      if (failure !== undefined) throw failure;
      return result;
    });
  }

  waitForIdle(): Promise<void> {
    return this.#tail;
  }

  async #run(): Promise<number> {
    const now = this.#dependencies.now();
    const tasks = await this.#repository.listDueTasks(now);
    let claimedCount = 0;
    for (const candidate of tasks) {
      const task = await this.#repository.claimTask(candidate.id, now);
      if (!task) continue;
      claimedCount += 1;
      let edit: TelegramPostEdit | null;
      try {
        edit = await this.#repository.getTaskEdit(task);
      } catch (error) {
        await this.#recordFailure(task, error);
        continue;
      }
      if (!edit) {
        await this.#repository.supersedeTask(task.id, this.#dependencies.now());
        continue;
      }
      try {
        await this.#gateway.editGiveawayPost(edit);
        const completedAt = this.#dependencies.now();
        await this.#repository.completeTask({
          id: task.id,
          expectedPayload: task.payload,
          availableAt:
            task.taskType === 'participant_count'
              ? completedAt + this.#dependencies.retryIntervalMs
              : completedAt,
          now: completedAt,
        });
      } catch (error) {
        await this.#recordFailure(task, error);
      }
    }
    return claimedCount;
  }

  async #recordFailure(
    task: PostSynchronizationTask,
    error: unknown,
  ): Promise<void> {
    const classified = classifySynchronizationError(error);
    const delay = Math.max(
      task.taskType === 'participant_count'
        ? this.#dependencies.retryIntervalMs
        : 0,
      classified.retryAfterMs ?? 0,
    );
    const failedAt = this.#dependencies.now();
    await this.#repository.failTask({
      id: task.id,
      errorKind: classified.errorKind,
      terminal: classified.terminal,
      availableAt: failedAt + delay,
      now: failedAt,
    });
  }
}

function classifySynchronizationError(error: unknown): {
  errorKind: string;
  retryAfterMs: number | null;
  terminal: boolean;
} {
  if (error instanceof GiveawayResultRenderingError) {
    return {
      errorKind: 'result_rendering',
      retryAfterMs: null,
      terminal: true,
    };
  }
  if (error instanceof TelegramDeliveryError) {
    return {
      errorKind: `telegram_${error.outcome}`,
      retryAfterMs: error.retryAfterMs,
      terminal: false,
    };
  }
  return { errorKind: 'unexpected', retryAfterMs: null, terminal: false };
}
