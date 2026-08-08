import { GrammyError, HttpError, type Api } from 'grammy';

import type { TelegramChannelMembership } from '../domain/channel-rights.js';
import {
  TelegramDeliveryError,
  type TelegramCancelledMessage,
  type TelegramGateway,
  type TelegramGiveawayMessage,
} from '../application/ports/telegram-gateway.js';

export function classifyTelegramError(error: unknown): TelegramDeliveryError {
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters.retry_after;
    if (error.error_code === 429 && retryAfter !== undefined) {
      return new TelegramDeliveryError(
        error.description,
        'definite',
        retryAfter * 1000,
        { cause: error },
      );
    }
    if (error.error_code >= 400 && error.error_code < 500) {
      return new TelegramDeliveryError(error.description, 'definite', null, {
        cause: error,
      });
    }
    return new TelegramDeliveryError(error.description, 'unknown', null, {
      cause: error,
    });
  }
  if (error instanceof HttpError) {
    return new TelegramDeliveryError(error.message, 'unknown', null, {
      cause: error,
    });
  }
  return new TelegramDeliveryError('Unexpected Telegram failure', 'unknown', null, {
    cause: error,
  });
}

export class GrammyTelegramGateway implements TelegramGateway {
  readonly #api: Api;
  readonly #botTelegramId: number;

  constructor(api: Api, botTelegramId: number) {
    this.#api = api;
    this.#botTelegramId = botTelegramId;
  }

  async getChannelMembership(chatId: number): Promise<TelegramChannelMembership> {
    const member = await this.#call(() =>
      this.#api.getChatMember(chatId, this.#botTelegramId),
    );
    return {
      status: member.status,
      canPostMessages:
        member.status === 'administrator' && (member.can_post_messages ?? false),
      canEditMessages:
        member.status === 'administrator' && (member.can_edit_messages ?? false),
      canDeleteMessages:
        member.status === 'administrator' && (member.can_delete_messages ?? false),
    };
  }

  async sendGiveawayMessage(
    input: TelegramGiveawayMessage,
  ): Promise<{ messageId: number }> {
    if (input.kind === 'photo') {
      if (!input.photoFileId) {
        throw new TelegramDeliveryError('Photo file_id is missing', 'definite');
      }
      const message = await this.#call(() =>
        this.#api.sendPhoto(input.chatId, input.photoFileId!, {
          caption: input.text,
          caption_entities: input.entities,
          reply_markup: participationKeyboard(input.joinUrl),
        }),
      );
      return { messageId: message.message_id };
    }
    const message = await this.#call(() =>
      this.#api.sendMessage(input.chatId, input.text, {
        entities: input.entities,
        reply_markup: participationKeyboard(input.joinUrl),
      }),
    );
    return { messageId: message.message_id };
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.#call(() => this.#api.deleteMessage(chatId, messageId));
  }

  async editCancelledMessage(input: TelegramCancelledMessage): Promise<void> {
    if (input.kind === 'photo') {
      await this.#call(() =>
        this.#api.editMessageCaption(input.chatId, input.messageId, {
          caption: input.text,
          reply_markup: { inline_keyboard: [] },
        }),
      );
      return;
    }
    await this.#call(() =>
      this.#api.editMessageText(input.chatId, input.messageId, input.text, {
        reply_markup: { inline_keyboard: [] },
      }),
    );
  }

  async #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }
}

function participationKeyboard(joinUrl: string) {
  return {
    inline_keyboard: [[{ text: 'Участвовать', url: joinUrl }]],
  };
}
