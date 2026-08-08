import type { ChannelHealthAlertRepository } from './ports/channel-health-alert-repository.js';

type DirectMessageGateway = {
  sendDirectMessage(chatId: number, text: string): Promise<void>;
};

type ChannelHealthAlertDependencies = {
  now: () => number;
};

export class ChannelHealthAlertService {
  readonly #repository: ChannelHealthAlertRepository;
  readonly #gateway: DirectMessageGateway;
  readonly #dependencies: ChannelHealthAlertDependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    repository: ChannelHealthAlertRepository,
    gateway: DirectMessageGateway,
    dependencies: Partial<ChannelHealthAlertDependencies> = {},
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { now: Date.now, ...dependencies };
  }

  retryPendingNotifications(): Promise<number> {
    let result = 0;
    const run = this.#tail.then(async () => {
      result = await this.#run();
    });
    this.#tail = run.catch(() => undefined);
    return run.then(() => result);
  }

  waitForIdle(): Promise<void> {
    return this.#tail;
  }

  async #run(): Promise<number> {
    const alerts = await this.#repository.listPendingBotRightsAlerts();
    let notified = 0;
    for (const alert of alerts) {
      try {
        await this.#gateway.sendDirectMessage(
          alert.createdByTelegramId,
          `Предупреждение по розыгрышу «${alert.giveawayTitle}»: бот больше не администратор канала @${alert.channelUsername} («${alert.channelTitle}»). Регистрация новых участников временно закрыта до восстановления прав.`,
        );
        await this.#repository.markBotRightsAlertNotified(
          alert.id,
          this.#dependencies.now(),
        );
        notified += 1;
      } catch {
        // The active, unnotified row remains durable for the next pass.
      }
    }
    return notified;
  }
}
