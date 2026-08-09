import type { TelegramChannelMembership } from '../../domain/channel-rights.js';
import type { GiveawayMessageEntity } from '../../domain/giveaway-validation.js';
import type { ParticipantMembership } from '../../domain/participant-rules.js';

export type TelegramMessageEntity = GiveawayMessageEntity;

export type TelegramGiveawayMessage = {
  chatId: number;
  kind: 'text' | 'photo';
  text: string;
  entities: TelegramMessageEntity[];
  photoFileId: string | null;
  joinUrl: string;
};

export type TelegramCancelledMessage = {
  chatId: number;
  messageId: number;
  kind: 'text' | 'photo';
  text: string;
};

type TelegramPostEditBase = {
  chatId: number;
  messageId: number;
  kind: 'text' | 'photo';
  text: string;
  entities: TelegramMessageEntity[];
};

export type TelegramPostEdit = TelegramPostEditBase &
  (
    | { removeParticipationButton: true }
    | { removeParticipationButton: false; joinUrl: string }
  );

export type TelegramDeliveryOutcome = 'definite' | 'unknown';

export type TelegramChannelSnapshot = {
  username: string | null;
  title: string;
  membership: TelegramChannelMembership;
};

export class TelegramDeliveryError extends Error {
  readonly outcome: TelegramDeliveryOutcome;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    outcome: TelegramDeliveryOutcome,
    retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TelegramDeliveryError';
    this.outcome = outcome;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TelegramGateway {
  getChannelSnapshot(chatId: number): Promise<TelegramChannelSnapshot>;
  getParticipantMembership(
    chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership>;
  sendGiveawayMessage(
    input: TelegramGiveawayMessage,
  ): Promise<{ messageId: number }>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  editCancelledMessage(input: TelegramCancelledMessage): Promise<void>;
  editGiveawayPost(input: TelegramPostEdit): Promise<void>;
  sendDirectMessage(chatId: number, text: string): Promise<void>;
}
