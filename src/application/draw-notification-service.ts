import type { DrawNotificationRepository } from './ports/draw-notification-repository.js';
import { TelegramDeliveryError } from './ports/telegram-gateway.js';

type DirectMessageGateway = {
  sendDirectMessage(chatId: number, text: string): Promise<void>;
};

type NotificationDependencies = {
  now: () => number;
  retryIntervalMs: number;
};

const defaultDependencies: NotificationDependencies = {
  now: Date.now,
  retryIntervalMs: 60_000,
};

export class DrawNotificationService {
  readonly #repository: DrawNotificationRepository;
  readonly #gateway: DirectMessageGateway;
  readonly #dependencies: NotificationDependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    repository: DrawNotificationRepository,
    gateway: DirectMessageGateway,
    dependencies: Partial<NotificationDependencies> = {},
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  recoverInterrupted(): Promise<void> {
    return this.#repository.recoverInterruptedNotifications(
      this.#dependencies.now(),
    );
  }

  deliverPending(): Promise<number> {
    let count = 0;
    const run = this.#tail.then(async () => {
      const now = this.#dependencies.now();
      const candidates = await this.#repository.listDueNotifications(now);
      for (const candidate of candidates) {
        const notification = await this.#repository.claimNotification(
          candidate.id,
          now,
        );
        if (!notification) continue;
        count += 1;
        try {
          await this.#gateway.sendDirectMessage(
            notification.recipientTelegramId,
            notification.text,
          );
          await this.#repository.completeNotification(
            notification.id,
            this.#dependencies.now(),
          );
        } catch (error) {
          const failedAt = this.#dependencies.now();
          const telegram =
            error instanceof TelegramDeliveryError ? error : null;
          const terminal = telegram?.kind === 'client';
          const retryAfterMs = telegram?.retryAfterMs ?? 0;
          await this.#repository.failNotification({
            id: notification.id,
            terminal,
            errorKind: telegram
              ? `telegram_${telegram.kind}`
              : 'unexpected',
            availableAt: terminal
              ? failedAt
              : failedAt +
                Math.max(this.#dependencies.retryIntervalMs, retryAfterMs),
            now: failedAt,
          });
        }
      }
    });
    this.#tail = run.catch(() => undefined);
    return run.then(() => count);
  }

  waitForIdle(): Promise<void> {
    return this.#tail;
  }
}
