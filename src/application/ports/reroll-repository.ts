import type { CompletedDraw, DrawChannel } from './draw-repository.js';

export class WinnerNotificationInFlightError extends Error {
  constructor() {
    super('Winner notification is being delivered');
    this.name = 'WinnerNotificationInFlightError';
  }
}

export type RerollSession = {
  id: string;
  giveawayId: string;
  title: string;
  operatorTelegramId: number;
  placeNumber: number;
  state: 'awaiting_reason' | 'awaiting_confirmation' | 'completed';
  reason: string | null;
  operationId: string | null;
  currentParticipant: NonNullable<CompletedDraw['places'][number]['participant']>;
};

export type RerollContext = CompletedDraw & { channels: DrawChannel[] };

export type RerollResult = {
  operationId: string;
  giveawayId: string;
  placeNumber: number;
  previousParticipantId: string;
  newParticipantId: string | null;
  cursor: number;
  resultRevision: number;
};

export type RerollAuditParticipant = {
  telegramUserId: number;
  username: string | null;
  displayName: string;
};

export type RerollAuditEntry = RerollResult & {
  operatorTelegramId: number;
  reason: string;
  skippedCandidates: Array<{
    participantId: string;
    reason: 'subscription_missing';
    participant: RerollAuditParticipant;
  }>;
  syncStatus: string;
  notificationStatus: string;
  previousParticipant: RerollAuditParticipant;
  newParticipant: RerollAuditParticipant | null;
  startedAt: number;
  finishedAt: number;
};

export interface RerollRepository {
  startRerollSession(input: {
    id: string;
    giveawayId: string;
    placeNumber: number;
    operatorTelegramId: number;
    now: number;
  }): Promise<RerollSession>;
  getRerollSession(
    sessionId: string,
    operatorTelegramId: number,
  ): Promise<RerollSession | null>;
  getActiveRerollSession(
    operatorTelegramId: number,
  ): Promise<RerollSession | null>;
  saveRerollReason(input: {
    sessionId: string;
    operatorTelegramId: number;
    reason: string;
    now: number;
  }): Promise<RerollSession>;
  getRerollContext(giveawayId: string): Promise<RerollContext | null>;
  commitReroll(input: {
    operationId: string;
    sessionId: string;
    operatorTelegramId: number;
    previousParticipantId: string;
    newParticipantId: string | null;
    skippedCandidates: Array<{
      participantId: string;
      reason: 'subscription_missing';
    }>;
    cursorBefore: number;
    cursorAfter: number;
    teamTelegramIds: readonly number[];
    now: number;
  }): Promise<RerollResult>;
  getRerollOperation(operationId: string): Promise<RerollResult | null>;
  listRerollAudit(giveawayId: string): Promise<RerollAuditEntry[]>;
}
