import type { ChannelHealthAlertService } from './channel-health-alert-service.js';
import type { GiveawayPostSynchronizationService } from './giveaway-post-synchronization-service.js';

type DrawMaintenance = {
  recoverDrawing(): Promise<number>;
  processDue(): Promise<number>;
};

const noDrawMaintenance: DrawMaintenance = {
  recoverDrawing: async () => 0,
  processDue: async () => 0,
};

type DrawNotificationMaintenance = {
  recoverInterrupted(): Promise<void>;
  deliverPending(): Promise<number>;
  waitForIdle(): Promise<void>;
};

const noDrawNotificationMaintenance: DrawNotificationMaintenance = {
  recoverInterrupted: async () => undefined,
  deliverPending: async () => 0,
  waitForIdle: async () => undefined,
};

export class GiftBotMaintenanceService {
  readonly #posts: GiveawayPostSynchronizationService;
  readonly #alerts: ChannelHealthAlertService;
  readonly #draws: DrawMaintenance;
  readonly #notifications: DrawNotificationMaintenance;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    posts: GiveawayPostSynchronizationService,
    alerts: ChannelHealthAlertService,
    draws: DrawMaintenance = noDrawMaintenance,
    notifications: DrawNotificationMaintenance = noDrawNotificationMaintenance,
  ) {
    this.#posts = posts;
    this.#alerts = alerts;
    this.#draws = draws;
    this.#notifications = notifications;
  }

  async recoverInterrupted(): Promise<void> {
    await this.#posts.recoverInterrupted();
    await this.#draws.recoverDrawing();
    await this.#notifications.recoverInterrupted();
  }

  retryPendingSynchronization(): Promise<number> {
    let result = 0;
    const run = this.#tail.then(async () => {
      result =
        (await this.#draws.processDue()) +
        (await this.#posts.synchronizePending()) +
        (await this.#notifications.deliverPending()) +
        (await this.#alerts.retryPendingNotifications());
    });
    this.#tail = run.catch(() => undefined);
    return run.then(() => result);
  }

  async waitForIdle(): Promise<void> {
    await this.#tail;
    await this.#notifications.waitForIdle();
  }
}
