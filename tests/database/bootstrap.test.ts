import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/database/client.js';
import {
  migrateDatabase,
  migrateDatabaseAt,
} from '../../src/database/migrate.js';

describe('SQLite bootstrap', () => {
  it('enables safety pragmas and creates every Task 1 table through migrations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-test-'));
    const databasePath = join(directory, 'gift-bot.sqlite');

    try {
      const { sqlite } = openDatabase(databasePath);
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
      rmSync(directory, { force: true, recursive: true });
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
