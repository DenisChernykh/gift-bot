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
    if (
      publication.deliveries.some((delivery) =>
        ['sending', 'unknown'].includes(delivery.status),
      )
    ) {
      await this.#repository.failPublication({
        publicationRunId: publication.runId,
        failure: { stage: 'recovery_unknown_send', errorKind: 'unknown_delivery' },
        now: this.#dependencies.now(),
      });
      this.#dependencies.logger.error('publication_failed', {
        giveawayId: publication.giveawayId,
        stage: 'recovery_unknown_send',
        errorKind: 'unknown_delivery',
        channelIds: publication.deliveries.filter((delivery) => ['sending', 'unknown', 'delivered'].includes(delivery.status)).map((delivery) => delivery.giveawayChannelId),
      });
      return { giveawayId: publication.giveawayId, kind: 'failed' as const };
    }
    if (
      publication.deliveries.length > 0 &&
      publication.deliveries.every(
        (delivery) => delivery.status === 'delivered' && delivery.messageId !== null,
      )
    ) {
      await this.#repository.activatePublication(
        publication.runId,
        this.#dependencies.now(),
      );
      return { giveawayId: publication.giveawayId, kind: 'activated' as const };
    }

    const known = publication.deliveries.filter(
      (delivery) => delivery.status === 'delivered' && delivery.messageId !== null,
    );
    const deletedDeliveryIds: string[] = [];
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
      }
    }
    await this.#repository.finishPublicationRollback({
      publicationRunId: publication.runId,
      deletedDeliveryIds,
      complete,
      ...(!complete ? { failure: { stage: 'recovery_rollback_delete' as const, errorKind: 'delete_failed' } } : {}),
      now: this.#dependencies.now(),
    });
    if (!complete) this.#dependencies.logger.error('publication_failed', {
      giveawayId: publication.giveawayId,
      stage: 'recovery_rollback_delete',
      errorKind: 'delete_failed',
      channelIds: known.map((delivery) => delivery.giveawayChannelId),
    });
    return {
      giveawayId: publication.giveawayId,
      kind: complete ? ('rolled_back' as const) : ('failed' as const),
    };
  }
}
