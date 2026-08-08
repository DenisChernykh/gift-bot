import type { ChannelHealthAlertService } from './channel-health-alert-service.js';
import type { GiveawayPostSynchronizationService } from './giveaway-post-synchronization-service.js';

export class GiftBotMaintenanceService {
  readonly #posts: GiveawayPostSynchronizationService;
  readonly #alerts: ChannelHealthAlertService;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    posts: GiveawayPostSynchronizationService,
    alerts: ChannelHealthAlertService,
  ) {
    this.#posts = posts;
    this.#alerts = alerts;
  }

  async recoverInterrupted(): Promise<void> {
    await this.#posts.recoverInterrupted();
  }

  retryPendingSynchronization(): Promise<number> {
    let result = 0;
    const run = this.#tail.then(async () => {
      result =
        (await this.#posts.synchronizePending()) +
        (await this.#alerts.retryPendingNotifications());
    });
    this.#tail = run.catch(() => undefined);
    return run.then(() => result);
  }

  waitForIdle(): Promise<void> {
    return this.#tail;
  }
}
