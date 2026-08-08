import {
  hasPublicationAdministratorRights,
  type TelegramChannelMembership,
} from '../domain/channel-rights.js';
import { createStoredToken, hashToken } from '../domain/tokens.js';
import type {
  ChannelAuthorizationRepository,
  ChannelInvitation,
} from './ports/channel-authorization-repository.js';

const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

type ChannelAuthorizationDependencies = {
  createId: (kind: 'invite' | 'connection' | 'channel') => string;
  createToken: typeof createStoredToken;
  now: () => number;
};

const defaultDependencies: ChannelAuthorizationDependencies = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
  createToken: createStoredToken,
  now: Date.now,
};

export class ChannelAuthorizationService {
  readonly #repository: ChannelAuthorizationRepository;
  readonly #dependencies: ChannelAuthorizationDependencies;

  constructor(
    repository: ChannelAuthorizationRepository,
    dependencies: Partial<ChannelAuthorizationDependencies> = {},
  ) {
    this.#repository = repository;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async createExternalInvite(
    giveawayId: string,
  ): Promise<ChannelInvitation & { token: string }> {
    const now = this.#dependencies.now();
    const { token, tokenHash } = this.#dependencies.createToken();
    const invite = await this.#repository.createExternalInvite({
      id: this.#dependencies.createId('invite'),
      giveawayId,
      tokenHash,
      expiresAt: now + INVITATION_LIFETIME_MS,
      now,
    });
    return { ...invite, token };
  }

  async createOwnConnection(input: {
    giveawayId: string;
    telegramUserId: number;
    confirmSwitch?: boolean;
  }) {
    return this.#repository.createOwnConnection({
      id: this.#dependencies.createId('connection'),
      giveawayId: input.giveawayId,
      telegramUserId: input.telegramUserId,
      confirmSwitch: input.confirmSwitch ?? false,
      now: this.#dependencies.now(),
    });
  }

  async openExternalInvite(input: {
    token: string;
    telegramUserId: number;
    confirmSwitch?: boolean;
  }) {
    return this.#repository.openExternalInvite({
      id: this.#dependencies.createId('connection'),
      tokenHash: hashToken(input.token),
      telegramUserId: input.telegramUserId,
      confirmSwitch: input.confirmSwitch ?? false,
      now: this.#dependencies.now(),
    });
  }

  async switchExternalInvite(input: {
    inviteId: string;
    telegramUserId: number;
  }) {
    return this.#repository.switchExternalInvite({
      id: this.#dependencies.createId('connection'),
      inviteId: input.inviteId,
      telegramUserId: input.telegramUserId,
      now: this.#dependencies.now(),
    });
  }

  async revokeExternalInvite(inviteId: string): Promise<ChannelInvitation> {
    return this.#repository.revokeExternalInvite({
      inviteId,
      now: this.#dependencies.now(),
    });
  }

  async observeChannel(input: {
    telegramUserId: number;
    ownConnectionAllowed: boolean;
    telegramChatId: number;
    username: string | null;
    title: string;
    membership: TelegramChannelMembership;
  }) {
    const username = input.username?.trim().replace(/^@/, '').toLowerCase();
    if (!username) {
      throw new Error('Channel must have a public username');
    }
    if (!hasPublicationAdministratorRights(input.membership)) {
      throw new Error('Bot requires post, edit, and delete administrator rights');
    }

    return this.#repository.storeChannelCandidate({
      telegramUserId: input.telegramUserId,
      ownConnectionAllowed: input.ownConnectionAllowed,
      candidate: {
        telegramChatId: input.telegramChatId,
        username,
        title: input.title,
      },
      now: this.#dependencies.now(),
    });
  }

  async confirmChannel(input: {
    telegramUserId: number;
    telegramChatId: number;
    mode: 'own' | 'external';
  }) {
    return this.#repository.confirmChannel({
      id: this.#dependencies.createId('channel'),
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      mode: input.mode,
      now: this.#dependencies.now(),
    });
  }
}
