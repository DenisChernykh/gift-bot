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

  it('calculates entity offsets from the result line instead of matching the title', () => {
    const rendered = renderGiveawayResult({
      title: '1. Боб',
      kind: 'text',
      eligibleParticipantCount: 1,
      places: [
        {
          placeNumber: 1,
          participant: {
            telegramUserId: 102,
            username: null,
            displayName: 'Боб',
          },
        },
      ],
    });

    expect(rendered.entities).toEqual([
      {
        type: 'text_link',
        offset: rendered.text.lastIndexOf('Боб'),
        length: 3,
        url: 'tg://user?id=102',
      },
    ]);
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

  it.each([
    ['text', 4_096],
    ['photo', 1_024],
  ] as const)(
    'keeps every one of 50 valid places inside the Telegram %s limit',
    (kind, maximumLength) => {
      const rendered = renderGiveawayResult({
        title: 'П'.repeat(100),
        kind,
        eligibleParticipantCount: 50,
        places: Array.from({ length: 50 }, (_, index) => ({
          placeNumber: index + 1,
          participant: {
            telegramUserId: 10_000 + index,
            username: index % 2 === 0 ? `user_${'x'.repeat(25)}${index}` : null,
            displayName: `${'Очень длинное имя '.repeat(7)}${index}`,
          },
        })),
      });

      expect(rendered.text.length).toBeLessThanOrEqual(maximumLength);
      for (let placeNumber = 1; placeNumber <= 50; placeNumber += 1) {
        expect(rendered.text).toContain(`${placeNumber}. `);
      }
      expect(rendered.entities).toHaveLength(50);
      for (const entity of rendered.entities) {
        expect(entity.url).toMatch(/^tg:\/\/user\?id=\d+$/);
        expect(
          rendered.text.slice(entity.offset, entity.offset + entity.length),
        ).not.toHaveLength(0);
      }
    },
  );
});
