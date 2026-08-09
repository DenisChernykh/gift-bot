import type {
  DrawChannel,
  DrawRepository,
  DrawTarget,
} from './ports/draw-repository.js';
import {
  TelegramDeliveryError,
  type TelegramChannelSnapshot,
} from './ports/telegram-gateway.js';
import { hasPublicationAdministratorRights } from '../domain/channel-rights.js';
import {
  createDrawSnapshot,
  selectInitialWinners,
  type EligibleDrawParticipant,
} from '../domain/giveaway-draw.js';
import {
  isEligibleParticipantMembership,
  type ParticipantMembership,
} from '../domain/participant-rules.js';

type DrawMembershipGateway = {
  getChannelSnapshot(chatId: number): Promise<TelegramChannelSnapshot>;
  getParticipantMembership(
    chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership>;
};

type GiveawayDrawDependencies = {
  now: () => number;
  randomInt: (maximumExclusive: number) => number;
  sleep: (milliseconds: number) => Promise<void>;
  membershipConcurrency: number;
  teamTelegramIds: readonly number[];
};

const defaultDependencies: Omit<
  GiveawayDrawDependencies,
  'randomInt' | 'teamTelegramIds'
> = {
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  membershipConcurrency: 10,
};

class FinalEligibilityError extends Error {
  readonly errorKind: string;
  readonly channel: DrawChannel | undefined;

  constructor(
    errorKind: string,
    channel?: DrawChannel,
    options?: ErrorOptions,
  ) {
    super(errorKind, options);
    this.name = 'FinalEligibilityError';
    this.errorKind = errorKind;
    this.channel = channel;
  }
}

export class GiveawayDrawService {
  readonly #repository: DrawRepository;
  readonly #gateway: DrawMembershipGateway;
  readonly #dependencies: GiveawayDrawDependencies;

  constructor(
    repository: DrawRepository,
    gateway: DrawMembershipGateway,
    dependencies: Partial<GiveawayDrawDependencies> &
      Pick<GiveawayDrawDependencies, 'randomInt' | 'teamTelegramIds'>,
  ) {
    const merged = { ...defaultDependencies, ...dependencies };
    if (
      !Number.isInteger(merged.membershipConcurrency) ||
      merged.membershipConcurrency < 1
    ) {
      throw new Error('Draw membership concurrency must be a positive integer');
    }
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = merged;
  }

  async processDue(): Promise<number> {
    let processed = 0;
    while (true) {
      const target = await this.#repository.claimNextDue(
        this.#dependencies.now(),
      );
      if (!target) return processed;
      await this.#process(target);
      processed += 1;
    }
  }

  async recoverDrawing(): Promise<number> {
    const targets = await this.#repository.listDrawing();
    for (const target of targets) await this.#process(target);
    return targets.length;
  }

  async retryFailed(giveawayId: string): Promise<boolean> {
    const retried = await this.#repository.retryFailedDraw(
      giveawayId,
      this.#dependencies.now(),
    );
    if (!retried) return false;
    const target = await this.#repository.getDrawing(giveawayId);
    if (!target) throw new Error('Retried draw is unavailable');
    await this.#process(target);
    return true;
  }

  async #process(target: DrawTarget): Promise<void> {
    let failureStage = target.snapshot
      ? 'selection_recovery'
      : 'final_eligibility';
    try {
      const snapshot =
        target.snapshot ??
        (await this.#repository.saveSnapshot({
          giveawayId: target.id,
          snapshot: createDrawSnapshot({
            participants: await this.#eligibleParticipants(target),
            referralsEnabled: target.referralsEnabled,
            winnerCount: target.winnerCount,
            createdAt: this.#dependencies.now(),
            randomInt: this.#dependencies.randomInt,
          }),
          now: this.#dependencies.now(),
        }));
      if (!target.snapshot) failureStage = 'selection';
      const selected = selectInitialWinners(snapshot);
      await this.#repository.completeDraw({
        giveawayId: target.id,
        ...selected,
        teamTelegramIds: this.#dependencies.teamTelegramIds,
        now: this.#dependencies.now(),
      });
    } catch (error) {
      const classified =
        error instanceof FinalEligibilityError
          ? error.errorKind
          : error instanceof TelegramDeliveryError
            ? telegramErrorKind(error)
            : 'unexpected';
      await this.#repository.failDraw({
        giveawayId: target.id,
        stage: failureStage,
        errorKind: classified,
        ...(error instanceof FinalEligibilityError && error.channel
          ? { channel: error.channel }
          : {}),
        teamTelegramIds: this.#dependencies.teamTelegramIds,
        now: this.#dependencies.now(),
      });
    }
  }

  async #eligibleParticipants(
    target: DrawTarget,
  ): Promise<EligibleDrawParticipant[]> {
    if (target.channels.length === 0) {
      throw new FinalEligibilityError('channel_missing');
    }
    for (const channel of target.channels) {
      const snapshot = await this.#channelCall(channel, () =>
        this.#gateway.getChannelSnapshot(channel.telegramChatId),
      );
      if (!snapshot.username) {
        throw new FinalEligibilityError('channel_username_missing', channel);
      }
      if (!hasPublicationAdministratorRights(snapshot.membership)) {
        throw new FinalEligibilityError('bot_admin_rights_lost', channel);
      }
    }

    const eligibility = new Map(
      target.participants.map((participant) => [
        participant.participantId,
        true,
      ]),
    );
    const checks = target.participants.flatMap((participant) =>
      target.channels.map((channel) => ({ participant, channel })),
    );
    await mapWithConcurrency(
      checks,
      this.#dependencies.membershipConcurrency,
      async ({ participant, channel }) => {
        const membership = await this.#channelCall(channel, () =>
          this.#gateway.getParticipantMembership(
            channel.telegramChatId,
            participant.telegramUserId,
          ),
        );
        if (membership.status === 'unknown') {
          throw new FinalEligibilityError('membership_unknown', channel);
        }
        if (!isEligibleParticipantMembership(membership)) {
          eligibility.set(participant.participantId, false);
        }
      },
    );
    return target.participants.filter(
      (participant) => eligibility.get(participant.participantId) === true,
    );
  }

  async #telegramCall<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof TelegramDeliveryError) ||
          !isRetryableTelegramError(error) ||
          attempt === 3
        ) {
          throw error;
        }
        await this.#dependencies.sleep(error.retryAfterMs ?? attempt * 250);
      }
    }
    throw new Error('Unreachable Telegram retry state');
  }

  async #channelCall<Result>(
    channel: DrawChannel,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.#telegramCall(operation);
    } catch (error) {
      if (error instanceof TelegramDeliveryError) {
        throw new FinalEligibilityError(
          telegramErrorKind(error),
          channel,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

function isRetryableTelegramError(error: TelegramDeliveryError): boolean {
  return ['rate_limited', 'server', 'network'].includes(error.kind);
}

function telegramErrorKind(error: TelegramDeliveryError): string {
  return `telegram_${error.kind}`;
}

async function mapWithConcurrency<Input>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let hasFailure = false;
  let firstFailure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (!hasFailure && cursor < inputs.length) {
        const index = cursor;
        cursor += 1;
        try {
          await operation(inputs[index]!);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (hasFailure) throw firstFailure;
}
