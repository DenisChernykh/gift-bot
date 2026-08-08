export type PendingChannelHealthAlert = {
  id: string;
  giveawayId: string;
  giveawayTitle: string;
  channelUsername: string;
  channelTitle: string;
  createdByTelegramId: number;
};

export interface ChannelHealthAlertRepository {
  listPendingBotRightsAlerts(): Promise<PendingChannelHealthAlert[]>;
  markBotRightsAlertNotified(id: string, notifiedAt: number): Promise<void>;
}
