import type {
  RerollAuditEntry,
  RerollRepository,
  RerollSession,
} from './ports/reroll-repository.js';
import { TelegramDeliveryError } from './ports/telegram-gateway.js';
import { advanceReroll } from '../domain/giveaway-draw.js';
import {
  isEligibleParticipantMembership,
  type ParticipantMembership,
} from '../domain/participant-rules.js';

type RerollMembershipGateway = {
  getParticipantMembership(
    chatId: number,
    telegramUserId: number,
  ): Promise<ParticipantMembership>;
};

type RerollDependencies = {
  createId: (kind: 'reroll_session' | 'reroll_operation') => string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  teamTelegramIds: readonly number[];
};

const defaultDependencies: Omit<RerollDependencies, 'teamTelegramIds'> = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

export type ConfirmRerollResult =
  | {
      kind: 'completed';
      operationId: string;
      giveawayId: string;
      placeNumber: number;
      previousParticipantId: string;
      newParticipantId: string | null;
      cursor: number;
      resultRevision: number;
    }
  | { kind: 'retry_later'; retryAfterMs: number | null };

export class GiveawayRerollService {
  readonly #repository: RerollRepository;
  readonly #gateway: RerollMembershipGateway;
  readonly #dependencies: RerollDependencies;

  constructor(
    repository: RerollRepository,
    gateway: RerollMembershipGateway,
    dependencies: Partial<RerollDependencies> &
      Pick<RerollDependencies, 'teamTelegramIds'>,
  ) {
    this.#repository = repository;
    this.#gateway = gateway;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  start(
    giveawayId: string,
    placeNumber: number,
    operatorTelegramId: number,
  ): Promise<RerollSession> {
    return this.#repository.startRerollSession({
      id: this.#dependencies.createId('reroll_session'),
      giveawayId,
      placeNumber,
      operatorTelegramId,
      now: this.#dependencies.now(),
    });
  }

  getActive(operatorTelegramId: number): Promise<RerollSession | null> {
    return this.#repository.getActiveRerollSession(operatorTelegramId);
  }

  async submitReason(
    sessionId: string,
    operatorTelegramId: number,
    value: string,
  ): Promise<RerollSession> {
    const reason = value.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new Error('Reroll reason must contain from 3 to 500 characters');
    }
    return this.#repository.saveRerollReason({
      sessionId,
      operatorTelegramId,
      reason,
      now: this.#dependencies.now(),
    });
  }

  listAudit(giveawayId: string): Promise<RerollAuditEntry[]> {
    return this.#repository.listRerollAudit(giveawayId);
  }

  getCompleted(giveawayId: string) {
    return this.#repository.getRerollContext(giveawayId);
  }

  async confirm(
    sessionId: string,
    operatorTelegramId: number,
  ): Promise<ConfirmRerollResult> {
    const session = await this.#repository.getRerollSession(
      sessionId,
      operatorTelegramId,
    );
    if (!session) throw new Error('Reroll session is unavailable');
    if (session.state === 'completed' && session.operationId) {
      const operation = await this.#repository.getRerollOperation(
        session.operationId,
      );
      if (!operation) throw new Error('Completed reroll operation is missing');
      return { kind: 'completed', ...operation };
    }
    if (session.state !== 'awaiting_confirmation' || !session.reason) {
      throw new Error('Reroll is not ready for confirmation');
    }
    const draw = await this.#repository.getRerollContext(session.giveawayId);
    if (!draw) throw new Error('Completed draw is unavailable');
    const current = draw.places.find(
      (place) => place.placeNumber === session.placeNumber,
    );
    if (
      !current ||
      current.status !== 'selected' ||
      !current.participantId ||
      current.participantId !== session.currentParticipant.participantId
    ) {
      throw new Error('Selected prize place has changed');
    }

    const activeWinners = new Set(
      draw.places.flatMap((place) =>
        place.status === 'selected' && place.participantId
          ? [place.participantId]
          : [],
      ),
    );
    const excluded = new Set(draw.excludedParticipantIds);
    const skippedCandidates: Array<{
      participantId: string;
      reason: 'subscription_missing';
    }> = [];
    let cursor = draw.cursor;
    while (true) {
      const next = advanceReroll({
        snapshot: draw.snapshot,
        cursor,
        activeWinnerParticipantIds: activeWinners,
        excludedParticipantIds: excluded,
      });
      cursor = next.cursor;
      if (!next.participantId) {
        const operation = await this.#commit({
          session,
          previousParticipantId: current.participantId,
          newParticipantId: null,
          skippedCandidates,
          cursorBefore: draw.cursor,
          cursorAfter: cursor,
        });
        return { kind: 'completed', ...operation };
      }
      const participant = draw.snapshot.participants.find(
        (candidate) => candidate.participantId === next.participantId,
      );
      if (!participant) throw new Error('Ticket candidate is absent from snapshot');
      try {
        let eligible = true;
        for (const channel of draw.channels) {
          const membership = await this.#telegramCall(() =>
            this.#gateway.getParticipantMembership(
              channel.telegramChatId,
              participant.telegramUserId,
            ),
          );
          if (membership.status === 'unknown') {
            return { kind: 'retry_later', retryAfterMs: null };
          }
          if (!isEligibleParticipantMembership(membership)) {
            eligible = false;
            break;
          }
        }
        if (!eligible) {
          skippedCandidates.push({
            participantId: participant.participantId,
            reason: 'subscription_missing',
          });
          excluded.add(participant.participantId);
          continue;
        }
      } catch (error) {
        return {
          kind: 'retry_later',
          retryAfterMs:
            error instanceof TelegramDeliveryError ? error.retryAfterMs : null,
        };
      }
      const operation = await this.#commit({
        session,
        previousParticipantId: current.participantId,
        newParticipantId: participant.participantId,
        skippedCandidates,
        cursorBefore: draw.cursor,
        cursorAfter: cursor,
      });
      return { kind: 'completed', ...operation };
    }
  }

  #commit(input: {
    session: RerollSession;
    previousParticipantId: string;
    newParticipantId: string | null;
    skippedCandidates: Array<{
      participantId: string;
      reason: 'subscription_missing';
    }>;
    cursorBefore: number;
    cursorAfter: number;
  }) {
    return this.#repository.commitReroll({
      operationId: this.#dependencies.createId('reroll_operation'),
      sessionId: input.session.id,
      operatorTelegramId: input.session.operatorTelegramId,
      previousParticipantId: input.previousParticipantId,
      newParticipantId: input.newParticipantId,
      skippedCandidates: input.skippedCandidates,
      cursorBefore: input.cursorBefore,
      cursorAfter: input.cursorAfter,
      teamTelegramIds: this.#dependencies.teamTelegramIds,
      now: this.#dependencies.now(),
    });
  }

  async #telegramCall<Result>(operation: () => Promise<Result>): Promise<Result> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof TelegramDeliveryError) ||
          !['rate_limited', 'server', 'network'].includes(error.kind) ||
          attempt === 3
        ) {
          throw error;
        }
        await this.#dependencies.sleep(error.retryAfterMs ?? attempt * 250);
      }
    }
    throw new Error('Unreachable Telegram retry state');
  }
}
