import { describe, expect, it } from 'vitest';

import { renderGiveawayResult } from '../../src/domain/giveaway-result-rendering.js';

describe('giveaway result rendering', () => {
  it('renders only current places and uses a safe Telegram user link without username', () => {
    const rendered = renderGiveawayResult({
      title: 'August gift',
      kind: 'text',
      eligibleParticipantCount: 2,
      places: [
        {
          placeNumber: 1,
          participant: {
            telegramUserId: 101,
            username: 'alice',
            displayName: 'Alice',
          },
        },
        {
          placeNumber: 2,
          participant: {
            telegramUserId: 102,
            username: null,
            displayName: 'Боб',
          },
        },
        { placeNumber: 3, participant: null },
      ],
    });

    expect(rendered.text).toBe(
      [
        'August gift',
        '',
        'Итоги:',
        '1. @alice',
        '2. Боб',
        '3. Место не заполнено',
      ].join('\n'),
    );
    expect(rendered.entities).toEqual([
      {
        type: 'text_link',
        offset: rendered.text.indexOf('Боб'),
        length: 3,
        url: 'tg://user?id=102',
      },
    ]);
    expect(rendered.text).not.toContain('билет');
    expect(rendered.text).not.toContain('причин');
  });

  it('states explicitly when no participant was eligible', () => {
    expect(
      renderGiveawayResult({
        title: 'Empty gift',
        kind: 'photo',
        eligibleParticipantCount: 0,
        places: [
          { placeNumber: 1, participant: null },
          { placeNumber: 2, participant: null },
        ],
      }).text,
    ).toBe(
      [
        'Empty gift',
        '',
        'Итоги:',
        'Подходящих участников нет.',
        '1. Место не заполнено',
        '2. Место не заполнено',
      ].join('\n'),
    );
  });

  it('rejects a result that exceeds the Telegram text or caption limit', () => {
    expect(() =>
      renderGiveawayResult({
        title: 'x'.repeat(4_090),
        kind: 'text',
        eligibleParticipantCount: 0,
        places: [],
      }),
    ).toThrow('Telegram length');
    expect(() =>
      renderGiveawayResult({
        title: 'x'.repeat(1_020),
        kind: 'photo',
        eligibleParticipantCount: 0,
        places: [],
      }),
    ).toThrow('Telegram length');
  });
});
