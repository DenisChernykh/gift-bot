import type { GiveawayContent } from '../../domain/giveaway-validation.js';

export type PublicationChannel = {
  id: string;
  telegramChatId: number;
  username: string;
  title: string;
};

export type PublicationGiveaway = {
  id: string;
  title: string;
  state: string;
  winnerCount: number;
  deadlineUtc: number;
  referralsEnabled: boolean;
  content: GiveawayContent;
  channels: PublicationChannel[];
};

export type PublicationDelivery = {
  id: string;
  giveawayChannelId: string;
  channelUsername: string;
  telegramChatId: number;
  status: string;
  messageId: number | null;
  messageKind: 'text' | 'photo' | null;
};

export type PublicationFailureStage = 'send_unknown' | 'rollback_delete' | 'recovery_unknown_send' | 'recovery_rollback_delete';

export type PublicationFailureDiagnostic = {
  stage: PublicationFailureStage | 'preflight';
  errorKind: string;
  channel?: PublicationChannel;
};

export type RecoverablePublication = {
  runId: string;
  giveawayId: string;
  deliveries: PublicationDelivery[];
};

export type CancellationSyncTask = {
  id: string;
  giveawayId: string;
  giveawayChannelId: string;
  chatId: number;
  messageId: number;
  messageKind: 'text' | 'photo';
  text: string;
  attempts: number;
};

export type BeginPublicationResult =
  | { kind: 'started' }
  | { kind: 'already_active' }
  | { kind: 'already_publishing' };

export type PrepareCancellationResult =
  | { kind: 'cancelled'; tasks: CancellationSyncTask[] }
  | { kind: 'already_cancelled'; tasks: CancellationSyncTask[] };

export interface GiveawayLifecycleRepository {
  getPublicationGiveaway(giveawayId: string): Promise<PublicationGiveaway>;
  beginPublication(input: {
    giveawayId: string;
    publicationRunId: string;
    joinTokenHash: string;
    deliveries: Array<{ id: string; giveawayChannelId: string }>;
    now: number;
  }): Promise<BeginPublicationResult>;
  markPublicationDeliverySending(deliveryId: string, now: number): Promise<void>;
  savePublicationDelivery(input: {
    deliveryId: string;
    messageId: number;
    messageKind: 'text' | 'photo';
    now: number;
  }): Promise<void>;
  markPublicationDeliveryUnknown(deliveryId: string, now: number): Promise<void>;
  activatePublication(publicationRunId: string, now: number): Promise<void>;
  finishPublicationRollback(input: {
    publicationRunId: string;
    deletedDeliveryIds: string[];
    complete: boolean;
    failure?: PublicationFailureDiagnostic;
    now: number;
  }): Promise<void>;
  failPublication(input: {
    publicationRunId: string;
    failure: PublicationFailureDiagnostic;
    now: number;
  }): Promise<void>;
  listRecoverablePublications(): Promise<RecoverablePublication[]>;
  getCancellationTargetCount(giveawayId: string): Promise<number>;
  prepareCancellation(input: {
    giveawayId: string;
    syncTaskIds: string[];
    now: number;
  }): Promise<PrepareCancellationResult>;
  listPendingCancellationSyncTasks(): Promise<CancellationSyncTask[]>;
  completeCancellationSyncTask(id: string, now: number): Promise<void>;
  failCancellationSyncTask(id: string, now: number): Promise<void>;
}
