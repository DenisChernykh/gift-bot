import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import 'dotenv/config';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';

import { createDatabaseProxy, openDatabase } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function migrateDatabase(sqlite: DatabaseSync): Promise<void> {
  await migrate(
    createDatabaseProxy(sqlite),
    async (queries) => {
      sqlite.exec('BEGIN');
      try {
        for (const query of queries) {
          sqlite.exec(query);
        }
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    { migrationsFolder },
  );
}

export async function migrateDatabaseAt(databasePath: string): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { sqlite } = openDatabase(databasePath);
  await migrateDatabase(sqlite);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath) {
    throw new Error('DATABASE_PATH is required');
  }

  await migrateDatabaseAt(databasePath);
}
