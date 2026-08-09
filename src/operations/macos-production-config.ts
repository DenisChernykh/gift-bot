import { isAbsolute, relative } from 'node:path';

import { parse } from 'dotenv';

import { parseDrawMembershipConcurrency } from '../config/draw.js';
import { parseLogLevel, type LogLevel } from '../config/log-level.js';
import { parseTeamTelegramIds } from '../config/team-telegram-ids.js';

export type ProductionEnvironment = {
  botToken: string;
  teamTelegramIds: number[];
  databasePath: string;
  logLevel: LogLevel;
  drawMembershipConcurrency: number;
};

export function parseProductionEnvironment(input: {
  contents: Buffer;
  mode: number;
  ownerUid: number;
  expectedUid: number;
  repoRoot: string;
  expectedDatabasePath: string;
}): ProductionEnvironment {
  if ((input.mode & 0o777) !== 0o600) {
    throw new Error('Production env must use mode 0600');
  }
  if (input.ownerUid !== input.expectedUid) {
    throw new Error('Production env must belong to the current user');
  }

  const values = parse(input.contents);
  const required = (name: string): string => {
    const value = values[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const databasePath = required('DATABASE_PATH');
  const relativeDatabasePath = relative(input.repoRoot, databasePath);
  if (
    !isAbsolute(databasePath) ||
    (!relativeDatabasePath.startsWith('..') && relativeDatabasePath !== '..') ||
    databasePath !== input.expectedDatabasePath
  ) {
    throw new Error(
      'DATABASE_PATH must equal the production data path outside the checkout',
    );
  }

  const logLevel = parseLogLevel(required('LOG_LEVEL'));

  const teamTelegramIds = parseTeamTelegramIds(required('TEAM_TELEGRAM_IDS'));
  if (teamTelegramIds.length === 0) {
    throw new Error('TEAM_TELEGRAM_IDS must contain at least one operator');
  }

  return {
    botToken: required('BOT_TOKEN'),
    teamTelegramIds,
    databasePath,
    logLevel,
    drawMembershipConcurrency: parseDrawMembershipConcurrency(
      required('DRAW_MEMBERSHIP_CONCURRENCY'),
    ),
  };
}
