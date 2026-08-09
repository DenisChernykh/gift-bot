import { GrammyError, HttpError, type Api } from 'grammy';

import {
  TelegramDeliveryError,
  type TelegramCancelledMessage,
  type TelegramGateway,
  type TelegramGiveawayMessage,
  type TelegramPostEdit,
} from '../application/ports/telegram-gateway.js';
import type { ParticipantMembership } from '../domain/participant-rules.js';

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

  async getChannelSnapshot(chatId: number) {
    const [chat, member] = await this.#call(() =>
      Promise.all([
        this.#api.getChat(chatId),
        this.#api.getChatMember(chatId, this.#botTelegramId),
      ]),
    );
    return {
      username: 'username' in chat ? (chat.username ?? null) : null,
      title: 'title' in chat ? (chat.title ?? '') : '',
      membership: {
        status: member.status,
        canPostMessages:
          member.status === 'administrator' &&
          (member.can_post_messages ?? false),
        canEditMessages:
          member.status === 'administrator' &&
          (member.can_edit_messages ?? false),
        canDeleteMessages:
          member.status === 'administrator' &&
          (member.can_delete_messages ?? false),
      },
    };
  }

  async getParticipantMembership(
    chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership> {
    const member = await this.#call(() =>
      this.#api.getChatMember(chatId, telegramUserId),
    );
    const status = member.status as string;
    if (status === 'restricted') {
      return {
        status: 'restricted',
        isMember: 'is_member' in member && member.is_member === true,
      };
    }
    if (
      status === 'creator' ||
      status === 'administrator' ||
      status === 'member' ||
      status === 'left' ||
      status === 'kicked'
    ) {
      return { status };
    }
    return { status: 'unknown' };
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

  async sendDirectMessage(chatId: number, text: string): Promise<void> {
    await this.#call(() => this.#api.sendMessage(chatId, text));
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.#call(() => this.#api.deleteMessage(chatId, messageId));
  }

  async editCancelledMessage(input: TelegramCancelledMessage): Promise<void> {
    await this.editGiveawayPost({
      ...input,
      entities: [],
      removeParticipationButton: true,
    });
  }

  async editGiveawayPost(input: TelegramPostEdit): Promise<void> {
    if (input.kind === 'photo') {
      await this.#editIdempotently(() =>
        this.#api.editMessageCaption(input.chatId, input.messageId, {
          caption: input.text,
          caption_entities: input.entities,
          ...(input.removeParticipationButton
            ? { reply_markup: { inline_keyboard: [] } }
            : { reply_markup: participationKeyboard(input.joinUrl) }),
        }),
      );
      return;
    }
    await this.#editIdempotently(() =>
      this.#api.editMessageText(input.chatId, input.messageId, input.text, {
        entities: input.entities,
        ...(input.removeParticipationButton
          ? { reply_markup: { inline_keyboard: [] } }
          : { reply_markup: participationKeyboard(input.joinUrl) }),
      }),
    );
  }

  async #editIdempotently(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (isMessageNotModifiedError(error)) return;
      throw classifyTelegramError(error);
    }
  }

  async #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }
}

const MESSAGE_NOT_MODIFIED_DESCRIPTION =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

function isMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    ['editMessageText', 'editMessageCaption'].includes(error.method) &&
    error.description === MESSAGE_NOT_MODIFIED_DESCRIPTION
  );
}

function participationKeyboard(joinUrl: string) {
  return {
    inline_keyboard: [[{ text: 'Участвовать', url: joinUrl }]],
  };
}
