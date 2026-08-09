import { describe, expect, it } from 'vitest';

import { parseProductionEnvironment } from '../../src/operations/macos-production-config.js';

const productionDatabasePath =
  '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite';
const valid = [
  'BOT_TOKEN=1234567890:local_test_value',
  'TEAM_TELEGRAM_IDS=465050746,7607308401',
  `DATABASE_PATH="${productionDatabasePath}"`,
  'LOG_LEVEL=info',
  'DRAW_MEMBERSHIP_CONCURRENCY=10',
].join('\n');

function parse(contents = valid, overrides: Partial<Parameters<typeof parseProductionEnvironment>[0]> = {}) {
  return parseProductionEnvironment({
    contents: Buffer.from(contents),
    mode: 0o100600,
    ownerUid: 501,
    expectedUid: 501,
    repoRoot: '/Users/tatiana/projects/gift-bot',
    expectedDatabasePath: productionDatabasePath,
    ...overrides,
  });
}

describe('production environment preflight', () => {
  it('returns the validated runtime values', () => {
    expect(parse()).toEqual({
      botToken: '1234567890:local_test_value',
      teamTelegramIds: [465050746, 7607308401],
      databasePath: productionDatabasePath,
      logLevel: 'info',
      drawMembershipConcurrency: 10,
    });
  });

  it.each([
    { mode: 0o100644, ownerUid: 501, message: 'mode 0600' },
    { mode: 0o100600, ownerUid: 502, message: 'current user' },
  ])('rejects unsafe ownership before returning secrets', (input) => {
    expect(() =>
      parse(valid, { mode: input.mode, ownerUid: input.ownerUid }),
    ).toThrow(input.message);
  });

  it.each([
    '.data/gift-bot.sqlite',
    '/Users/tatiana/projects/gift-bot/.data/gift-bot.sqlite',
    '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/gift-bot.sqlite',
  ])('rejects non-canonical database path %s', (databasePath) => {
    expect(() =>
      parse(valid.replace(productionDatabasePath, databasePath)),
    ).toThrow('DATABASE_PATH');
  });

  it.each([
    ['BOT_TOKEN=1234567890:local_test_value', 'BOT_TOKEN=', 'BOT_TOKEN'],
    ['TEAM_TELEGRAM_IDS=465050746,7607308401', 'TEAM_TELEGRAM_IDS=', 'TEAM_TELEGRAM_IDS'],
    ['TEAM_TELEGRAM_IDS=465050746,7607308401', 'TEAM_TELEGRAM_IDS=,', 'TEAM_TELEGRAM_IDS'],
    ['LOG_LEVEL=info', 'LOG_LEVEL=debug', 'LOG_LEVEL'],
    ['DRAW_MEMBERSHIP_CONCURRENCY=10', 'DRAW_MEMBERSHIP_CONCURRENCY=0', 'DRAW_MEMBERSHIP_CONCURRENCY'],
    ['DRAW_MEMBERSHIP_CONCURRENCY=10', 'DRAW_MEMBERSHIP_CONCURRENCY=', 'DRAW_MEMBERSHIP_CONCURRENCY'],
  ])('rejects invalid %s without echoing the token', (from, to, message) => {
    let thrown: unknown;
    try {
      parse(valid.replace(from, to));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(message);
    expect((thrown as Error).message).not.toContain('local_test_value');
  });
});
