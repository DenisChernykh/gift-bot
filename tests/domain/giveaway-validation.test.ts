import { describe, expect, it } from 'vitest';

import {
  parseGiveawayDeadline,
  validateGiveawayContent,
  validateGiveawayTitle,
  validateWinnerCount,
} from '../../src/domain/giveaway-validation.js';

describe('giveaway field validation', () => {
  it('accepts an internal title of 100 characters and rejects 101', () => {
    expect(validateGiveawayTitle('  August giveaway  ')).toBe('August giveaway');
    expect(validateGiveawayTitle('a'.repeat(100))).toHaveLength(100);
    expect(() => validateGiveawayTitle('   ')).toThrow();
    expect(() => validateGiveawayTitle('a'.repeat(101))).toThrow();
  });

  it('accepts only integer winner counts from one through fifty', () => {
    expect(validateWinnerCount(1)).toBe(1);
    expect(validateWinnerCount(50)).toBe(50);
    expect(() => validateWinnerCount(0)).toThrow();
    expect(() => validateWinnerCount(1.5)).toThrow();
    expect(() => validateWinnerCount(51)).toThrow();
  });

  it('converts an exact future Yekaterinburg deadline into UTC milliseconds', () => {
    expect(
      parseGiveawayDeadline('10.08.2026 12:30', Date.UTC(2026, 7, 8, 0, 0)),
    ).toBe(Date.UTC(2026, 7, 10, 7, 30));
    expect(() =>
      parseGiveawayDeadline('31.02.2026 12:30', Date.UTC(2026, 0, 1)),
    ).toThrow();
    expect(() =>
      parseGiveawayDeadline('08.08.2026 05:00', Date.UTC(2026, 7, 8, 0, 0)),
    ).toThrow();
  });

  it('allows text or one photo caption within Telegram limits', () => {
    expect(validateGiveawayContent({ kind: 'text', text: '  Hello  ' })).toEqual({
      kind: 'text',
      text: 'Hello',
    });
    expect(
      validateGiveawayContent({ kind: 'photo', caption: 'Photo conditions' }),
    ).toEqual({ kind: 'photo', caption: 'Photo conditions' });
    expect(() => validateGiveawayContent({ kind: 'text', text: ' ' })).toThrow();
    expect(() =>
      validateGiveawayContent({ kind: 'text', text: 'a'.repeat(4097) }),
    ).toThrow();
    expect(() =>
      validateGiveawayContent({ kind: 'photo', caption: 'a'.repeat(1025) }),
    ).toThrow();
  });
});
