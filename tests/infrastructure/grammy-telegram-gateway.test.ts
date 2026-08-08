import { describe, expect, it } from 'vitest';
import { GrammyError, HttpError } from 'grammy';

import { classifyTelegramError } from '../../src/infrastructure/grammy-telegram-gateway.js';

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
