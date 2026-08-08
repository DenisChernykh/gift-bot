import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    let close: (() => Promise<void>) | undefined;

    try {
      const opened = openDatabase(databasePath);
      close = opened.close;
      await migrateDatabase(opened.database);

      const tables = (await opened.database.all<{ name: string }>(
        "select name from sqlite_master where type = 'table'",
      )).map((row) => row.name);

      expect(await opened.database.all('PRAGMA foreign_keys')).toEqual([
        { foreign_keys: 1 },
      ]);
      expect(await opened.database.all('PRAGMA journal_mode')).toEqual([
        { journal_mode: 'wal' },
      ]);
      expect(await opened.database.all('PRAGMA busy_timeout')).toEqual([
        { timeout: 5000 },
      ]);
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
      await close?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('database boundary', () => {
  it('maps real Drizzle selects from DatabaseSync rows and skips an already-applied migration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-test-'));
    const databasePath = join(directory, 'gift-bot.sqlite');
    let close: (() => Promise<void>) | undefined;

    try {
      const opened = openDatabase(databasePath);
      close = opened.close;
      await migrateDatabase(opened.database);
      await opened.database.execute(
        `insert into giveaways (
            id, title, state, winner_count, deadline_utc, referrals_enabled,
            content_kind, content_text, created_by_telegram_id, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['giveaway-1', 'August giveaway', 'draft', 1, 0, 0, 'text', 'Hello', 42, 0, 0],
      );

      const giveaway = await createDatabaseProxy(opened.database)
        .select({ id: giveaways.id, title: giveaways.title })
        .from(giveaways)
        .get();

      expect(giveaway).toEqual({ id: 'giveaway-1', title: 'August giveaway' });

      const migrationCount = await opened.database.all<{ count: number }>(
        'select count(*) as count from __drizzle_migrations',
      );
      await migrateDatabase(opened.database);
      expect(
        await opened.database.all<{ count: number }>(
          'select count(*) as count from __drizzle_migrations',
        ),
      ).toEqual(migrationCount);
    } finally {
      await close?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('exposes only the serialized operation boundary to application code', async () => {
    const opened = openDatabase(':memory:');

    try {
      expect(Object.keys(opened)).toEqual(['database', 'close']);
    } finally {
      await opened.close();
    }
  });

  it('does not expose a raw SQLite handle on the serialized database object', async () => {
    const opened = openDatabase(':memory:');
    const runtimeSurface = opened.database as unknown as Record<string, unknown>;

    try {
      expect('sqlite' in runtimeSurface).toBe(false);
      expect(
        Object.values(runtimeSurface).some(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            ('prepare' in value || 'exec' in value),
        ),
      ).toBe(false);
    } finally {
      await opened.close();
    }
  });

  it('keeps transaction ownership helpers off the runtime prototype', async () => {
    const { database, close } = openDatabase(':memory:');
    const runtimePrototype = Object.getPrototypeOf(database) as Record<
      string,
      unknown
    >;
    const sensitiveHelpers = ['exclusively', 'acquire', 'release', 'assertOpen'];
    const transactionReachedWait = Promise.withResolvers<void>();
    const releaseWait = Promise.withResolvers<void>();
    let failedTransaction: Promise<void> | undefined;
    let outsideWrite: Promise<void> | undefined;

    try {
      await database.execute('create table entries (value text not null)');

      const exposedRelease = runtimePrototype.release;
      if (typeof exposedRelease === 'function') {
        failedTransaction = database.transaction(async (transaction) => {
          await transaction.execute("insert into entries (value) values ('inside')");
          transactionReachedWait.resolve();
          await releaseWait.promise;
          throw new Error('rollback');
        });

        await transactionReachedWait.promise;
        exposedRelease.call(database);
        outsideWrite = database.execute(
          "insert into entries (value) values ('outside')",
        );
        await outsideWrite;
        releaseWait.resolve();

        await expect(failedTransaction).rejects.toThrow('rollback');
        expect(
          await database.all<{ value: string }>('select value from entries'),
        ).toEqual([{ value: 'outside' }]);
      }

      expect(
        sensitiveHelpers.filter(
          (helper) => typeof runtimePrototype[helper] === 'function',
        ),
      ).toEqual([]);
    } finally {
      releaseWait.resolve();
      await Promise.allSettled([failedTransaction, outsideWrite].filter(Boolean));
      await close();
    }
  });

  it('waits to close until an active transaction releases database ownership', async () => {
    const opened = openDatabase(':memory:');
    const transactionReachedWait = Promise.withResolvers<void>();
    const releaseWait = Promise.withResolvers<void>();
    let closed = false;

    try {
      await opened.database.execute('create table entries (value text not null)');
      const transaction = opened.database.transaction(async () => {
        transactionReachedWait.resolve();
        await releaseWait.promise;
      });

      await transactionReachedWait.promise;
      const closeDatabase = (opened as unknown as { close?: () => Promise<void> }).close;
      if (!closeDatabase) {
        throw new Error('openDatabase must expose an ownership-aware close method');
      }

      const close = closeDatabase().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);

      releaseWait.resolve();
      await transaction;
      await close;
      expect(closed).toBe(true);
    } finally {
      if ('close' in opened && typeof opened.close === 'function') {
        await opened.close();
      }
    }
  });

  it('keeps an unrelated write out of a transaction that later rolls back', async () => {
    const { database, close } = openDatabase(':memory:');
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
      await close();
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

  it('upgrades and reopens a pre-binding failed giveaway with its latest failed run bound', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-upgrade-'));
    const databasePath = join(directory, 'gift-bot.sqlite');
    const migrationPath = fileURLToPath(
      new URL('../../drizzle/0005_fixed_kitty_pryde.sql', import.meta.url),
    );
    let close: (() => Promise<void>) | undefined;

    try {
      const opened = openDatabase(databasePath);
      close = opened.close;
      await opened.database.execute(
        'create table giveaways (id text primary key, state text not null)',
      );
      await opened.database.execute(
        `create table publication_runs (
           id text primary key, giveaway_id text not null, status text not null,
           failure_stage text, finished_at integer
         )`,
      );
      await opened.database.execute(
        "insert into giveaways (id, state) values ('giveaway-1', 'failed')",
      );
      await opened.database.execute(
        `insert into publication_runs (
           id, giveaway_id, status, failure_stage, finished_at
         ) values
           ('old-run', 'giveaway-1', 'failed', 'send_unknown', 100),
           ('current-run', 'giveaway-1', 'failed', 'recovery_unknown_send', 200)`,
      );
      for (const statement of readFileSync(migrationPath, 'utf8')
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await opened.database.execute(statement);
      }
      await close();

      const reopened = openDatabase(databasePath);
      close = reopened.close;
      expect(
        await reopened.database.all(
          "select failure_run_id from giveaways where id = 'giveaway-1'",
        ),
      ).toEqual([{ failure_run_id: 'current-run' }]);
    } finally {
      await close?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
