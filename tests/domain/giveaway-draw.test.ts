import { describe, expect, it } from 'vitest';

import {
  advanceReroll,
  createDrawSnapshot,
  selectInitialWinners,
} from '../../src/domain/giveaway-draw.js';

const participants = [
  {
    participantId: 'alice',
    telegramUserId: 101,
    username: 'alice',
    displayName: 'Alice',
    inviterParticipantId: null,
  },
  {
    participantId: 'bob',
    telegramUserId: 102,
    username: null,
    displayName: 'Bob',
    inviterParticipantId: 'alice',
  },
  {
    participantId: 'carol',
    telegramUserId: 103,
    username: 'carol',
    displayName: 'Carol',
    inviterParticipantId: 'alice',
  },
  {
    participantId: 'dave',
    telegramUserId: 104,
    username: 'dave',
    displayName: 'Dave',
    inviterParticipantId: 'alice',
  },
] as const;

describe('giveaway draw domain', () => {
  it('freezes eligible referrals and ticket counts in the snapshot', () => {
    const snapshot = createDrawSnapshot({
      participants,
      referralsEnabled: true,
      winnerCount: 2,
      createdAt: 1_000,
      randomInt: () => 0,
    });

    expect(snapshot).toMatchObject({
      version: 1,
      createdAt: 1_000,
      winnerCount: 2,
      participants: [
        { participantId: 'alice', validDirectReferralCount: 3, ticketCount: 2 },
        { participantId: 'bob', validDirectReferralCount: 0, ticketCount: 1 },
        { participantId: 'carol', validDirectReferralCount: 0, ticketCount: 1 },
        { participantId: 'dave', validDirectReferralCount: 0, ticketCount: 1 },
      ],
    });
    expect(snapshot.ticketOrder).toHaveLength(5);
    expect(snapshot.ticketOrder.filter((id) => id === 'alice')).toHaveLength(2);
  });

  it('drops referral links whose inviter is absent from the eligible snapshot', () => {
    const snapshot = createDrawSnapshot({
      participants: [
        participants[0],
        {
          participantId: 'eve',
          telegramUserId: 105,
          username: 'eve',
          displayName: 'Eve',
          inviterParticipantId: 'ineligible-inviter',
        },
      ],
      referralsEnabled: true,
      winnerCount: 1,
      createdAt: 1_500,
      randomInt: () => 0,
    });

    expect(snapshot.participants[1]).toMatchObject({
      participantId: 'eve',
      inviterParticipantId: null,
      validDirectReferralCount: 0,
      ticketCount: 1,
    });
  });

  it('uses the injected Fisher-Yates source for a fully stored ticket order', () => {
    const maxima: number[] = [];
    const snapshot = createDrawSnapshot({
      participants: participants.slice(0, 3),
      referralsEnabled: false,
      winnerCount: 1,
      createdAt: 2_000,
      randomInt: (maximumExclusive) => {
        maxima.push(maximumExclusive);
        return 0;
      },
    });

    expect(maxima).toEqual([3, 2]);
    expect(snapshot.ticketOrder).toEqual(['bob', 'carol', 'alice']);
    expect(snapshot.participants.map((participant) => participant.ticketCount)).toEqual([
      1,
      1,
      1,
    ]);
  });

  it('selects unique winners and records empty places when candidates run out', () => {
    const snapshot = createDrawSnapshot({
      participants: participants.slice(0, 2),
      referralsEnabled: false,
      winnerCount: 3,
      createdAt: 3_000,
      randomInt: (maximumExclusive) => maximumExclusive - 1,
    });

    expect(selectInitialWinners(snapshot)).toEqual({
      cursor: 2,
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice' },
        { placeNumber: 2, status: 'selected', participantId: 'bob' },
        { placeNumber: 3, status: 'empty', participantId: null },
      ],
    });
  });

  it('continues the original order while excluding active and rejected winners', () => {
    const snapshot = {
      version: 1 as const,
      createdAt: 4_000,
      winnerCount: 2,
      participants: participants.map((participant) => ({
        ...participant,
        validDirectReferralCount: 0,
        ticketCount: 1,
      })),
      ticketOrder: ['alice', 'bob', 'alice', 'carol', 'dave'],
    };

    expect(
      advanceReroll({
        snapshot,
        cursor: 2,
        activeWinnerParticipantIds: new Set(['bob']),
        excludedParticipantIds: new Set(['alice']),
      }),
    ).toEqual({ participantId: 'carol', cursor: 4 });

    expect(
      advanceReroll({
        snapshot,
        cursor: 4,
        activeWinnerParticipantIds: new Set(['bob', 'carol']),
        excludedParticipantIds: new Set(['alice', 'dave']),
      }),
    ).toEqual({ participantId: null, cursor: 5 });
  });
});
