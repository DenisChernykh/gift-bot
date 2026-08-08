export type InvitationState = 'active' | 'consumed' | 'expired' | 'revoked';

export type ChannelInvitation = {
  id: string;
  giveawayId: string;
  invitedTelegramId: number | null;
  state: InvitationState;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

export type ChannelCandidate = {
  telegramChatId: number;
  username: string;
  title: string;
};

export type PendingChannelConnection = {
  id: string;
  giveawayId: string;
  inviteId: string | null;
  telegramUserId: number;
  status: 'active' | 'completed' | 'superseded';
  candidate: ChannelCandidate | null;
  createdAt: number;
  updatedAt: number;
};

export type PendingConnectionResult =
  | {
      kind: 'ready';
      context: PendingChannelConnection;
      mode: 'own' | 'external';
      inviteExpiresAt: number | null;
    }
  | {
      kind: 'switch_confirmation_required';
      current: PendingChannelConnection;
      requested: { giveawayId: string; inviteId: string | null };
    };

export type ConfirmedGiveawayChannel = {
  id: string;
  giveawayId: string;
  telegramChatId: number;
  username: string;
  title: string;
  ownerTelegramId: number;
  status: 'confirmed';
  createdAt: number;
  updatedAt: number;
};

export interface ChannelAuthorizationRepository {
  createExternalInvite(input: {
    id: string;
    giveawayId: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
  }): Promise<ChannelInvitation>;

  createOwnConnection(input: {
    id: string;
    giveawayId: string;
    telegramUserId: number;
    confirmSwitch: boolean;
    now: number;
  }): Promise<PendingConnectionResult>;

  openExternalInvite(input: {
    id: string;
    tokenHash: string;
    telegramUserId: number;
    confirmSwitch: boolean;
    now: number;
  }): Promise<PendingConnectionResult>;

  switchExternalInvite(input: {
    id: string;
    inviteId: string;
    telegramUserId: number;
    now: number;
  }): Promise<PendingConnectionResult>;

  revokeExternalInvite(input: {
    inviteId: string;
    now: number;
  }): Promise<ChannelInvitation>;

  storeChannelCandidate(input: {
    telegramUserId: number;
    ownConnectionAllowed: boolean;
    candidate: ChannelCandidate;
    now: number;
  }): Promise<
    | {
        kind: 'candidate_ready';
        candidate: ChannelCandidate;
        giveawayId: string;
        mode: 'own' | 'external';
      }
    | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
  >;

  confirmChannel(input: {
    id: string;
    telegramUserId: number;
    telegramChatId: number;
    mode: 'own' | 'external';
    now: number;
  }): Promise<
    | { kind: 'connected'; channel: ConfirmedGiveawayChannel }
    | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
  >;
}
