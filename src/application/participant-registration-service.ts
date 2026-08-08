import type { TelegramChannelSnapshot, TelegramDeliveryError } from './ports/telegram-gateway.js';
import type {
  ParticipantEntryTarget,
  ParticipantRepository,
  ParticipantStatus,
} from './ports/participant-repository.js';
import {
  calculateTicketCount,
  isEligibleParticipantMembership,
  type ParticipantMembership,
} from '../domain/participant-rules.js';
import { createStoredToken, hashToken } from '../domain/tokens.js';

export type ParticipantIdentity = {
  telegramUserId: number;
  username: string | null;
  displayName: string;
};

type ParticipantMembershipGateway = {
  getChannelSnapshot(chatId: number): Promise<TelegramChannelSnapshot>;
  getParticipantMembership(
    chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership>;
};

type ParticipantRegistrationDependencies = {
  botUsername: string;
  createToken: typeof createStoredToken;
  now: () => number;
};

export type ParticipantRegistrationResult =
  | { kind: 'unavailable' }
  | {
      kind: 'missing_memberships';
      giveawayId: string;
      inviterParticipantId: string | null;
      channels: ParticipantEntryTarget['channels'];
    }
  | {
      kind: 'retry_later';
      giveawayId: string;
      inviterParticipantId: string | null;
      retryAfterMs: number | null;
    }
  | {
      kind: 'registered';
      created: boolean;
      giveawayId: string;
      title: string;
      participantId: string;
      participantCount: number;
      directReferralCount: number;
      ticketCount: number;
      joinedAt: number;
      referralToken?: string;
      referralUrl?: string;
    };

const defaultDependencies: Omit<ParticipantRegistrationDependencies, 'botUsername'> = {
  createToken: createStoredToken,
  now: Date.now,
};

export class ParticipantRegistrationService {
  readonly #repository: ParticipantRepository;
  readonly #gateway: ParticipantMembershipGateway;
  readonly #dependencies: ParticipantRegistrationDependencies;

  constructor(
    repository: ParticipantRepository,
    gateway: ParticipantMembershipGateway,
    dependencies: Partial<ParticipantRegistrationDependencies> &
      Pick<ParticipantRegistrationDependencies, 'botUsername'>,
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async joinWithToken(input: {
    kind: 'join' | 'referral';
    token: string;
    user: ParticipantIdentity;
  }): Promise<ParticipantRegistrationResult> {
    const target = await this.#repository.resolveEntryToken({
      kind: input.kind,
      tokenHash: hashToken(input.token),
      now: this.#dependencies.now(),
    });
    if (!target) return { kind: 'unavailable' };
    return this.#attempt(target, input.user);
  }

  async recheck(input: {
    giveawayId: string;
    inviterParticipantId: string | null;
    user: ParticipantIdentity;
  }): Promise<ParticipantRegistrationResult> {
    const target = await this.#repository.findActiveEntryTarget({
      giveawayId: input.giveawayId,
      inviterParticipantId: input.inviterParticipantId,
      now: this.#dependencies.now(),
    });
    if (!target) return { kind: 'unavailable' };
    return this.#attempt(target, input.user);
  }

  async #attempt(
    target: ParticipantEntryTarget,
    user: ParticipantIdentity,
  ): Promise<ParticipantRegistrationResult> {
    const existing = await this.#repository.findParticipant(
      target.giveawayId,
      user.telegramUserId,
    );
    if (existing) {
      const refreshed = await this.#repository.registerParticipant({
        giveawayId: target.giveawayId,
        ...user,
        inviterParticipantId: target.inviterParticipantId,
        now: this.#dependencies.now(),
      });
      return refreshed
        ? this.#registeredResult(target, refreshed, false)
        : { kind: 'unavailable' };
    }

    const missingChannels: ParticipantEntryTarget['channels'] = [];
    let botRightsLost = false;
    for (const channel of target.channels) {
      try {
        const snapshot = await this.#gateway.getChannelSnapshot(
          channel.telegramChatId,
        );
        if (snapshot.membership.status !== 'administrator') {
          await this.#repository.recordBotRightsLoss({
            giveawayId: target.giveawayId,
            giveawayChannelId: channel.id,
            now: this.#dependencies.now(),
          });
          botRightsLost = true;
          continue;
        }
        await this.#repository.resolveBotRightsLoss({
          giveawayId: target.giveawayId,
          giveawayChannelId: channel.id,
          now: this.#dependencies.now(),
        });
        const membership = await this.#gateway.getParticipantMembership(
          channel.telegramChatId,
          user.telegramUserId,
        );
        if (!isEligibleParticipantMembership(membership)) {
          missingChannels.push(channel);
        }
      } catch (error) {
        return {
          kind: 'retry_later',
          giveawayId: target.giveawayId,
          inviterParticipantId: target.inviterParticipantId,
          retryAfterMs: telegramRetryAfter(error),
        };
      }
    }
    if (botRightsLost) {
      return {
        kind: 'retry_later',
        giveawayId: target.giveawayId,
        inviterParticipantId: target.inviterParticipantId,
        retryAfterMs: null,
      };
    }
    if (missingChannels.length > 0) {
      return {
        kind: 'missing_memberships',
        giveawayId: target.giveawayId,
        inviterParticipantId: target.inviterParticipantId,
        channels: missingChannels,
      };
    }

    const registered = await this.#repository.registerParticipant({
      giveawayId: target.giveawayId,
      ...user,
      inviterParticipantId: target.inviterParticipantId,
      now: this.#dependencies.now(),
    });
    return registered
      ? this.#registeredResult(target, registered, registered.created)
      : { kind: 'unavailable' };
  }

  async #registeredResult(
    target: ParticipantEntryTarget,
    participant: ParticipantStatus,
    created: boolean,
  ): Promise<Extract<ParticipantRegistrationResult, { kind: 'registered' }>> {
    let referral: { token: string; url: string } | undefined;
    if (target.referralsEnabled) {
      const stored = this.#dependencies.createToken();
      const persisted = await this.#repository.storeReferralToken({
        tokenHash: stored.tokenHash,
        giveawayId: target.giveawayId,
        inviterParticipantId: participant.id,
        now: this.#dependencies.now(),
      });
      if (persisted) {
        referral = {
          token: stored.token,
          url: `https://t.me/${this.#dependencies.botUsername}?start=ref_${stored.token}`,
        };
      }
    }
    return {
      kind: 'registered',
      created,
      giveawayId: target.giveawayId,
      title: target.title,
      participantId: participant.id,
      participantCount: participant.participantCount,
      directReferralCount: participant.directReferralCount,
      ticketCount: calculateTicketCount(participant.directReferralCount),
      joinedAt: participant.joinedAt,
      ...(referral
        ? { referralToken: referral.token, referralUrl: referral.url }
        : {}),
    };
  }
}

function telegramRetryAfter(error: unknown): number | null {
  const typed = error as Partial<TelegramDeliveryError>;
  return typeof typed.retryAfterMs === 'number' ? typed.retryAfterMs : null;
}
