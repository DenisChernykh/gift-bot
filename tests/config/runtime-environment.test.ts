import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRuntimeEnvironment } from '../../src/config/runtime-environment.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function environmentFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gift-bot-runtime-env-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'production.env');
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

describe('runtime environment loading', () => {
  it('loads the authoritative UTF-8 file despite hostile inherited dotenv controls', async () => {
    const path = await environmentFile(
      [
        'BOT_TOKEN=validated-token',
        'TEAM_TELEGRAM_IDS=101,202',
        'DATABASE_PATH=/validated/data/gift-bot.sqlite',
        'LOG_LEVEL=" error "',
        'DRAW_MEMBERSHIP_CONCURRENCY=7',
      ].join('\n'),
    );
    await writeFile(`${path}.vault`, 'not an encrypted dotenv vault');
    const environment: NodeJS.ProcessEnv = {
      DOTENV_CONFIG_PATH: path,
      DOTENV_CONFIG_OVERRIDE: 'true',
      DOTENV_CONFIG_ENCODING: 'utf16le',
      DOTENV_KEY:
        'dotenv://:key_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef@dotenvx.com/vault/.env.vault?environment=production',
      DOTENV_CONFIG_DOTENV_KEY:
        'dotenv://:key_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890@dotenvx.com/vault/.env.vault?environment=production',
      BOT_TOKEN: 'stale-token',
      TEAM_TELEGRAM_IDS: '999',
      DATABASE_PATH: '/stale/gift-bot.sqlite',
      LOG_LEVEL: 'info',
      DRAW_MEMBERSHIP_CONCURRENCY: '99',
    };

    loadRuntimeEnvironment(environment);

    expect(environment).toMatchObject({
      BOT_TOKEN: 'validated-token',
      TEAM_TELEGRAM_IDS: '101,202',
      DATABASE_PATH: '/validated/data/gift-bot.sqlite',
      LOG_LEVEL: ' error ',
      DRAW_MEMBERSHIP_CONCURRENCY: '7',
    });
  });

  it('removes stale application values that are absent from an authoritative file', async () => {
    const path = await environmentFile('BOT_TOKEN=validated-token');
    const environment: NodeJS.ProcessEnv = {
      DOTENV_CONFIG_PATH: path,
      DOTENV_CONFIG_OVERRIDE: 'true',
      BOT_TOKEN: 'stale-token',
      TEAM_TELEGRAM_IDS: '999',
      DATABASE_PATH: '/stale/gift-bot.sqlite',
      LOG_LEVEL: 'error',
      DRAW_MEMBERSHIP_CONCURRENCY: '99',
    };

    loadRuntimeEnvironment(environment);

    expect(environment.BOT_TOKEN).toBe('validated-token');
    expect(environment.TEAM_TELEGRAM_IDS).toBeUndefined();
    expect(environment.DATABASE_PATH).toBeUndefined();
    expect(environment.LOG_LEVEL).toBeUndefined();
    expect(environment.DRAW_MEMBERSHIP_CONCURRENCY).toBeUndefined();
  });

  it('preserves ordinary ambient precedence when authoritative mode is absent', async () => {
    const path = await environmentFile('BOT_TOKEN=file-token');
    const environment: NodeJS.ProcessEnv = {
      DOTENV_CONFIG_PATH: path,
      BOT_TOKEN: 'ambient-token',
    };

    loadRuntimeEnvironment(environment);

    expect(environment.BOT_TOKEN).toBe('ambient-token');
  });
});
