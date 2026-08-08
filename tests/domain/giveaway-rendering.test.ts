import { describe, expect, it } from 'vitest';

import {
  formatGiveawayDeadline,
  renderGiveawayMessage,
} from '../../src/domain/giveaway-rendering.js';

describe('giveaway rendering', () => {
  it('round-trips a stored UTC deadline in the product timezone', () => {
    expect(formatGiveawayDeadline(Date.UTC(2026, 7, 10, 7, 30))).toBe(
      '10.08.2026 12:30',
    );
  });

  it('rejects a final message that exceeds the Telegram limit after metadata is rendered', () => {
    expect(() =>
      renderGiveawayMessage({
        title: 'August giveaway',
        winnerCount: 1,
        deadlineUtc: Date.UTC(2026, 7, 10, 7, 30),
        referralsEnabled: false,
        content: { kind: 'text', text: 'a'.repeat(4096) },
      }),
    ).toThrow();
  });

  it('renders a caption within the final photo limit', () => {
    const message = renderGiveawayMessage({
      title: 'August giveaway',
      winnerCount: 1,
      deadlineUtc: Date.UTC(2026, 7, 10, 7, 30),
      referralsEnabled: true,
      content: { kind: 'photo', caption: 'Photo conditions' },
    });

    expect(message.kind).toBe('photo');
    expect(message.text.length).toBeLessThanOrEqual(1024);
    expect(message.text).toContain('10.08.2026 12:30');
  });
});
