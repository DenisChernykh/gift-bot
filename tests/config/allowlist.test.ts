import { describe, expect, it } from 'vitest';

import { parseTeamTelegramIds } from '../../src/config/team-telegram-ids.js';

describe('parseTeamTelegramIds', () => {
  it('accepts comma-separated safe Telegram IDs and removes duplicates', () => {
    expect(parseTeamTelegramIds('42, 9007199254740991,42')).toEqual([
      42,
      9007199254740991,
    ]);
  });

  it('rejects non-numeric and unsafe identifiers', () => {
    expect(() => parseTeamTelegramIds('42,abc')).toThrow('TEAM_TELEGRAM_IDS');
    expect(() => parseTeamTelegramIds('9007199254740992')).toThrow(
      'TEAM_TELEGRAM_IDS',
    );
  });
});
