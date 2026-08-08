import { DatabaseSync } from 'node:sqlite';

import { drizzle } from 'drizzle-orm/sqlite-proxy';

import * as schema from './schema.js';

export function openDatabase(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.enableDefensive(true);

  return { sqlite, db: createDatabaseProxy(sqlite) };
}

export function createDatabaseProxy(sqlite: DatabaseSync) {
  return drizzle(
    async (sql, parameters, method) => {
      const statement = sqlite.prepare(sql);

      switch (method) {
        case 'all':
          return { rows: statement.all(...parameters) };
        case 'get': {
          const row = statement.get(...parameters);
          return { rows: row === undefined ? [] : [row] };
        }
        case 'values':
          return { rows: statement.all(...parameters) };
        case 'run':
          return { rows: [statement.run(...parameters)] };
      }
    },
    { schema },
  );

}
