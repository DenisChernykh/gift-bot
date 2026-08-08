export type ParticipantMembership =
  | { status: 'creator' | 'administrator' | 'member' }
  | { status: 'restricted'; isMember: boolean }
  | { status: 'left' | 'kicked' | 'unknown' };

export function isEligibleParticipantMembership(
  membership: ParticipantMembership,
): boolean {
  if (membership.status === 'restricted') return membership.isMember;
  return ['creator', 'administrator', 'member'].includes(membership.status);
}

export function calculateTicketCount(validDirectReferrals: number): number {
  if (
    !Number.isSafeInteger(validDirectReferrals) ||
    validDirectReferrals < 0
  ) {
    throw new Error('Referral count must be a non-negative safe integer');
  }
  return 1 + Math.floor(validDirectReferrals / 3);
}
