import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createDatabaseProxy,
  openDatabase,
} from '../../src/database/client.js';
import {
  migrateDatabase,
  migrateDatabaseAt,
} from '../../src/database/migrate.js';
import { giveaways } from '../../src/database/schema.js';

describe('SQLite bootstrap', () => {
  it('enables safety pragmas and creates every Task 1 table through migrations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-test-'));
    const databasePath = join(directory, 'gift-bot.sqlite');
    let sqlite: ReturnType<typeof openDatabase>['sqlite'] | undefined;

    try {
      ({ sqlite } = openDatabase(databasePath));
      await migrateDatabase(sqlite);

      const tables = sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(sqlite.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(sqlite.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(tables).toEqual(
        expect.arrayContaining([
          'giveaways',
          'wizard_sessions',
          'giveaway_channels',
          'channel_invites',
          'pending_channel_connections',
          'callback_actions',
          'join_tokens',
          'publication_runs',
          'publication_deliveries',
          'sync_tasks',
        ]),
      );
    } finally {
      sqlite?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('database boundary', () => {
  it('maps real Drizzle selects from DatabaseSync rows and skips an already-applied migration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-test-'));
    const databasePath = join(directory, 'gift-bot.sqlite');
    let sqlite: ReturnType<typeof openDatabase>['sqlite'] | undefined;

    try {
      const opened = openDatabase(databasePath);
      sqlite = opened.sqlite;
      await migrateDatabase(sqlite);
      sqlite
        .prepare(
          `insert into giveaways (
            id, title, state, winner_count, deadline_utc, referrals_enabled,
            content_kind, content_text, created_by_telegram_id, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('giveaway-1', 'August giveaway', 'draft', 1, 0, 0, 'text', 'Hello', 42, 0, 0);

      const giveaway = await createDatabaseProxy(opened.database)
        .select({ id: giveaways.id, title: giveaways.title })
        .from(giveaways)
        .get();

      expect(giveaway).toEqual({ id: 'giveaway-1', title: 'August giveaway' });

      await migrateDatabase(sqlite);
      expect(
        sqlite.prepare('select count(*) as count from __drizzle_migrations').get(),
      ).toEqual({ count: 1 });
    } finally {
      sqlite?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('exposes only the serialized operation boundary to application code', () => {
    const opened = openDatabase(':memory:');

    try {
      expect(opened).not.toHaveProperty('drizzle');
    } finally {
      opened.sqlite.close();
    }
  });

  it('keeps an unrelated write out of a transaction that later rolls back', async () => {
    const { sqlite, database } = openDatabase(':memory:');
    let releaseTransaction: () => void;
    const transactionReachedWait = Promise.withResolvers<void>();
    const releaseWait = Promise.withResolvers<void>();

    try {
      await database.execute('create table entries (value text not null)');
      const failedTransaction = database.transaction(async (transaction) => {
        await transaction.execute("insert into entries (value) values ('inside')");
        transactionReachedWait.resolve();
        await releaseWait.promise;
        throw new Error('rollback');
      });

      await transactionReachedWait.promise;
      const outsideWrite = database.execute(
        "insert into entries (value) values ('outside')",
      );
      releaseTransaction = releaseWait.resolve;
      releaseTransaction();

      await expect(failedTransaction).rejects.toThrow('rollback');
      await outsideWrite;
      expect(await database.all<{ value: string }>('select value from entries')).toEqual([
        { value: 'outside' },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe('migration command wiring', () => {
  it('creates a missing parent directory for the configured database path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-test-'));
    const databasePath = join(directory, '.data', 'gift-bot.sqlite');

    try {
      await migrateDatabaseAt(databasePath);
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
