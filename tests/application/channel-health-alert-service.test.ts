import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelHealthAlertService } from '../../src/application/channel-health-alert-service.js';
import { openDatabase } from '../../src/database/client.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { SqliteParticipantRepository } from '../../src/database/participant-repository.js';

const NOW = Date.UTC(2026, 7, 9, 7, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-alerts-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  await opened.database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, created_by_telegram_id, created_at, updated_at
     ) values ('giveaway-1', 'Летний подарок', 'active', 1, ?, 1,
               'text', 'Условия', 700, ?, ?)`,
    [NOW + 86_400_000, NOW, NOW],
  );
  await opened.database.execute(
    `insert into giveaway_channels (
       id, giveaway_id, telegram_chat_id, username, title,
       owner_telegram_id, status, created_at, updated_at
     ) values ('channel-1', 'giveaway-1', -1001, 'gift_channel',
               'Gift Channel', 700, 'confirmed', ?, ?)`,
    [NOW, NOW],
  );
  const repository = new SqliteParticipantRepository(opened.database, {
    createId: (kind) => `${kind}-1`,
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...opened, repository };
}

describe('ChannelHealthAlertService', () => {
  it('keeps a failed notification durable and marks it only after Telegram accepts it', async () => {
    const { database, repository } = await openFixture();
    await repository.recordBotRightsLoss({
      giveawayId: 'giveaway-1',
      giveawayChannelId: 'channel-1',
      now: NOW,
    });
    await repository.recordBotRightsLoss({
      giveawayId: 'giveaway-1',
      giveawayChannelId: 'channel-1',
      now: NOW + 1,
    });
    const calls: Array<{ chatId: number; text: string }> = [];
    let fail = true;
    const service = new ChannelHealthAlertService(
      repository,
      {
        sendDirectMessage: async (chatId, text) => {
          calls.push({ chatId, text });
          if (fail) throw new Error('telegram unavailable');
        },
      },
      { now: () => NOW + 2 },
    );

    expect(await service.retryPendingNotifications()).toBe(0);
    expect(
      await database.all(
        'select state, notified_at from channel_health_alerts',
      ),
    ).toEqual([{ state: 'active', notified_at: null }]);

    fail = false;
    expect(await service.retryPendingNotifications()).toBe(1);
    expect(await service.retryPendingNotifications()).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ chatId: 700 });
    expect(calls[1]!.text).toContain('Летний подарок');
    expect(calls[1]!.text).toContain('@gift_channel');
    expect(
      await database.all(
        'select state, notified_at from channel_health_alerts',
      ),
    ).toEqual([{ state: 'active', notified_at: NOW + 2 }]);
  });

  it('serializes overlapping passes so one active alert is sent once', async () => {
    const { repository } = await openFixture();
    await repository.recordBotRightsLoss({
      giveawayId: 'giveaway-1',
      giveawayChannelId: 'channel-1',
      now: NOW,
    });
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const service = new ChannelHealthAlertService(repository, {
      sendDirectMessage: async () => {
        calls += 1;
        await release.promise;
      },
    });

    const first = service.retryPendingNotifications();
    const second = service.retryPendingNotifications();
    await Promise.resolve();
    release.resolve();

    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(calls).toBe(1);
    await service.waitForIdle();
  });
});
