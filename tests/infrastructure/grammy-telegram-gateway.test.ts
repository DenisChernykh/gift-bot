import { describe, expect, it } from 'vitest';
import { GrammyError, HttpError, type Api } from 'grammy';

import {
  classifyTelegramError,
  GrammyTelegramGateway,
} from '../../src/infrastructure/grammy-telegram-gateway.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';

describe('classifyTelegramError', () => {
  it('classifies HTTP 429 as definitely not delivered and exposes retry_after', () => {
    const error = new GrammyError(
      'rate limited',
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 7 },
      },
      'sendMessage',
      { chat_id: -1001 },
    );

    expect(classifyTelegramError(error)).toMatchObject({
      kind: 'rate_limited',
      outcome: 'definite',
      retryAfterMs: 7000,
    });
  });

  it('classifies other Telegram 4xx responses as definite non-delivery', () => {
    const error = new GrammyError(
      'forbidden',
      { ok: false, error_code: 403, description: 'Forbidden' },
      'sendMessage',
      { chat_id: -1001 },
    );

    expect(classifyTelegramError(error)).toMatchObject({
      kind: 'client',
      outcome: 'definite',
      retryAfterMs: null,
    });
  });

  it('classifies Telegram 5xx and transport errors as unknown outcomes', () => {
    const serverError = new GrammyError(
      'server error',
      { ok: false, error_code: 500, description: 'Internal Server Error' },
      'sendMessage',
      { chat_id: -1001 },
    );
    const networkError = new HttpError('network failed', new Error('ECONNRESET'));

    expect(classifyTelegramError(serverError)).toMatchObject({
      kind: 'server',
      outcome: 'unknown',
    });
    expect(classifyTelegramError(networkError)).toMatchObject({
      kind: 'network',
      outcome: 'unknown',
    });
  });
});

describe('GrammyTelegramGateway cancellation edits', () => {
  it('treats the exact message-is-not-modified response as idempotent success', async () => {
    const api = {
      editMessageText: async () => {
        throw telegramEditError(
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
        );
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await expect(
      gateway.editCancelledMessage({
        chatId: -1001,
        messageId: 42,
        kind: 'text',
        text: 'Розыгрыш отменён.',
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps every other Telegram 400 edit response as a definite failure', async () => {
    const api = {
      editMessageText: async () => {
        throw telegramEditError('Bad Request: message to edit not found');
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await expect(
      gateway.editCancelledMessage({
        chatId: -1001,
        messageId: 42,
        kind: 'text',
        text: 'Розыгрыш отменён.',
      }),
    ).rejects.toMatchObject<TelegramDeliveryError>({
      outcome: 'definite',
      retryAfterMs: null,
    });
  });

  it('preserves the participation keyboard for counters and removes it for cancellation', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = {
      editMessageText: async (
        _chatId: number,
        _messageId: number,
        _text: string,
        options: Record<string, unknown>,
      ) => {
        calls.push(options);
        return true;
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await gateway.editGiveawayPost({
      chatId: -1001,
      messageId: 42,
      kind: 'text',
      text: 'Updated',
      entities: [{ type: 'bold', offset: 0, length: 7 }],
      removeParticipationButton: false,
      joinUrl: 'https://t.me/gift_test_bot?start=join_reissued-token',
    });
    await gateway.editCancelledMessage({
      chatId: -1001,
      messageId: 42,
      kind: 'text',
      text: 'Cancelled',
    });

    expect(calls[0]).toEqual({
      entities: [{ type: 'bold', offset: 0, length: 7 }],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Участвовать',
              url: 'https://t.me/gift_test_bot?start=join_reissued-token',
            },
          ],
        ],
      },
    });
    expect(calls[1]).toEqual({
      entities: [],
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('preserves the participation keyboard for photo counter edits', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = {
      editMessageCaption: async (
        _chatId: number,
        _messageId: number,
        options: Record<string, unknown>,
      ) => {
        calls.push(options);
        return true;
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await gateway.editGiveawayPost({
      chatId: -1001,
      messageId: 42,
      kind: 'photo',
      text: 'Updated caption',
      entities: [{ type: 'italic', offset: 0, length: 7 }],
      removeParticipationButton: false,
      joinUrl: 'https://t.me/gift_test_bot?start=join_photo-token',
    });

    expect(calls).toEqual([
      {
        caption: 'Updated caption',
        caption_entities: [{ type: 'italic', offset: 0, length: 7 }],
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Участвовать',
                url: 'https://t.me/gift_test_bot?start=join_photo-token',
              },
            ],
          ],
        },
      },
    ]);
  });
});

describe('GrammyTelegramGateway channel preflight', () => {
  it('reads current channel metadata and bot administrator rights together', async () => {
    const calls: string[] = [];
    const api = {
      getChat: async (chatId: number) => {
        calls.push(`chat:${chatId}`);
        return {
          id: chatId,
          type: 'channel',
          title: 'Current title',
          username: 'Current_Public',
        };
      },
      getChatMember: async (chatId: number, userId: number) => {
        calls.push(`member:${chatId}:${userId}`);
        return {
          status: 'administrator',
          user: { id: userId, is_bot: true, first_name: 'Gift Bot' },
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: true,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_post_messages: true,
          can_edit_messages: true,
        };
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    expect(await gateway.getChannelSnapshot(-1001)).toEqual({
      username: 'Current_Public',
      title: 'Current title',
      membership: {
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      },
    });
    expect(calls).toEqual(['chat:-1001', 'member:-1001:999']);
  });

  it.each([
    [{ status: 'creator' }, { status: 'creator' }],
    [{ status: 'administrator' }, { status: 'administrator' }],
    [{ status: 'member' }, { status: 'member' }],
    [
      { status: 'restricted', is_member: true },
      { status: 'restricted', isMember: true },
    ],
    [
      { status: 'restricted', is_member: false },
      { status: 'restricted', isMember: false },
    ],
    [{ status: 'left' }, { status: 'left' }],
    [{ status: 'kicked' }, { status: 'kicked' }],
    [{ status: 'future_status' }, { status: 'unknown' }],
  ])('normalizes participant membership %o', async (member, expected) => {
    const api = {
      getChatMember: async () => ({
        ...member,
        user: { id: 900, is_bot: false, first_name: 'Participant' },
      }),
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await expect(gateway.getParticipantMembership(-1001, 900)).resolves.toEqual(
      expected,
    );
  });

  it('classifies participant membership 429 without retrying it', async () => {
    const api = {
      getChatMember: async () => {
        throw new GrammyError(
          'rate limited',
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 11 },
          },
          'getChatMember',
          { chat_id: -1001, user_id: 900 },
        );
      },
    } as unknown as Api;
    const gateway = new GrammyTelegramGateway(api, 999);

    await expect(
      gateway.getParticipantMembership(-1001, 900),
    ).rejects.toMatchObject({ retryAfterMs: 11_000 });
  });
});

function telegramEditError(description: string) {
  return new GrammyError(
    'edit failed',
    { ok: false, error_code: 400, description },
    'editMessageText',
    { chat_id: -1001, message_id: 42 },
  );
}
