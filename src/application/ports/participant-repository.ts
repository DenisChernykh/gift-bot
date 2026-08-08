export type ParticipantChannel = {
  id: string;
  telegramChatId: number;
  username: string;
  title: string;
};

export type ParticipantEntryTarget = {
  giveawayId: string;
  title: string;
  deadlineUtc: number;
  referralsEnabled: boolean;
  createdByTelegramId: number;
  inviterParticipantId: string | null;
  channels: ParticipantChannel[];
};

export type ParticipantStatus = {
  id: string;
  giveawayId: string;
  telegramUserId: number;
  username: string | null;
  displayName: string;
  inviterParticipantId: string | null;
  joinedAt: number;
  participantCount: number;
  directReferralCount: number;
};

export type ParticipantRegistrationResult = ParticipantStatus & {
  created: boolean;
};

export interface ParticipantRepository {
  resolveEntryToken(input: {
    kind: 'join' | 'referral';
    tokenHash: string;
    now: number;
  }): Promise<ParticipantEntryTarget | null>;
  findActiveEntryTarget(input: {
    giveawayId: string;
    inviterParticipantId: string | null;
    now: number;
  }): Promise<ParticipantEntryTarget | null>;
  findParticipant(
    giveawayId: string,
    telegramUserId: number,
  ): Promise<ParticipantStatus | null>;
  registerParticipant(input: {
    giveawayId: string;
    telegramUserId: number;
    username: string | null;
    displayName: string;
    inviterParticipantId: string | null;
    now: number;
  }): Promise<ParticipantRegistrationResult | null>;
  storeReferralToken(input: {
    tokenHash: string;
    giveawayId: string;
    inviterParticipantId: string;
    now: number;
  }): Promise<void>;
  recordBotRightsLoss(input: {
    giveawayId: string;
    giveawayChannelId: string;
    now: number;
  }): Promise<void>;
  resolveBotRightsLoss(input: {
    giveawayId: string;
    giveawayChannelId: string;
    now: number;
  }): Promise<void>;
}
