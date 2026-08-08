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
  failure?: {
    stage: string;
    errorKind: string;
    channels: FailedPublicationChannel[];
  };
};

export type JoinLinkTarget = {
  id: string;
  title: string;
  giveawayState: string;
  tokenState: string;
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
  findJoinLinkTarget(tokenHash: string): Promise<JoinLinkTarget | null>;
  listCancellationTargets(
    administratorTelegramId: number,
  ): Promise<CancellationTarget[]>;
  cancelUnmaterializedWizard(input: {
    administratorTelegramId: number;
    now: number;
  }): Promise<boolean>;
}
