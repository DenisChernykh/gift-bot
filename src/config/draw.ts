export function parseDrawMembershipConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 10;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      'DRAW_MEMBERSHIP_CONCURRENCY must be a positive safe integer',
    );
  }
  return parsed;
}
