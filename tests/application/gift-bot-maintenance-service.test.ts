import { describe, expect, it } from 'vitest';

import { GiftBotMaintenanceService } from '../../src/application/gift-bot-maintenance-service.js';

describe('GiftBotMaintenanceService', () => {
  it('recovers stored draws before claiming due work and publishing outboxes', async () => {
    const events: string[] = [];
    const service = new GiftBotMaintenanceService(
      {
        recoverInterrupted: async () => {
          events.push('posts:recover');
        },
        synchronizePending: async () => {
          events.push('posts:sync');
          return 2;
        },
      } as never,
      {
        retryPendingNotifications: async () => {
          events.push('alerts');
          return 3;
        },
      } as never,
      {
        recoverDrawing: async () => {
          events.push('draw:recover');
          return 1;
        },
        processDue: async () => {
          events.push('draw:due');
          return 4;
        },
      },
      {
        recoverInterrupted: async () => {
          events.push('notifications:recover');
        },
        deliverPending: async () => {
          events.push('notifications');
          return 2;
        },
        waitForIdle: async () => undefined,
      },
    );

    await service.recoverInterrupted();
    expect(await service.retryPendingSynchronization()).toBe(11);
    expect(events).toEqual([
      'posts:recover',
      'draw:recover',
      'notifications:recover',
      'draw:due',
      'posts:sync',
      'notifications',
      'alerts',
    ]);
  });
});
