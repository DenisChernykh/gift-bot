import { hasPublicationAdministratorRights } from '../domain/channel-rights.js';
import { renderGiveawayMessage } from '../domain/giveaway-rendering.js';
import { createStoredToken } from '../domain/tokens.js';
import type {
  GiveawayLifecycleRepository,
  PublicationFailureDiagnostic,
  PublicationDelivery,
  PublicationGiveaway,
} from './ports/giveaway-lifecycle-repository.js';
import {
  TelegramDeliveryError,
  type TelegramGateway,
  type TelegramGiveawayMessage,
  type TelegramMessageEntity,
} from './ports/telegram-gateway.js';

type PublicationDependencies = {
  botUsername: string;
  createId: (kind: 'publication_run' | 'delivery') => string;
  createToken: typeof createStoredToken;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  maximumRateLimitRetries: number;
  logger: { error(event: string, fields?: Record<string, unknown>): void };
};

const defaultDependencies: Omit<PublicationDependencies, 'botUsername'> = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
  createToken: createStoredToken,
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maximumRateLimitRetries: 3,
  logger: { error: () => undefined },
};

export type PublicationResult =
  | { kind: 'active'; giveawayId: string }
  | { kind: 'already_active'; giveawayId: string }
  | { kind: 'publishing'; giveawayId: string }
  | { kind: 'rolled_back'; giveawayId: string }
  | { kind: 'failed'; giveawayId: string; diagnostic: PublicationFailureDiagnostic };

export class GiveawayPublicationService {
  readonly #repository: GiveawayLifecycleRepository;
  readonly #gateway: TelegramGateway;
  readonly #dependencies: PublicationDependencies;

  constructor(
    repository: GiveawayLifecycleRepository,
    gateway: TelegramGateway,
    dependencies: Partial<PublicationDependencies> & Pick<PublicationDependencies, 'botUsername'>,
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async publish(giveawayId: string): Promise<PublicationResult> {
    const giveaway = await this.#repository.getPublicationGiveaway(giveawayId);
    if (giveaway.state === 'active') {
      return { kind: 'already_active', giveawayId };
    }
    if (giveaway.state === 'publishing') {
      return { kind: 'publishing', giveawayId };
    }
    if (giveaway.state !== 'draft') {
      throw new Error(`Giveaway cannot be published from ${giveaway.state}`);
    }
    if (giveaway.channels.length === 0) {
      throw new Error('At least one confirmed channel is required');
    }

    for (const channel of giveaway.channels) {
      const membership = await this.#gateway.getChannelMembership(
        channel.telegramChatId,
      );
      if (!hasPublicationAdministratorRights(membership)) {
        const diagnostic: PublicationFailureDiagnostic = {
          stage: 'preflight',
          errorKind: 'missing_publication_rights',
          channel,
        };
        this.#logFailure(giveawayId, diagnostic);
        throw new PublicationFailureError(diagnostic);
      }
    }

    const publicationRunId = this.#dependencies.createId('publication_run');
    const deliveries = giveaway.channels.map((channel) => ({
      id: this.#dependencies.createId('delivery'),
      giveawayChannelId: channel.id,
    }));
    const joinToken = this.#dependencies.createToken();
    const message = this.#renderMessage(giveaway, joinToken.token);
    const begin = await this.#repository.beginPublication({
      giveawayId,
      publicationRunId,
      joinTokenHash: joinToken.tokenHash,
      deliveries,
      now: this.#dependencies.now(),
    });
    if (begin.kind === 'already_active') {
      return { kind: 'already_active', giveawayId };
    }
    if (begin.kind === 'already_publishing') {
      return { kind: 'publishing', giveawayId };
    }

    const deliveryByChannelId = new Map(
      deliveries.map((delivery) => [delivery.giveawayChannelId, delivery]),
    );
    const knownDeliveries: PublicationDelivery[] = [];

    for (const channel of giveaway.channels) {
      const delivery = deliveryByChannelId.get(channel.id);
      if (!delivery) throw new Error('Missing publication delivery intent');

      try {
        const sent = await this.#sendWithRateLimitRetry(
          {
            ...message,
            chatId: channel.telegramChatId,
          },
          delivery.id,
        );
        await this.#repository.savePublicationDelivery({
          deliveryId: delivery.id,
          messageId: sent.messageId,
          messageKind: message.kind,
          now: this.#dependencies.now(),
        });
        knownDeliveries.push({
          id: delivery.id,
          giveawayChannelId: channel.id,
          telegramChatId: channel.telegramChatId,
          status: 'delivered',
          messageId: sent.messageId,
          messageKind: message.kind,
        });
      } catch (error) {
        if (!(error instanceof TelegramDeliveryError) || error.outcome === 'unknown') {
          const diagnostic: PublicationFailureDiagnostic = {
            stage: 'send_unknown',
            errorKind: error instanceof TelegramDeliveryError ? 'telegram_unknown' : 'unexpected_error',
            channel,
          };
          await this.#repository.markPublicationDeliveryUnknown(
            delivery.id,
            this.#dependencies.now(),
          );
          await this.#repository.failPublication({ publicationRunId, failure: diagnostic, now: this.#dependencies.now() });
          this.#logFailure(giveawayId, diagnostic);
          return { kind: 'failed', giveawayId, diagnostic };
        }

        return this.#rollback(
          giveawayId,
          publicationRunId,
          knownDeliveries,
        );
      }
    }

    await this.#repository.activatePublication(
      publicationRunId,
      this.#dependencies.now(),
    );
    return { kind: 'active', giveawayId };
  }

  async #sendWithRateLimitRetry(
    input: TelegramGiveawayMessage,
    deliveryId: string,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#repository.markPublicationDeliverySending(
          deliveryId,
          this.#dependencies.now(),
        );
        return await this.#gateway.sendGiveawayMessage(input);
      } catch (error) {
        if (
          !(error instanceof TelegramDeliveryError) ||
          error.outcome !== 'definite' ||
          error.retryAfterMs === null ||
          attempt >= this.#dependencies.maximumRateLimitRetries
        ) {
          throw error;
        }
        await this.#dependencies.sleep(error.retryAfterMs);
      }
    }
  }

  async #rollback(
    giveawayId: string,
    publicationRunId: string,
    knownDeliveries: PublicationDelivery[],
  ): Promise<PublicationResult> {
    const deletedDeliveryIds: string[] = [];
    let complete = true;
    let failure: PublicationFailureDiagnostic | undefined;
    for (const delivery of [...knownDeliveries].reverse()) {
      try {
        await this.#gateway.deleteMessage(
          delivery.telegramChatId,
          delivery.messageId!,
        );
        deletedDeliveryIds.push(delivery.id);
      } catch {
        complete = false;
        const channel = await this.#channelForDelivery(giveawayId, delivery.giveawayChannelId);
        failure = { stage: 'rollback_delete', errorKind: 'delete_failed', ...(channel ? { channel } : {}) };
      }
    }
    await this.#repository.finishPublicationRollback({
      publicationRunId,
      deletedDeliveryIds,
      complete,
      ...(failure ? { failure } : {}),
      now: this.#dependencies.now(),
    });
    if (complete) return { kind: 'rolled_back', giveawayId };
    const diagnostic = failure!;
    this.#logFailure(giveawayId, diagnostic);
    return { kind: 'failed', giveawayId, diagnostic };
  }

  async #channelForDelivery(giveawayId: string, channelId: string) {
    const giveaway = await this.#repository.getPublicationGiveaway(giveawayId);
    return giveaway.channels.find((channel) => channel.id === channelId);
  }

  #logFailure(giveawayId: string, diagnostic: PublicationFailureDiagnostic) {
    this.#dependencies.logger.error('publication_failed', {
      giveawayId,
      stage: diagnostic.stage,
      errorKind: diagnostic.errorKind,
      ...(diagnostic.channel ? { channelId: diagnostic.channel.id, channelUsername: diagnostic.channel.username } : {}),
    });
  }

  #renderMessage(
    giveaway: PublicationGiveaway,
    joinToken: string,
  ): Omit<TelegramGiveawayMessage, 'chatId'> {
    const rendered = renderGiveawayMessage(giveaway);
    const sourceEntities = giveaway.content.entities ?? [];
    const contentOffset = giveaway.title.length + 2;
    const entities: TelegramMessageEntity[] = sourceEntities.map((entity) => ({
      ...entity,
      offset: entity.offset + contentOffset,
    }));
    return {
      kind: rendered.kind,
      text: rendered.text,
      entities,
      photoFileId:
        giveaway.content.kind === 'photo' ? (giveaway.content.fileId ?? null) : null,
      joinUrl: `https://t.me/${this.#dependencies.botUsername}?start=join_${joinToken}`,
    };
  }
}

export class PublicationFailureError extends Error {
  constructor(readonly diagnostic: PublicationFailureDiagnostic) {
    super(
      diagnostic.channel
        ? `Channel @${diagnostic.channel.username} is missing publication rights`
        : `Publication failed at ${diagnostic.stage}`,
    );
  }
}
