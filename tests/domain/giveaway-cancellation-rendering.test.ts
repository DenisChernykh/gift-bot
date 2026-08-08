import { describe, expect, it } from 'vitest';

import { renderCancelledGiveawayMessage } from '../../src/domain/giveaway-cancellation-rendering.js';

const SUFFIX = '\n\nРозыгрыш отменён.';

describe('renderCancelledGiveawayMessage', () => {
  it('preserves the cancellation suffix within the 4096-unit text limit', () => {
    const rendered = renderCancelledGiveawayMessage('x'.repeat(4096), 'text');

    expect(rendered).toHaveLength(4096);
    expect(rendered.endsWith(SUFFIX)).toBe(true);
    expect(rendered.startsWith('x')).toBe(true);
  });

  it('preserves the cancellation suffix within the 1024-unit caption limit', () => {
    const rendered = renderCancelledGiveawayMessage('x'.repeat(1024), 'photo');

    expect(rendered).toHaveLength(1024);
    expect(rendered.endsWith(SUFFIX)).toBe(true);
    expect(rendered.startsWith('x')).toBe(true);
  });

  it('does not leave a dangling UTF-16 surrogate when truncating', () => {
    const rendered = renderCancelledGiveawayMessage(
      `${'x'.repeat(4095)}😀`,
      'text',
    );
    const prefix = rendered.slice(0, -SUFFIX.length);

    expect(rendered.length).toBeLessThanOrEqual(4096);
    expect(prefix.charCodeAt(prefix.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });
});
