import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { drizzle } from 'drizzle-orm/sqlite-proxy';

import * as schema from './schema.js';

type DatabaseRow = Record<string, unknown>;

class DatabaseBoundary {
  private readonly transactionContext = new AsyncLocalStorage<DatabaseBoundary>();
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly sqlite: DatabaseSync) {}

  async execute(sql: string, parameters: SQLInputValue[] = []): Promise<void> {
    await this.exclusively(() => {
      this.sqlite.prepare(sql).run(...parameters);
    });
  }

  async all<Row extends DatabaseRow>(
    sql: string,
    parameters: SQLInputValue[] = [],
  ): Promise<Row[]> {
    return this.exclusively(() =>
      this.sqlite.prepare(sql).all(...parameters) as Row[],
    );
  }

  async values(
    sql: string,
    parameters: SQLInputValue[] = [],
  ): Promise<unknown[][]> {
    return this.exclusively(() => {
      const statement = this.sqlite.prepare(sql);
      statement.setReturnArrays(true);
      return statement.all(...parameters) as unknown as unknown[][];
    });
  }

  async transaction<Result>(
    operation: (transaction: DatabaseBoundary) => Promise<Result>,
  ): Promise<Result> {
    const release = await this.acquire();

    try {
      this.sqlite.exec('BEGIN');
      return await this.transactionContext.run(this, async () => {
        try {
          const result = await operation(this);
          this.sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          this.sqlite.exec('ROLLBACK');
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  private async exclusively<Result>(operation: () => Result): Promise<Result> {
    if (this.transactionContext.getStore() === this) {
      return operation();
    }

    const release = await this.acquire();
    try {
      return operation();
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }

    this.locked = false;
  }
}

export function openDatabase(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.enableDefensive(true);

  const database = createDatabaseBoundary(sqlite);
  return { sqlite, database };
}

export function createDatabaseBoundary(sqlite: DatabaseSync): DatabaseBoundary {
  return new DatabaseBoundary(sqlite);
}

export function createDatabaseProxy(database: DatabaseBoundary) {
  return drizzle(
    async (sql, parameters, method) => {
      switch (method) {
        case 'run':
          await database.execute(sql, parameters);
          return { rows: [] };
        case 'get': {
          const rows = await database.values(sql, parameters);
          return { rows: rows[0] ?? (undefined as never) };
        }
        case 'all':
        case 'values':
          return { rows: await database.values(sql, parameters) };
      }
    },
    { schema },
  );
}
