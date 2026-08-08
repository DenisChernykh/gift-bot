import type { TelegramChannelMembership } from '../../domain/channel-rights.js';
import type { GiveawayMessageEntity } from '../../domain/giveaway-validation.js';

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

export type TelegramDeliveryOutcome = 'definite' | 'unknown';

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
  getChannelMembership(chatId: number): Promise<TelegramChannelMembership>;
  sendGiveawayMessage(
    input: TelegramGiveawayMessage,
  ): Promise<{ messageId: number }>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  editCancelledMessage(input: TelegramCancelledMessage): Promise<void>;
}
