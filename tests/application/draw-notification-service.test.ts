import { describe, expect, it } from 'vitest';

import { DrawNotificationService } from '../../src/application/draw-notification-service.js';
import type {
  DrawNotification,
  DrawNotificationRepository,
} from '../../src/application/ports/draw-notification-repository.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';

const NOW = Date.UTC(2026, 7, 9, 12, 0);

class FakeNotificationRepository implements DrawNotificationRepository {
  notifications: DrawNotification[] = [];
  completed: string[] = [];
  failures: Array<Record<string, unknown>> = [];
  recoveredAt: number | null = null;

  recoverInterruptedNotifications(now: number): Promise<void> {
    this.recoveredAt = now;
    return Promise.resolve();
  }
  listDueNotifications(): Promise<DrawNotification[]> {
    return Promise.resolve([...this.notifications]);
  }
  claimNotification(id: string): Promise<DrawNotification | null> {
    const index = this.notifications.findIndex((item) => item.id === id);
    if (index < 0) return Promise.resolve(null);
    return Promise.resolve(this.notifications.splice(index, 1)[0]!);
  }
  completeNotification(id: string): Promise<void> {
    this.completed.push(id);
    return Promise.resolve();
  }
  failNotification(input: Record<string, unknown>): Promise<void> {
    this.failures.push(input);
    return Promise.resolve();
  }
}

describe('DrawNotificationService', () => {
  it('delivers pending winner and team messages once', async () => {
    const repository = new FakeNotificationRepository();
    repository.notifications.push(
      { id: 'one', recipientTelegramId: 101, text: 'Winner', attempts: 0 },
      { id: 'two', recipientTelegramId: 700, text: 'Team result', attempts: 0 },
    );
    const sent: Array<[number, string]> = [];
    const service = new DrawNotificationService(
      repository,
      {
        sendDirectMessage: async (chatId, text) => {
          sent.push([chatId, text]);
        },
      },
      { now: () => NOW },
    );

    expect(await service.deliverPending()).toBe(2);
    expect(sent).toEqual([
      [101, 'Winner'],
      [700, 'Team result'],
    ]);
    expect(repository.completed).toEqual(['one', 'two']);
  });

  it('records blocked chats terminally and schedules retryable failures', async () => {
    const repository = new FakeNotificationRepository();
    repository.notifications.push(
      { id: 'blocked', recipientTelegramId: 101, text: 'Winner', attempts: 0 },
      { id: 'limited', recipientTelegramId: 700, text: 'Team', attempts: 0 },
    );
    const failures = [
      new TelegramDeliveryError('blocked', 'definite', null, { kind: 'client' }),
      new TelegramDeliveryError('limited', 'definite', 8_000, {
        kind: 'rate_limited',
      }),
    ];
    const service = new DrawNotificationService(
      repository,
      {
        sendDirectMessage: async () => {
          throw failures.shift();
        },
      },
      { now: () => NOW, retryIntervalMs: 60_000 },
    );

    expect(await service.deliverPending()).toBe(2);
    expect(repository.failures).toEqual([
      expect.objectContaining({
        id: 'blocked',
        terminal: true,
        errorKind: 'telegram_client',
        availableAt: NOW,
      }),
      expect.objectContaining({
        id: 'limited',
        terminal: false,
        errorKind: 'telegram_rate_limited',
        availableAt: NOW + 60_000,
      }),
    ]);
  });
});
