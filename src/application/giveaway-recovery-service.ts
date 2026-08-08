import type { GiveawayLifecycleRepository, RecoverablePublication } from './ports/giveaway-lifecycle-repository.js';
import type { TelegramGateway } from './ports/telegram-gateway.js';

type RecoveryDependencies = { now: () => number; logger: { error(event: string, fields?: Record<string, unknown>): void } };

export class GiveawayRecoveryService {
  readonly #repository: GiveawayLifecycleRepository;
  readonly #gateway: TelegramGateway;
  readonly #dependencies: RecoveryDependencies;

  constructor(
    repository: GiveawayLifecycleRepository,
    gateway: TelegramGateway,
    dependencies: Partial<RecoveryDependencies> = {},
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { now: Date.now, logger: { error: () => undefined }, ...dependencies };
  }

  async recoverPublications(): Promise<
    Array<{ giveawayId: string; kind: 'activated' | 'rolled_back' | 'failed' }>
  > {
    const recoverable = await this.#repository.listRecoverablePublications();
    const results: Array<{
      giveawayId: string;
      kind: 'activated' | 'rolled_back' | 'failed';
    }> = [];
    for (const publication of recoverable) {
      results.push(await this.#recover(publication));
    }
    return results;
  }

  async #recover(publication: RecoverablePublication) {
    const uncertainDeliveries = publication.deliveries.filter((delivery) =>
      ['sending', 'unknown'].includes(delivery.status),
    );
    if (uncertainDeliveries.length > 0) {
      await this.#repository.failPublication({
        publicationRunId: publication.runId,
        failure: { stage: 'recovery_unknown_send', errorKind: 'unknown_delivery' },
        now: this.#dependencies.now(),
      });
      for (const delivery of uncertainDeliveries) {
        this.#dependencies.logger.error('publication_failed', {
          giveawayId: publication.giveawayId,
          stage: 'recovery_unknown_send',
          errorKind: 'unknown_delivery',
          channelId: delivery.giveawayChannelId,
          channelUsername: delivery.channelUsername,
        });
      }
      return { giveawayId: publication.giveawayId, kind: 'failed' as const };
    }
    if (
      publication.deliveries.length > 0 &&
      publication.deliveries.every(
        (delivery) => delivery.status === 'delivered' && delivery.messageId !== null,
      )
    ) {
      await this.#repository.failPublication({
        publicationRunId: publication.runId,
        failure: {
          stage: 'activation_uncertain',
          errorKind: 'telegram_posts_unverified',
        },
        now: this.#dependencies.now(),
      });
      this.#dependencies.logger.error('publication_failed', {
        giveawayId: publication.giveawayId,
        stage: 'activation_uncertain',
        errorKind: 'telegram_posts_unverified',
      });
      return { giveawayId: publication.giveawayId, kind: 'failed' as const };
    }

    const known = publication.deliveries.filter(
      (delivery) => delivery.status === 'delivered' && delivery.messageId !== null,
    );
    const deletedDeliveryIds: string[] = [];
    const failedDeliveries: typeof known = [];
    let complete = true;
    for (const delivery of [...known].reverse()) {
      try {
        await this.#gateway.deleteMessage(
          delivery.telegramChatId,
          delivery.messageId!,
        );
        deletedDeliveryIds.push(delivery.id);
      } catch {
        complete = false;
        failedDeliveries.push(delivery);
      }
    }
    await this.#repository.finishPublicationRollback({
      publicationRunId: publication.runId,
      deletedDeliveryIds,
      complete,
      ...(!complete ? { failure: { stage: 'recovery_rollback_delete' as const, errorKind: 'delete_failed' } } : {}),
      now: this.#dependencies.now(),
    });
    for (const delivery of failedDeliveries) {
      this.#dependencies.logger.error('publication_failed', {
        giveawayId: publication.giveawayId,
        stage: 'recovery_rollback_delete',
        errorKind: 'delete_failed',
        channelId: delivery.giveawayChannelId,
        channelUsername: delivery.channelUsername,
      });
    }
    return {
      giveawayId: publication.giveawayId,
      kind: complete ? ('rolled_back' as const) : ('failed' as const),
    };
  }
}
