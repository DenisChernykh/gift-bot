import { describe, expect, it } from 'vitest';

import { GiveawayDrawService } from '../../src/application/giveaway-draw-service.js';
import type {
  CompletedDraw,
  DrawRepository,
  DrawTarget,
} from '../../src/application/ports/draw-repository.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';
import type { DrawPlace, DrawSnapshot } from '../../src/domain/giveaway-draw.js';
import type { ParticipantMembership } from '../../src/domain/participant-rules.js';

const NOW = Date.UTC(2026, 7, 9, 11, 0);

function target(overrides: Partial<DrawTarget> = {}): DrawTarget {
  return {
    id: 'giveaway-1',
    title: 'Gift',
    state: 'drawing',
    winnerCount: 2,
    deadlineUtc: NOW - 1,
    referralsEnabled: true,
    createdByTelegramId: 700,
    channels: [
      { id: 'channel-1', telegramChatId: -1001, username: 'one', title: 'One' },
      { id: 'channel-2', telegramChatId: -1002, username: 'two', title: 'Two' },
    ],
    participants: [
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
    ],
    snapshot: null,
    ...overrides,
  };
}

class FakeDrawRepository implements DrawRepository {
  due: DrawTarget[] = [];
  drawing: DrawTarget[] = [];
  readonly savedSnapshots: DrawSnapshot[] = [];
  readonly completions: Array<{ places: DrawPlace[]; cursor: number }> = [];
  readonly failures: Array<{ stage: string; errorKind: string }> = [];
  retryResult = false;
  completionError: Error | null = null;

  claimNextDue(): Promise<DrawTarget | null> {
    return Promise.resolve(this.due.shift() ?? null);
  }
  listDrawing(): Promise<DrawTarget[]> {
    return Promise.resolve([...this.drawing]);
  }
  getDrawing(giveawayId: string): Promise<DrawTarget | null> {
    return Promise.resolve(
      [...this.drawing, ...this.due].find((item) => item.id === giveawayId) ?? null,
    );
  }
  saveSnapshot(input: { snapshot: DrawSnapshot }): Promise<DrawSnapshot> {
    this.savedSnapshots.push(input.snapshot);
    return Promise.resolve(input.snapshot);
  }
  completeDraw(input: {
    giveawayId: string;
    places: DrawPlace[];
    cursor: number;
  }): Promise<CompletedDraw> {
    if (this.completionError) return Promise.reject(this.completionError);
    this.completions.push({ places: input.places, cursor: input.cursor });
    const snapshot = this.savedSnapshots.at(-1) ?? target().snapshot!;
    return Promise.resolve({
      giveawayId: input.giveawayId,
      title: 'Gift',
      snapshot,
      cursor: input.cursor,
      resultRevision: 1,
      places: [],
      excludedParticipantIds: [],
    });
  }
  failDraw(input: { stage: string; errorKind: string }): Promise<void> {
    this.failures.push(input);
    return Promise.resolve();
  }
  retryFailedDraw(): Promise<boolean> {
    return Promise.resolve(this.retryResult);
  }
  getCompletedDraw(): Promise<CompletedDraw | null> {
    return Promise.resolve(null);
  }
}

class FakeDrawGateway {
  channelFailures: Error[] = [];
  membershipFailures: Error[] = [];
  memberships = new Map<number, ParticipantMembership>([
    [101, { status: 'member' }],
    [102, { status: 'member' }],
  ]);
  channelCalls = 0;
  membershipCalls = 0;
  active = 0;
  maximumActive = 0;
  gate: Promise<void> | null = null;
  membershipStarted: (() => void) | null = null;

  async getChannelSnapshot(chatId: number) {
    this.channelCalls += 1;
    const failure = this.channelFailures.shift();
    if (failure) throw failure;
    return {
      username: chatId === -1001 ? 'one' : 'two',
      title: chatId === -1001 ? 'One' : 'Two',
      membership: {
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      },
    };
  }

  async getParticipantMembership(
    _chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership> {
    this.membershipCalls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.membershipStarted?.();
    try {
      await this.gate;
      const failure = this.membershipFailures.shift();
      if (failure) throw failure;
      return this.memberships.get(telegramUserId) ?? { status: 'left' };
    } finally {
      this.active -= 1;
    }
  }
}

function createService(
  repository: FakeDrawRepository,
  gateway: FakeDrawGateway,
  overrides: { sleep?: (milliseconds: number) => Promise<void>; concurrency?: number } = {},
) {
  return new GiveawayDrawService(repository, gateway, {
    now: () => NOW,
    randomInt: (maximumExclusive) => maximumExclusive - 1,
    sleep: overrides.sleep ?? (async () => undefined),
    membershipConcurrency: overrides.concurrency ?? 10,
    teamTelegramIds: [700, 701],
  });
}

describe('GiveawayDrawService', () => {
  it('finalizes eligible participants and publishes completion without a review gate', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(target());
    const gateway = new FakeDrawGateway();

    expect(await createService(repository, gateway).processDue()).toBe(1);

    expect(repository.savedSnapshots).toHaveLength(1);
    expect(repository.completions).toEqual([
      {
        cursor: 2,
        places: [
          { placeNumber: 1, status: 'selected', participantId: 'alice' },
          { placeNumber: 2, status: 'selected', participantId: 'bob' },
        ],
      },
    ]);
    expect(repository.failures).toEqual([]);
  });

  it('excludes definite non-members but fails closed for an unknown membership', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(target());
    const gateway = new FakeDrawGateway();
    gateway.memberships.set(101, { status: 'left' });
    gateway.memberships.set(102, { status: 'unknown' });

    await createService(repository, gateway).processDue();

    expect(repository.savedSnapshots).toEqual([]);
    expect(repository.completions).toEqual([]);
    expect(repository.failures).toEqual([
      expect.objectContaining({
        stage: 'final_eligibility',
        errorKind: 'membership_unknown',
      }),
    ]);
  });

  it('fails when the giveaway no longer has a confirmed public channel', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(target({ channels: [] }));

    await createService(repository, new FakeDrawGateway()).processDue();

    expect(repository.completions).toEqual([]);
    expect(repository.failures).toEqual([
      expect.objectContaining({
        stage: 'final_eligibility',
        errorKind: 'channel_missing',
      }),
    ]);
  });

  it('honors retry_after and retries a retryable Telegram failure at most three times', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(target({ channels: target().channels.slice(0, 1) }));
    const gateway = new FakeDrawGateway();
    gateway.channelFailures.push(
      new TelegramDeliveryError('rate limit', 'definite', 9_000),
      new TelegramDeliveryError('server', 'unknown'),
    );
    const delays: number[] = [];

    await createService(repository, gateway, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }).processDue();

    expect(gateway.channelCalls).toBe(3);
    expect(delays).toEqual([9_000, 500]);
    expect(repository.completions).toHaveLength(1);
  });

  it('limits concurrent participant membership reads', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(
      target({
        participants: Array.from({ length: 6 }, (_, index) => ({
          participantId: `participant-${index}`,
          telegramUserId: 200 + index,
          username: null,
          displayName: `Participant ${index}`,
          inviterParticipantId: null,
        })),
        channels: target().channels.slice(0, 1),
      }),
    );
    const gateway = new FakeDrawGateway();
    for (let index = 0; index < 6; index += 1) {
      gateway.memberships.set(200 + index, { status: 'member' });
    }
    let release!: () => void;
    gateway.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const twoStarted = Promise.withResolvers<void>();
    gateway.membershipStarted = () => {
      if (gateway.active === 2) twoStarted.resolve();
    };

    const processing = createService(repository, gateway, {
      concurrency: 2,
    }).processDue();
    await twoStarted.promise;
    expect(gateway.maximumActive).toBe(2);
    release();
    await processing;
    expect(gateway.maximumActive).toBe(2);
  });

  it('waits for in-flight membership reads before persisting a concurrent failure', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(
      target({ channels: target().channels.slice(0, 1) }),
    );
    const siblingStarted = Promise.withResolvers<void>();
    const releaseSibling = Promise.withResolvers<void>();
    const gateway = {
      getChannelSnapshot: async () => ({
        username: 'one',
        title: 'One',
        membership: {
          status: 'administrator' as const,
          canPostMessages: true,
          canEditMessages: true,
          canDeleteMessages: true,
        },
      }),
      getParticipantMembership: async (
        _chatId: number,
        telegramUserId: number,
      ): Promise<ParticipantMembership> => {
        if (telegramUserId === 101) return { status: 'unknown' };
        siblingStarted.resolve();
        await releaseSibling.promise;
        return { status: 'member' };
      },
    };

    const processing = createService(
      repository,
      gateway as FakeDrawGateway,
      { concurrency: 2 },
    ).processDue();
    await siblingStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repository.failures).toEqual([]);

    releaseSibling.resolve();
    await processing;
    expect(repository.failures).toEqual([
      expect.objectContaining({ errorKind: 'membership_unknown' }),
    ]);
  });

  it('continues a stored snapshot after restart without rechecking or reshuffling', async () => {
    const saved: DrawSnapshot = {
      version: 1,
      createdAt: NOW - 100,
      winnerCount: 1,
      participants: [
        {
          participantId: 'alice',
          telegramUserId: 101,
          username: 'alice',
          displayName: 'Alice',
          inviterParticipantId: null,
          validDirectReferralCount: 0,
          ticketCount: 1,
        },
      ],
      ticketOrder: ['alice'],
    };
    const repository = new FakeDrawRepository();
    repository.drawing.push(target({ snapshot: saved, winnerCount: 1 }));
    const gateway = new FakeDrawGateway();

    expect(await createService(repository, gateway).recoverDrawing()).toBe(1);

    expect(gateway.channelCalls).toBe(0);
    expect(gateway.membershipCalls).toBe(0);
    expect(repository.savedSnapshots).toEqual([]);
    expect(repository.completions[0]).toEqual({
      cursor: 1,
      places: [{ placeNumber: 1, status: 'selected', participantId: 'alice' }],
    });
  });

  it('reports a post-snapshot failure as selection instead of final eligibility', async () => {
    const repository = new FakeDrawRepository();
    repository.due.push(target());
    repository.completionError = new Error('database write failed');

    await createService(repository, new FakeDrawGateway()).processDue();

    expect(repository.savedSnapshots).toHaveLength(1);
    expect(repository.failures).toEqual([
      expect.objectContaining({ stage: 'selection', errorKind: 'unexpected' }),
    ]);
  });
});
