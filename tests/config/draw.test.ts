import { describe, expect, it } from 'vitest';

import { parseDrawMembershipConcurrency } from '../../src/config/draw.js';

describe('draw configuration', () => {
  it('defaults to ten and accepts a positive integer override', () => {
    expect(parseDrawMembershipConcurrency(undefined)).toBe(10);
    expect(parseDrawMembershipConcurrency(' 4 ')).toBe(4);
  });

  it.each(['0', '-1', '1.5', 'many'])('rejects invalid concurrency %s', (value) => {
    expect(() => parseDrawMembershipConcurrency(value)).toThrow(
      'DRAW_MEMBERSHIP_CONCURRENCY',
    );
  });
});
