import { describe, expect, it } from 'vitest';

import { GiftBotRuntime } from '../../src/runtime/gift-bot-runtime.js';
import { createJsonLogger } from '../../src/runtime/logger.js';

describe('GiftBotRuntime', () => {
  it('recovers publications and cancellation sync before long polling and retries sync on the timer', async () => {
    const events: string[] = [];
    let scheduled: (() => void) | undefined;
    const runtime = new GiftBotRuntime(
      {
        start: async () => {
          events.push('bot:start');
        },
        stop: async () => {
          events.push('bot:stop');
        },
      },
      {
        recoverPublications: async () => {
          events.push('recover');
          return [];
        },
      },
      {
        retryPendingSynchronization: async () => {
          events.push('sync');
          return 0;
        },
      },
      async () => {
        events.push('database:close');
      },
      {
        logger: { info: () => undefined, error: () => undefined },
        schedule: (operation) => {
          scheduled = operation;
          return 17;
        },
        clearSchedule: (handle) => events.push(`timer:clear:${String(handle)}`),
      },
    );

    await runtime.start();
    expect(events).toEqual(['recover', 'sync', 'bot:start']);
    scheduled?.();
    await Promise.resolve();
    expect(events).toEqual(['recover', 'sync', 'bot:start', 'sync']);

    await runtime.stop('SIGTERM');
    await runtime.stop('SIGTERM');
    expect(events.slice(-3)).toEqual([
      'timer:clear:17',
      'bot:stop',
      'database:close',
    ]);
  });
});

describe('createJsonLogger', () => {
  it('emits structured JSON and redacts token-shaped fields', () => {
    const lines: string[] = [];
    const logger = createJsonLogger('info', (line) => lines.push(line));

    logger.info('bot_started', {
      giveawayId: 'giveaway-1',
      botToken: 'secret',
      callbackPayload: 'opaque-secret',
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      event: 'bot_started',
      giveawayId: 'giveaway-1',
      botToken: '[REDACTED]',
      callbackPayload: '[REDACTED]',
    });
  });
});
