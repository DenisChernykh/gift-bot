import { describe, expect, it } from 'vitest';

import {
  GiftBotRuntime,
  InFlightUpdateTracker,
} from '../../src/runtime/gift-bot-runtime.js';
import { createJsonLogger } from '../../src/runtime/logger.js';

describe('GiftBotRuntime', () => {
  it('stops polling, rejects newly admitted updates, and drains a delayed handler before closing SQLite', async () => {
    const events: string[] = [];
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const updates = new InFlightUpdateTracker();
    const middleware = updates.middleware();
    const inFlight = middleware({} as never, async () => {
      events.push('handler:start');
      await handlerGate;
      events.push('handler:done');
    });
    await Promise.resolve();

    const runtime = new GiftBotRuntime(
      {
        start: async () => undefined,
        stop: async () => {
          events.push('bot:stop');
        },
      },
      { recoverPublications: async () => [] },
      {
        recoverInterrupted: async () => undefined,
        retryPendingSynchronization: async () => 0,
        waitForIdle: async () => undefined,
      },
      async () => {
        events.push('database:close');
      },
      {
        logger: { info: () => undefined, error: () => undefined },
        updateDrain: updates,
      },
    );

    const stopping = runtime.stop('SIGTERM');
    await Promise.resolve();
    expect(events).toEqual(['handler:start', 'bot:stop']);

    let newlyAdmitted = false;
    await middleware({} as never, async () => {
      newlyAdmitted = true;
    });
    expect(newlyAdmitted).toBe(false);
    expect(events).not.toContain('database:close');

    releaseHandler();
    await inFlight;
    await stopping;
    expect(events).toEqual([
      'handler:start',
      'bot:stop',
      'handler:done',
      'database:close',
    ]);
  });

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
        recoverInterrupted: async () => {
          events.push('sync:recover');
        },
        retryPendingSynchronization: async () => {
          events.push('sync');
          return 0;
        },
        waitForIdle: async () => {
          events.push('sync:idle');
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
    expect(events).toEqual(['recover', 'sync:recover', 'sync', 'bot:start']);
    scheduled?.();
    await Promise.resolve();
    expect(events).toEqual([
      'recover',
      'sync:recover',
      'sync',
      'bot:start',
      'sync',
    ]);

    await runtime.stop('SIGTERM');
    await runtime.stop('SIGTERM');
    expect(events.slice(-4)).toEqual([
      'timer:clear:17',
      'bot:stop',
      'sync:idle',
      'database:close',
    ]);
  });

  it('waits for an in-flight background synchronization before closing SQLite', async () => {
    const events: string[] = [];
    let scheduled: (() => void) | undefined;
    const synchronizationStarted = Promise.withResolvers<void>();
    const releaseSynchronization = Promise.withResolvers<void>();
    let background: Promise<void> = Promise.resolve();
    const runtime = new GiftBotRuntime(
      { start: async () => undefined, stop: async () => events.push('bot:stop') },
      { recoverPublications: async () => [] },
      {
        recoverInterrupted: async () => undefined,
        retryPendingSynchronization: async () => 0,
        waitForIdle: async () => background,
      },
      async () => events.push('database:close'),
      {
        logger: { info: () => undefined, error: () => undefined },
        schedule: (operation) => {
          scheduled = operation;
          return 19;
        },
        clearSchedule: () => undefined,
      },
    );
    await runtime.start();
    background = (async () => {
      synchronizationStarted.resolve();
      await releaseSynchronization.promise;
      events.push('sync:done');
    })();
    scheduled?.();
    await synchronizationStarted.promise;

    const stopping = runtime.stop('SIGTERM');
    await Promise.resolve();
    expect(events).toEqual(['bot:stop']);

    releaseSynchronization.resolve();
    await stopping;
    expect(events).toEqual(['bot:stop', 'sync:done', 'database:close']);
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
