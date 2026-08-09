import { describe, expect, it } from 'vitest';

import { GiveawayRerollService } from '../../src/application/giveaway-reroll-service.js';
import type {
  RerollAuditEntry,
  RerollContext,
  RerollRepository,
  RerollResult,
  RerollSession,
} from '../../src/application/ports/reroll-repository.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';
import type { ParticipantMembership } from '../../src/domain/participant-rules.js';

const NOW = Date.UTC(2026, 7, 9, 13, 0);

function context(): RerollContext {
  const participants = [
    ['alice', 101],
    ['bob', 102],
    ['carol', 103],
    ['dave', 104],
  ].map(([participantId, telegramUserId]) => ({
    participantId: String(participantId),
    telegramUserId: Number(telegramUserId),
    username: String(participantId),
    displayName: String(participantId),
    inviterParticipantId: null,
    validDirectReferralCount: 0,
    ticketCount: 1,
  }));
  return {
    giveawayId: 'giveaway-1',
    title: 'Gift',
    snapshot: {
      version: 1,
      createdAt: NOW - 1_000,
      winnerCount: 2,
      participants,
      ticketOrder: ['alice', 'bob', 'alice', 'carol', 'dave'],
    },
    cursor: 2,
    resultRevision: 1,
    places: [
      {
        placeNumber: 1,
        version: 1,
        status: 'selected',
        participantId: 'alice',
        participant: participants[0]!,
      },
      {
        placeNumber: 2,
        version: 1,
        status: 'selected',
        participantId: 'bob',
        participant: participants[1]!,
      },
    ],
    excludedParticipantIds: [],
    channels: [
      { id: 'channel-1', telegramChatId: -1001, username: 'one', title: 'One' },
      { id: 'channel-2', telegramChatId: -1002, username: 'two', title: 'Two' },
    ],
  };
}

class FakeRerollRepository implements RerollRepository {
  currentContext: RerollContext = context();
  session: RerollSession = {
    id: 'session-1',
    giveawayId: 'giveaway-1',
    title: 'Gift',
    operatorTelegramId: 700,
    placeNumber: 1,
    state: 'awaiting_confirmation',
    reason: 'bot_or_suspicious_account',
    operationId: null,
    currentParticipant: context().places[0]!.participant!,
  };
  commits: Array<Record<string, unknown>> = [];
  operation: RerollResult | null = null;

  startRerollSession(): Promise<RerollSession> {
    return Promise.resolve(this.session);
  }
  getRerollSession(): Promise<RerollSession | null> {
    return Promise.resolve(this.session);
  }
  getActiveRerollSession(): Promise<RerollSession | null> {
    return Promise.resolve(this.session);
  }
  saveRerollReason(input: { reason: string }): Promise<RerollSession> {
    this.session = { ...this.session, state: 'awaiting_confirmation', reason: input.reason };
    return Promise.resolve(this.session);
  }
  getRerollContext(): Promise<RerollContext | null> {
    return Promise.resolve(this.currentContext);
  }
  commitReroll(input: Record<string, unknown>): Promise<RerollResult> {
    this.commits.push(input);
    this.operation = {
      operationId: String(input.operationId),
      giveawayId: 'giveaway-1',
      placeNumber: 1,
      previousParticipantId: String(input.previousParticipantId),
      newParticipantId:
        input.newParticipantId === null ? null : String(input.newParticipantId),
      cursor: Number(input.cursorAfter),
      resultRevision: 2,
    };
    this.session = {
      ...this.session,
      state: 'completed',
      operationId: this.operation.operationId,
    };
    return Promise.resolve(this.operation);
  }
  getRerollOperation(): Promise<RerollResult | null> {
    return Promise.resolve(this.operation);
  }
  listRerollAudit(): Promise<RerollAuditEntry[]> {
    return Promise.resolve([]);
  }
}

class FakeMembershipGateway {
  memberships = new Map<number, ParticipantMembership>([
    [103, { status: 'member' }],
    [104, { status: 'member' }],
  ]);
  failures: Error[] = [];
  calls: Array<[number, number]> = [];

  async getParticipantMembership(chatId: number, telegramUserId: number) {
    this.calls.push([chatId, telegramUserId]);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return this.memberships.get(telegramUserId) ?? { status: 'left' as const };
  }
}

function service(
  repository: FakeRerollRepository,
  gateway: FakeMembershipGateway,
) {
  let operationSequence = 0;
  return new GiveawayRerollService(repository, gateway, {
    createId: () => `operation-${++operationSequence}`,
    now: () => NOW,
    sleep: async () => undefined,
    teamTelegramIds: [700, 701],
  });
}

describe('GiveawayRerollService', () => {
  it.each(['ab', ' '.repeat(4), 'x'.repeat(501)])(
    'rejects an invalid internal reason',
    async (reason) => {
      const repository = new FakeRerollRepository();
      const reroll = service(repository, new FakeMembershipGateway());

      await expect(reroll.submitReason('session-1', 700, reason)).rejects.toThrow(
        '3 to 500',
      );
    },
  );

  it('skips definitely unsubscribed candidates and replaces only the selected place', async () => {
    const repository = new FakeRerollRepository();
    const gateway = new FakeMembershipGateway();
    gateway.memberships.set(103, { status: 'left' });

    const result = await service(repository, gateway).confirm('session-1', 700);

    expect(result).toMatchObject({ kind: 'completed', newParticipantId: 'dave' });
    expect(repository.commits).toEqual([
      expect.objectContaining({
        previousParticipantId: 'alice',
        newParticipantId: 'dave',
        cursorBefore: 2,
        cursorAfter: 5,
        skippedCandidates: [
          { participantId: 'carol', reason: 'subscription_missing' },
        ],
      }),
    ]);
  });

  it('leaves every persisted field unchanged when candidate eligibility is unknown', async () => {
    const repository = new FakeRerollRepository();
    const gateway = new FakeMembershipGateway();
    gateway.memberships.set(103, { status: 'unknown' });

    expect(await service(repository, gateway).confirm('session-1', 700)).toEqual({
      kind: 'retry_later',
      retryAfterMs: null,
    });
    expect(repository.commits).toEqual([]);
  });

  it('honors retry_after and returns retry_later after three unknown attempts', async () => {
    const repository = new FakeRerollRepository();
    const gateway = new FakeMembershipGateway();
    gateway.failures.push(
      new TelegramDeliveryError('rate', 'definite', 5_000, {
        kind: 'rate_limited',
      }),
      new TelegramDeliveryError('server', 'unknown', null, { kind: 'server' }),
      new TelegramDeliveryError('network', 'unknown', null, { kind: 'network' }),
    );

    expect(await service(repository, gateway).confirm('session-1', 700)).toEqual({
      kind: 'retry_later',
      retryAfterMs: null,
    });
    expect(gateway.calls).toHaveLength(3);
    expect(repository.commits).toEqual([]);
  });

  it('creates an empty place when the immutable order is exhausted', async () => {
    const repository = new FakeRerollRepository();
    repository.currentContext = {
      ...context(),
      cursor: 5,
    };

    const result = await service(repository, new FakeMembershipGateway()).confirm(
      'session-1',
      700,
    );

    expect(result).toMatchObject({ kind: 'completed', newParticipantId: null });
    expect(repository.commits[0]).toEqual(
      expect.objectContaining({ newParticipantId: null, cursorAfter: 5 }),
    );
  });

  it('returns the saved operation on callback replay without checking Telegram again', async () => {
    const repository = new FakeRerollRepository();
    const gateway = new FakeMembershipGateway();
    const reroll = service(repository, gateway);
    const first = await reroll.confirm('session-1', 700);
    const callCount = gateway.calls.length;
    const second = await reroll.confirm('session-1', 700);

    expect(second).toEqual(first);
    expect(gateway.calls).toHaveLength(callCount);
    expect(repository.commits).toHaveLength(1);
  });
});
