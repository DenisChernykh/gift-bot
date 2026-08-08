import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GiveawayPublicationService } from '../../src/application/giveaway-publication-service.js';
import {
  TelegramDeliveryError,
  type TelegramGateway,
  type TelegramGiveawayMessage,
} from '../../src/application/ports/telegram-gateway.js';
import { openDatabase, type DatabaseBoundary } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { hashToken } from '../../src/domain/tokens.js';

const NOW = Date.UTC(2026, 7, 8, 7, 0);
const FULL_RIGHTS = {
  status: 'administrator',
  canPostMessages: true,
  canEditMessages: true,
  canDeleteMessages: true,
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class FakeTelegramGateway implements TelegramGateway {
  readonly operations: string[] = [];
  readonly sent: TelegramGiveawayMessage[] = [];
  readonly sleepCalls: number[] = [];
  sendResults: Array<number | Error> = [];
  deleteResults: Array<void | Error> = [];
  membership = FULL_RIGHTS;
  beforeSend?: (input: TelegramGiveawayMessage) => Promise<void>;

  async getChannelMembership(chatId: number) {
    this.operations.push(`rights:${chatId}`);
    return this.membership;
  }

  async sendGiveawayMessage(input: TelegramGiveawayMessage) {
    this.operations.push(`send:${input.chatId}`);
    this.sent.push(input);
    await this.beforeSend?.(input);
    const result = this.sendResults.shift() ?? 1000 + this.sent.length;
    if (result instanceof Error) throw result;
    return { messageId: result };
  }

  async deleteMessage(chatId: number, messageId: number) {
    this.operations.push(`delete:${chatId}:${messageId}`);
    const result = this.deleteResults.shift();
    if (result instanceof Error) throw result;
  }

  async editCancelledMessage(): Promise<void> {
    throw new Error('not used by publication tests');
  }
}

async function openPublicationApplication(channelCount = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-publication-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  await seedGiveaway(opened.database, channelCount);

  const gateway = new FakeTelegramGateway();
  let sequence = 0;
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  const service = new GiveawayPublicationService(repository, gateway, {
    botUsername: 'gift_test_bot',
    createId: (kind) => `${kind}-${++sequence}`,
    createToken: () => ({ token: 'join-token', tokenHash: hashToken('join-token') }),
    now: () => NOW,
    sleep: async (milliseconds) => {
      gateway.sleepCalls.push(milliseconds);
    },
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...opened, gateway, repository, service };
}

async function seedGiveaway(database: DatabaseBoundary, channelCount: number) {
  await database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, created_by_telegram_id, created_at, updated_at
     ) values ('giveaway-1', 'August gifts', 'draft', 2, ?, 1, 'text',
               'Choose a gift', 700, ?, ?)`,
    [NOW + 86_400_000, NOW, NOW],
  );
  for (let index = 1; index <= channelCount; index += 1) {
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values (?, 'giveaway-1', ?, ?, ?, 700, 'confirmed', ?, ?)`,
      [
        `channel-${index}`,
        -1000 - index,
        `channel_${index}`,
        `Channel ${index}`,
        NOW,
        NOW,
      ],
    );
  }
}

describe('GiveawayPublicationService', () => {
  it('preflights every channel, saves all delivery intents before sending, and activates only after both messages are saved', async () => {
    const { database, gateway, service } = await openPublicationApplication(2);
    gateway.sendResults = [501, 502];
    gateway.beforeSend = async () => {
      expect(
        await database.all(
          `select status, message_id from publication_deliveries
             order by giveaway_channel_id`,
        ),
      ).toEqual([
        { status: 'sending', message_id: null },
        { status: 'pending', message_id: null },
      ]);
      expect(
        await database.all('select state from giveaways where id = ?', ['giveaway-1']),
      ).toEqual([{ state: 'publishing' }]);
      gateway.beforeSend = undefined;
    };

    const result = await service.publish('giveaway-1');

    expect(result).toMatchObject({ kind: 'active', giveawayId: 'giveaway-1' });
    expect(gateway.operations.slice(0, 2)).toEqual(['rights:-1001', 'rights:-1002']);
    expect(gateway.sent).toEqual([
      expect.objectContaining({
        chatId: -1001,
        joinUrl: 'https://t.me/gift_test_bot?start=join_join-token',
      }),
      expect.objectContaining({
        chatId: -1002,
        joinUrl: 'https://t.me/gift_test_bot?start=join_join-token',
      }),
    ]);
    expect(
      await database.all(
        `select d.status, d.message_id, d.message_kind
           from publication_deliveries d
           order by d.giveaway_channel_id`,
      ),
    ).toEqual([
      { status: 'delivered', message_id: 501, message_kind: 'text' },
      { status: 'delivered', message_id: 502, message_kind: 'text' },
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'active' },
    ]);
    expect(await database.all('select state, token_hash from join_tokens')).toEqual([
      { state: 'active', token_hash: hashToken('join-token') },
    ]);
  });

  it('does not start publication when any channel fails the rights preflight', async () => {
    const { database, gateway, service } = await openPublicationApplication(2);
    gateway.membership = { ...FULL_RIGHTS, canDeleteMessages: false };

    await expect(service.publish('giveaway-1')).rejects.toThrow(
      'Channel @channel_1 is missing publication rights',
    );

    expect(gateway.sent).toEqual([]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'draft' },
    ]);
    expect(await database.all('select id from publication_runs')).toEqual([]);
  });

  it('rejects a stored final render overflow without persisting publication state', async () => {
    const { database, gateway, service } = await openPublicationApplication(1);
    await database.execute(
      "update giveaways set content_text = ? where id = 'giveaway-1'",
      ['a'.repeat(4096)],
    );

    await expect(service.publish('giveaway-1')).rejects.toThrow(
      'Final giveaway message exceeds the Telegram length limit',
    );

    expect(gateway.sent).toEqual([]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'draft' },
    ]);
    expect(await database.all('select id from publication_runs')).toEqual([]);
    expect(await database.all('select token_hash from join_tokens')).toEqual([]);
    expect(await database.all('select id from publication_deliveries')).toEqual([]);
  });

  it('rolls known messages back in reverse order after a definite send failure', async () => {
    const { database, gateway, service } = await openPublicationApplication(3);
    gateway.sendResults = [601, 602, new TelegramDeliveryError('forbidden', 'definite')];

    const result = await service.publish('giveaway-1');

    expect(result).toMatchObject({ kind: 'rolled_back', giveawayId: 'giveaway-1' });
    expect(gateway.operations.slice(-2)).toEqual([
      'delete:-1002:602',
      'delete:-1001:601',
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'draft' },
    ]);
    expect(await database.all('select status from publication_runs')).toEqual([
      { status: 'rolled_back' },
    ]);
  });

  it('marks the giveaway failed when rollback cannot delete every known message', async () => {
    const { database, gateway, service } = await openPublicationApplication(2);
    gateway.sendResults = [701, new TelegramDeliveryError('forbidden', 'definite')];
    gateway.deleteResults = [new TelegramDeliveryError('cannot delete', 'definite')];

    const result = await service.publish('giveaway-1');

    expect(result).toMatchObject({ kind: 'failed', giveawayId: 'giveaway-1' });
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'failed' },
    ]);
  });

  it('fails closed on an unknown send outcome without deleting or blindly resending', async () => {
    const { database, gateway, service } = await openPublicationApplication(2);
    gateway.sendResults = [
      801,
      new TelegramDeliveryError('connection reset after request', 'unknown'),
    ];

    const result = await service.publish('giveaway-1');

    expect(result).toMatchObject({ kind: 'failed', giveawayId: 'giveaway-1' });
    expect(gateway.operations.filter((operation) => operation.startsWith('send:'))).toEqual([
      'send:-1001',
      'send:-1002',
    ]);
    expect(gateway.operations.some((operation) => operation.startsWith('delete:'))).toBe(
      false,
    );
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'failed' },
    ]);
    expect(
      await database.all(
        `select status from publication_deliveries order by giveaway_channel_id`,
      ),
    ).toEqual([{ status: 'delivered' }, { status: 'unknown' }]);
  });

  it('honours Telegram retry_after only when the failed send is definitely retryable', async () => {
    const { gateway, service } = await openPublicationApplication(1);
    gateway.sendResults = [
      new TelegramDeliveryError('too many requests', 'definite', 3000),
      901,
    ];

    expect(await service.publish('giveaway-1')).toMatchObject({ kind: 'active' });
    expect(gateway.sleepCalls).toEqual([3000]);
    expect(gateway.operations.filter((operation) => operation.startsWith('send:'))).toEqual([
      'send:-1001',
      'send:-1001',
    ]);
  });

  it('makes a duplicate publication request side-effect free', async () => {
    const { gateway, service } = await openPublicationApplication(1);
    await service.publish('giveaway-1');
    const operationCount = gateway.operations.length;

    expect(await service.publish('giveaway-1')).toMatchObject({
      kind: 'already_active',
      giveawayId: 'giveaway-1',
    });
    expect(gateway.operations).toHaveLength(operationCount);
  });
});
