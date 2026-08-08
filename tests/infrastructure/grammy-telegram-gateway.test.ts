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

    expect(classifyTelegramError(serverError).outcome).toBe('unknown');
    expect(classifyTelegramError(networkError).outcome).toBe('unknown');
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
});

function telegramEditError(description: string) {
  return new GrammyError(
    'edit failed',
    { ok: false, error_code: 400, description },
    'editMessageText',
    { chat_id: -1001, message_id: 42 },
  );
}
