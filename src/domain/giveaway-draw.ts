import { randomInt as cryptoRandomInt } from 'node:crypto';

export type EligibleDrawParticipant = {
  participantId: string;
  telegramUserId: number;
  username: string | null;
  displayName: string;
  inviterParticipantId: string | null;
};

export type DrawSnapshotParticipant = EligibleDrawParticipant & {
  validDirectReferralCount: number;
  ticketCount: number;
};

export type DrawSnapshot = {
  version: 1;
  createdAt: number;
  winnerCount: number;
  participants: DrawSnapshotParticipant[];
  ticketOrder: string[];
};

export type DrawPlace = {
  placeNumber: number;
  status: 'selected' | 'empty';
  participantId: string | null;
};

export function createDrawSnapshot(input: {
  participants: readonly EligibleDrawParticipant[];
  referralsEnabled: boolean;
  winnerCount: number;
  createdAt: number;
  randomInt?: (maximumExclusive: number) => number;
}): DrawSnapshot {
  const participantIds = new Set(
    input.participants.map((participant) => participant.participantId),
  );
  const directReferralCounts = new Map<string, number>();
  for (const participant of input.participants) {
    if (
      participant.inviterParticipantId &&
      participantIds.has(participant.inviterParticipantId)
    ) {
      directReferralCounts.set(
        participant.inviterParticipantId,
        (directReferralCounts.get(participant.inviterParticipantId) ?? 0) + 1,
      );
    }
  }

  const participants = input.participants.map((participant) => {
    const inviterParticipantId =
      participant.inviterParticipantId &&
      participantIds.has(participant.inviterParticipantId)
        ? participant.inviterParticipantId
        : null;
    const validDirectReferralCount = directReferralCounts.get(
      participant.participantId,
    ) ?? 0;
    return {
      ...participant,
      inviterParticipantId,
      validDirectReferralCount,
      ticketCount: input.referralsEnabled
        ? 1 + Math.floor(validDirectReferralCount / 3)
        : 1,
    };
  });
  const ticketOrder = participants.flatMap((participant) =>
    Array.from(
      { length: participant.ticketCount },
      () => participant.participantId,
    ),
  );
  const randomInt = input.randomInt ?? cryptoRandomInt;
  for (let index = ticketOrder.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [ticketOrder[index], ticketOrder[swapIndex]] = [
      ticketOrder[swapIndex]!,
      ticketOrder[index]!,
    ];
  }

  return {
    version: 1,
    createdAt: input.createdAt,
    winnerCount: input.winnerCount,
    participants,
    ticketOrder,
  };
}

export function selectInitialWinners(snapshot: DrawSnapshot): {
  places: DrawPlace[];
  cursor: number;
} {
  const selected = new Set<string>();
  const places: DrawPlace[] = [];
  let cursor = 0;
  while (places.length < snapshot.winnerCount && cursor < snapshot.ticketOrder.length) {
    const participantId = snapshot.ticketOrder[cursor]!;
    cursor += 1;
    if (selected.has(participantId)) continue;
    selected.add(participantId);
    places.push({
      placeNumber: places.length + 1,
      status: 'selected',
      participantId,
    });
  }
  while (places.length < snapshot.winnerCount) {
    places.push({
      placeNumber: places.length + 1,
      status: 'empty',
      participantId: null,
    });
  }
  return { places, cursor };
}

export function advanceReroll(input: {
  snapshot: DrawSnapshot;
  cursor: number;
  activeWinnerParticipantIds: ReadonlySet<string>;
  excludedParticipantIds: ReadonlySet<string>;
}): { participantId: string | null; cursor: number } {
  let cursor = input.cursor;
  while (cursor < input.snapshot.ticketOrder.length) {
    const participantId = input.snapshot.ticketOrder[cursor]!;
    cursor += 1;
    if (
      input.activeWinnerParticipantIds.has(participantId) ||
      input.excludedParticipantIds.has(participantId)
    ) {
      continue;
    }
    return { participantId, cursor };
  }
  return { participantId: null, cursor };
}
