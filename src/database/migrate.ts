import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import 'dotenv/config';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';

import {
  createDatabaseBoundary,
  createDatabaseProxy,
  openDatabase,
} from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function migrateDatabase(sqlite: DatabaseSync): Promise<void> {
  const database = createDatabaseBoundary(sqlite);

  await migrate(
    createDatabaseProxy(database),
    async (queries) =>
      database.transaction(async (transaction) => {
        for (const query of queries) {
          await transaction.execute(query);
        }
      }),
    { migrationsFolder },
  );
}

export async function migrateDatabaseAt(databasePath: string): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { sqlite } = openDatabase(databasePath);
  try {
    await migrateDatabase(sqlite);
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath) {
    throw new Error('DATABASE_PATH is required');
  }

  await migrateDatabaseAt(databasePath);
}
