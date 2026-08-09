import type { PublicationGiveaway } from './giveaway-lifecycle-repository.js';

export type FailedPublicationChannel = {
  id: string;
  username: string;
  telegramChatId: number;
  messageId: number | null;
};

export type GiveawayListItem = {
  id: string;
  title: string;
  state: string;
  updatedAt: number;
  participantCount: number;
  referralsEnabled: boolean;
  synchronizationState: 'up_to_date' | 'pending' | 'processing' | 'failed';
  warnings: Array<{
    channelId: string;
    username: string;
    title: string;
  }>;
  failure?: {
    stage: string;
    errorKind: string;
    channels: FailedPublicationChannel[];
  };
  drawFailure?: {
    stage: string;
    errorKind: string;
    channel?: {
      id: string;
      telegramChatId: number;
      username: string;
      title: string;
    };
  };
  notificationDelivery?: {
    pendingCount: number;
    failedCount: number;
  };
};

export type CancellationTarget =
  | { kind: 'wizard' }
  | {
      kind: 'giveaway';
      giveawayId: string;
      title: string;
      state: 'draft' | 'active' | 'failed';
    };

export interface GiveawayManagementRepository {
  listGiveaways(administratorTelegramId: number): Promise<GiveawayListItem[]>;
  getGiveawaySummary(giveawayId: string): Promise<PublicationGiveaway>;
  listCancellationTargets(
    administratorTelegramId: number,
  ): Promise<CancellationTarget[]>;
  cancelUnmaterializedWizard(input: {
    administratorTelegramId: number;
    now: number;
  }): Promise<boolean>;
}
