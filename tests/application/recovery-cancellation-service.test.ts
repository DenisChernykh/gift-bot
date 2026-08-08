import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { GrammyError, type Api } from 'grammy';

import { GiveawayCancellationService } from '../../src/application/giveaway-cancellation-service.js';
import { GiveawayPublicationService } from '../../src/application/giveaway-publication-service.js';
import { GiveawayRecoveryService } from '../../src/application/giveaway-recovery-service.js';
import {
  TelegramDeliveryError,
  type TelegramCancelledMessage,
  type TelegramGateway,
  type TelegramGiveawayMessage,
} from '../../src/application/ports/telegram-gateway.js';
import { openDatabase, type DatabaseBoundary } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { hashToken } from '../../src/domain/tokens.js';
import { GrammyTelegramGateway } from '../../src/infrastructure/grammy-telegram-gateway.js';

const NOW = Date.UTC(2026, 7, 8, 7, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class FakeTelegramGateway implements TelegramGateway {
  readonly operations: string[] = [];
  editResults: Array<void | Error> = [];
  deleteResults: Array<void | Error> = [];
  beforeEdit?: (input: TelegramCancelledMessage) => Promise<void>;

  async getChannelMembership() {
    return {
      status: 'administrator',
      canPostMessages: true,
      canEditMessages: true,
      canDeleteMessages: true,
    };
  }

  async sendGiveawayMessage(_input: TelegramGiveawayMessage) {
    this.operations.push(`send:${_input.chatId}`);
    return { messageId: 999 };
  }

  async deleteMessage(chatId: number, messageId: number) {
    this.operations.push(`delete:${chatId}:${messageId}`);
    const result = this.deleteResults.shift();
    if (result instanceof Error) throw result;
  }

  async editCancelledMessage(input: TelegramCancelledMessage) {
    this.operations.push(`edit:${input.chatId}:${input.messageId}`);
    await this.beforeEdit?.(input);
    const result = this.editResults.shift();
    if (result instanceof Error) throw result;
  }
}

class CapturingLogger {
  readonly errors: Array<{
    event: string;
    fields: Record<string, unknown>;
  }> = [];

  error(event: string, fields: Record<string, unknown> = {}) {
    this.errors.push({ event, fields });
  }
}

async function openLifecycleApplication() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-lifecycle-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  const gateway = new FakeTelegramGateway();
  const logger = new CapturingLogger();
  let sequence = 0;
  const dependencies = {
    createId: (kind: 'sync_task') => `${kind}-${++sequence}`,
    now: () => NOW,
  };
  const cancellation = new GiveawayCancellationService(repository, gateway, dependencies);
  const recovery = new GiveawayRecoveryService(repository, gateway, {
    now: () => NOW,
    logger,
  });
  const publication = new GiveawayPublicationService(repository, gateway, {
    botUsername: 'gift_test_bot',
    createId: (kind) => `${kind}-${++sequence}`,
    createToken: () => ({ token: 'retry-token', tokenHash: hashToken('retry-token') }),
    now: () => NOW,
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...opened,
    repository,
    gateway,
    logger,
    cancellation,
    publication,
    recovery,
  };
}

async function seedPublishingRun(
  database: DatabaseBoundary,
  deliveryStatuses: Array<'pending' | 'sending' | 'delivered' | 'unknown'>,
) {
  await seedGiveaway(database, 'publishing', deliveryStatuses.length);
  await database.execute(
    `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
     values ('run-1', 'giveaway-1', 'publishing', ?, null)`,
    [NOW],
  );
  for (let index = 0; index < deliveryStatuses.length; index += 1) {
    const status = deliveryStatuses[index]!;
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values (?, 'run-1', ?, ?, ?, 'text', ?, ?)`,
      [
        `delivery-${index + 1}`,
        `channel-${index + 1}`,
        status,
        status === 'delivered' ? 110 + index : null,
        NOW,
        NOW,
      ],
    );
  }
  await database.execute(
    `insert into join_tokens (token_hash, giveaway_id, state, expires_at, created_at)
     values ('join-hash', 'giveaway-1', 'pending', null, ?)`,
    [NOW],
  );
}

async function seedGiveaway(
  database: DatabaseBoundary,
  state: 'draft' | 'active' | 'publishing',
  channelCount: number,
) {
  await database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, created_by_telegram_id, created_at, updated_at
     ) values ('giveaway-1', 'Recovery gifts', ?, 1, ?, 0, 'text',
               'Choose a gift', 700, ?, ?)`,
    [state, NOW + 86_400_000, NOW, NOW],
  );
  for (let index = 1; index <= channelCount; index += 1) {
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values (?, 'giveaway-1', ?, ?, ?, 700, 'confirmed', ?, ?)`,
      [
        `channel-${index}`,
        -2000 - index,
        `recovery_${index}`,
        `Recovery ${index}`,
        NOW,
        NOW,
      ],
    );
  }
}

describe('GiveawayRecoveryService', () => {
  it('activates a publishing giveaway when every delivery was saved before startup', async () => {
    const { database, recovery } = await openLifecycleApplication();
    await seedPublishingRun(database, ['delivered', 'delivered']);

    expect(await recovery.recoverPublications()).toEqual([
      { giveawayId: 'giveaway-1', kind: 'activated' },
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'active' },
    ]);
    expect(await database.all('select state from join_tokens')).toEqual([
      { state: 'active' },
    ]);
  });

  it('rolls partial known deliveries back in reverse order on startup', async () => {
    const { database, gateway, recovery } = await openLifecycleApplication();
    await seedPublishingRun(database, ['delivered', 'delivered', 'pending']);

    expect(await recovery.recoverPublications()).toEqual([
      { giveawayId: 'giveaway-1', kind: 'rolled_back' },
    ]);
    expect(gateway.operations).toEqual(['delete:-2002:111', 'delete:-2001:110']);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'draft' },
    ]);
  });

  it('logs each unknown or sending channel safely on startup without including known deliveries', async () => {
    const { database, gateway, logger, recovery } = await openLifecycleApplication();
    await seedPublishingRun(database, ['delivered', 'sending', 'unknown']);

    expect(await recovery.recoverPublications()).toEqual([
      { giveawayId: 'giveaway-1', kind: 'failed' },
    ]);
    expect(gateway.operations).toEqual([]);
    expect(logger.errors).toEqual([
      {
        event: 'publication_failed',
        fields: {
          giveawayId: 'giveaway-1',
          stage: 'recovery_unknown_send',
          errorKind: 'unknown_delivery',
          channelId: 'channel-2',
          channelUsername: 'recovery_2',
        },
      },
      {
        event: 'publication_failed',
        fields: {
          giveawayId: 'giveaway-1',
          stage: 'recovery_unknown_send',
          errorKind: 'unknown_delivery',
          channelId: 'channel-3',
          channelUsername: 'recovery_3',
        },
      },
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'failed' },
    ]);
  });

  it('logs only channels whose rollback deletion failed and omits raw Telegram errors', async () => {
    const { database, gateway, logger, recovery } = await openLifecycleApplication();
    await seedPublishingRun(database, ['delivered', 'delivered', 'pending']);
    gateway.deleteResults = [
      new TelegramDeliveryError(
        'BOT_TOKEN=secret tokenHash=secret raw Telegram description',
        'definite',
      ),
      undefined,
    ];

    expect(await recovery.recoverPublications()).toEqual([
      { giveawayId: 'giveaway-1', kind: 'failed' },
    ]);
    expect(logger.errors).toEqual([
      {
        event: 'publication_failed',
        fields: {
          giveawayId: 'giveaway-1',
          stage: 'recovery_rollback_delete',
          errorKind: 'delete_failed',
          channelId: 'channel-2',
          channelUsername: 'recovery_2',
        },
      },
    ]);
    expect(JSON.stringify(logger.errors)).not.toContain('BOT_TOKEN');
    expect(JSON.stringify(logger.errors)).not.toContain('tokenHash');
    expect(JSON.stringify(logger.errors)).not.toContain('raw Telegram description');
  });

  it('fails closed after a crash between Telegram accepting a send and saving its message id', async () => {
    const { database, gateway, publication, recovery } =
      await openLifecycleApplication();
    await seedPublishingRun(database, ['sending']);

    expect(await recovery.recoverPublications()).toEqual([
      { giveawayId: 'giveaway-1', kind: 'failed' },
    ]);
    expect(gateway.operations).toEqual([]);
    await expect(publication.publish('giveaway-1')).rejects.toThrow(
      'Giveaway cannot be published from failed',
    );
    expect(gateway.operations).toEqual([]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'failed' },
    ]);
  });
});

describe('GiveawayCancellationService', () => {
  it('persists cancelled and durable sync tasks before attempting Telegram edits', async () => {
    const { database, gateway, cancellation } = await openLifecycleApplication();
    await seedGiveaway(database, 'active', 2);
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('run-active', 'giveaway-1', 'succeeded', ?, ?)`,
      [NOW, NOW],
    );
    for (let index = 1; index <= 2; index += 1) {
      await database.execute(
        `insert into publication_deliveries (
           id, publication_run_id, giveaway_channel_id, status, message_id,
           message_kind, created_at, updated_at
         ) values (?, 'run-active', ?, 'delivered', ?, 'text', ?, ?)`,
        [`delivery-${index}`, `channel-${index}`, 200 + index, NOW, NOW],
      );
    }
    gateway.beforeEdit = async () => {
      expect(await database.all('select state from giveaways')).toEqual([
        { state: 'cancelled' },
      ]);
      expect(await database.all('select status from sync_tasks order by id')).toEqual([
        { status: 'pending' },
        { status: 'pending' },
      ]);
      gateway.beforeEdit = undefined;
    };
    gateway.editResults = [undefined, new TelegramDeliveryError('offline', 'unknown')];

    const result = await cancellation.cancel('giveaway-1');

    expect(result).toMatchObject({ kind: 'cancelled', pendingSyncTasks: 1 });
    expect(
      await database.all('select status, attempts from sync_tasks order by id'),
    ).toEqual([
      { status: 'completed', attempts: 1 },
      { status: 'pending', attempts: 1 },
    ]);
  });

  it('retries durable cancellation sync tasks during startup processing', async () => {
    const { database, gateway, cancellation } = await openLifecycleApplication();
    await seedGiveaway(database, 'active', 1);
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('run-active', 'giveaway-1', 'succeeded', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('delivery-1', 'run-active', 'channel-1', 'delivered', 301,
                 'text', ?, ?)`,
      [NOW, NOW],
    );
    gateway.editResults = [new TelegramDeliveryError('offline', 'unknown')];
    await cancellation.cancel('giveaway-1');
    gateway.editResults = [undefined];

    expect(await cancellation.retryPendingSynchronization()).toBe(1);
    expect(await database.all('select status, attempts from sync_tasks')).toEqual([
      { status: 'completed', attempts: 2 },
    ]);
  });

  it('completes a pending sync task when a prior edit succeeded before the process crashed', async () => {
    const { database, repository } = await openLifecycleApplication();
    await seedGiveaway(database, 'active', 1);
    await database.execute(
      "update giveaways set state = 'cancelled' where id = 'giveaway-1'",
    );
    await database.execute(
      `insert into sync_tasks (
         id, giveaway_id, giveaway_channel_id, task_type, payload,
         status, attempts, created_at, updated_at
       ) values ('sync-after-crash', 'giveaway-1', 'channel-1',
                 'cancel_message', ?, 'pending', 0, ?, ?)`,
      [
        JSON.stringify({
          chatId: -2001,
          messageId: 401,
          messageKind: 'text',
          text: 'Розыгрыш отменён.',
        }),
        NOW,
        NOW,
      ],
    );
    const api = {
      editMessageText: async () => {
        throw new GrammyError(
          'edit failed',
          {
            ok: false,
            error_code: 400,
            description:
              'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
          },
          'editMessageText',
          { chat_id: -2001, message_id: 401 },
        );
      },
    } as unknown as Api;
    const cancellation = new GiveawayCancellationService(
      repository,
      new GrammyTelegramGateway(api, 999),
      { now: () => NOW },
    );

    expect(await cancellation.retryPendingSynchronization()).toBe(1);
    expect(await database.all('select status, attempts from sync_tasks')).toEqual([
      { status: 'completed', attempts: 1 },
    ]);
  });

  it('cancels a draft without Telegram calls', async () => {
    const { database, gateway, cancellation } = await openLifecycleApplication();
    await seedGiveaway(database, 'draft', 1);

    expect(await cancellation.cancel('giveaway-1')).toMatchObject({
      kind: 'cancelled',
      pendingSyncTasks: 0,
    });
    expect(gateway.operations).toEqual([]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'cancelled' },
    ]);
  });
});
