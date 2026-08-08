import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CallbackActionService } from '../../src/application/callback-action-service.js';
import { openDatabase } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { hashToken } from '../../src/domain/tokens.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function openTestService() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-callback-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  let now = Date.UTC(2026, 7, 8, 7, 0);
  const service = new CallbackActionService(repository, {
    now: () => now,
    lifetimeMs: 10 * 60 * 1000,
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { ...opened, service, setNow: (value: number) => (now = value) };
}

describe('CallbackActionService', () => {
  it('stores only an opaque token hash and binds the callback to its actor', async () => {
    const { database, service } = await openTestService();
    const issued = await service.issue({
      actorTelegramId: 501,
      giveawayId: null,
      action: 'wizard_referrals',
      payload: { enabled: true },
    });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.token).not.toContain('wizard_referrals');
    expect(
      await database.all<{ tokenHash: string }>(
        'select token_hash as tokenHash from callback_actions',
      ),
    ).toEqual([{ tokenHash: hashToken(issued.token) }]);

    await expect(service.consume(issued.token, 999)).rejects.toThrow(
      'Callback action does not belong to this actor',
    );
    expect(await service.consume(issued.token, 501)).toMatchObject({
      action: 'wizard_referrals',
      payload: { enabled: true },
      actorTelegramId: 501,
      alreadyConsumed: false,
    });
  });

  it('expires callbacks and reports a same-actor replay without consuming twice', async () => {
    const { service, setNow } = await openTestService();
    const first = await service.issue({
      actorTelegramId: 502,
      giveawayId: null,
      action: 'preview',
      payload: {},
    });

    expect(await service.consume(first.token, 502)).toMatchObject({
      alreadyConsumed: false,
    });
    expect(await service.consume(first.token, 502)).toMatchObject({
      alreadyConsumed: true,
    });

    const expired = await service.issue({
      actorTelegramId: 502,
      giveawayId: null,
      action: 'publish',
      payload: {},
    });
    setNow(Date.UTC(2026, 7, 8, 7, 10));
    await expect(service.consume(expired.token, 502)).rejects.toThrow(
      'Callback action has expired',
    );
  });
});
