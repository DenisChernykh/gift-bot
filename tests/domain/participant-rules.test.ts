import { describe, expect, it } from 'vitest';

import {
  calculateTicketCount,
  isEligibleParticipantMembership,
} from '../../src/domain/participant-rules.js';

describe('participant eligibility', () => {
  it.each([
    [{ status: 'creator' as const }, true],
    [{ status: 'administrator' as const }, true],
    [{ status: 'member' as const }, true],
    [{ status: 'restricted' as const, isMember: true }, true],
    [{ status: 'restricted' as const, isMember: false }, false],
    [{ status: 'left' as const }, false],
    [{ status: 'kicked' as const }, false],
    [{ status: 'unknown' as const }, false],
  ])('maps Telegram membership %o to %s', (membership, expected) => {
    expect(isEligibleParticipantMembership(membership)).toBe(expected);
  });
});

describe('referral tickets', () => {
  it.each([
    [0, 1],
    [2, 1],
    [3, 2],
    [6, 3],
  ])('maps %d direct referrals to %d tickets', (referrals, expected) => {
    expect(calculateTicketCount(referrals)).toBe(expected);
  });

  it('rejects negative or fractional referral counts', () => {
    expect(() => calculateTicketCount(-1)).toThrow();
    expect(() => calculateTicketCount(1.5)).toThrow();
  });
});
