import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';

import {
  createDatabaseProxy,
  openDatabase,
  type DatabaseBoundary,
} from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function migrateDatabase(database: DatabaseBoundary): Promise<void> {
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
  const { database, close } = openDatabase(databasePath);
  try {
    await migrateDatabase(database);
  } finally {
    await close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath) {
    throw new Error('DATABASE_PATH is required');
  }

  await migrateDatabaseAt(databasePath);
}
