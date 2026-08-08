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
    expect(message.text).toContain('Зарегистрировано участников: 0');
  });

  it('renders the supplied participant count without shifting source content', () => {
    const message = renderGiveawayMessage(
      {
        title: 'August giveaway',
        winnerCount: 1,
        deadlineUtc: Date.UTC(2026, 7, 10, 7, 30),
        referralsEnabled: false,
        content: { kind: 'text', text: 'Conditions' },
      },
      37,
    );

    expect(message.text).toContain('\nConditions\n');
    expect(message.text).toContain('Зарегистрировано участников: 37');
  });

  it('reserves enough Telegram capacity for a safe-integer participant count', () => {
    const base = {
      title: 'Limit',
      winnerCount: 1,
      deadlineUtc: Date.UTC(2026, 7, 10, 7, 30),
      referralsEnabled: false,
    } as const;

    const maximum = renderGiveawayMessage(
      { ...base, content: { kind: 'text' as const, text: '' } },
      Number.MAX_SAFE_INTEGER,
    ).text.length;
    const exactContent = 'x'.repeat(4096 - maximum);

    expect(() =>
      renderGiveawayMessage(
        { ...base, content: { kind: 'text', text: exactContent } },
        Number.MAX_SAFE_INTEGER,
      ),
    ).not.toThrow();
    expect(() =>
      renderGiveawayMessage(
        { ...base, content: { kind: 'text', text: `${exactContent}x` } },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow('Final giveaway message exceeds the Telegram length limit');
  });
});
