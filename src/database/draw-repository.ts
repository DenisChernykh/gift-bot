import type {
  CompletedDraw,
  CurrentDrawPlace,
  DrawRepository,
  DrawTarget,
} from '../application/ports/draw-repository.js';
import type {
  DrawNotification,
  DrawNotificationRepository,
} from '../application/ports/draw-notification-repository.js';
import type {
  RerollAuditEntry,
  RerollContext,
  RerollRepository,
  RerollResult,
  RerollSession,
} from '../application/ports/reroll-repository.js';
import {
  selectInitialWinners,
  type DrawPlace,
  type DrawSnapshot,
} from '../domain/giveaway-draw.js';
import type { DatabaseBoundary } from './client.js';

type DrawRepositoryDependencies = {
  createId: (
    kind:
      | 'draw_run'
      | 'place_version'
      | 'sync_task'
      | 'draw_notification',
  ) => string;
};

const defaultDependencies: DrawRepositoryDependencies = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
};

export class SqliteDrawRepository
  implements DrawRepository, DrawNotificationRepository, RerollRepository
{
  readonly #database: DatabaseBoundary;
  readonly #dependencies: DrawRepositoryDependencies;

  constructor(
    database: DatabaseBoundary,
    dependencies: Partial<DrawRepositoryDependencies> = {},
  ) {
    this.#database = database;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async claimNextDue(now: number): Promise<DrawTarget | null> {
    const giveawayId = await this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{ id: string }>(
        `select id from giveaways
          where state = 'active' and deadline_utc <= ?
          order by deadline_utc, id limit 1`,
        [now],
      );
      const id = rows[0]?.id;
      if (!id) return null;
      await transaction.execute(
        "update giveaways set state = 'drawing', updated_at = ? where id = ? and state = 'active'",
        [now, id],
      );
      const runs = await transaction.all<{ id: string }>(
        'select id from draw_runs where giveaway_id = ?',
        [id],
      );
      if (!runs[0]) {
        await transaction.execute(
          `insert into draw_runs (
             id, giveaway_id, snapshot_version, snapshot_json, cursor,
             result_revision, failure_stage, failure_error_kind, started_at,
             snapshot_created_at, completed_at, updated_at
           ) values (?, ?, null, null, 0, 0, null, null, ?, null, null, ?)`,
          [this.#dependencies.createId('draw_run'), id, now, now],
        );
      }
      return id;
    });
    return giveawayId ? this.getDrawing(giveawayId) : null;
  }

  async listDrawing(): Promise<DrawTarget[]> {
    const rows = await this.#database.all<{ id: string }>(
      "select id from giveaways where state = 'drawing' order by deadline_utc, id",
    );
    const targets = await Promise.all(rows.map((row) => this.getDrawing(row.id)));
    return targets.filter((target): target is DrawTarget => target !== null);
  }

  async getDrawing(giveawayId: string): Promise<DrawTarget | null> {
    return this.#readTarget(this.#database, giveawayId);
  }

  async saveSnapshot(input: {
    giveawayId: string;
    snapshot: DrawSnapshot;
    now: number;
  }): Promise<DrawSnapshot> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        state: string;
        snapshotJson: string | null;
      }>(
        `select g.state, r.snapshot_json as snapshotJson
           from giveaways g join draw_runs r on r.giveaway_id = g.id
          where g.id = ?`,
        [input.giveawayId],
      );
      const row = rows[0];
      if (!row || row.state !== 'drawing') {
        throw new Error('Giveaway is not drawing');
      }
      if (row.snapshotJson) return JSON.parse(row.snapshotJson) as DrawSnapshot;
      await transaction.execute(
        `update draw_runs
            set snapshot_version = ?, snapshot_json = ?,
                snapshot_created_at = ?, updated_at = ?
          where giveaway_id = ? and snapshot_json is null`,
        [
          input.snapshot.version,
          JSON.stringify(input.snapshot),
          input.snapshot.createdAt,
          input.now,
          input.giveawayId,
        ],
      );
      return input.snapshot;
    });
  }

  async completeDraw(input: {
    giveawayId: string;
    places: DrawPlace[];
    cursor: number;
    teamTelegramIds: readonly number[];
    now: number;
  }): Promise<CompletedDraw> {
    await this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        state: string;
        drawRunId: string;
        snapshotJson: string | null;
        resultRevision: number;
      }>(
        `select g.state, r.id as drawRunId, r.snapshot_json as snapshotJson,
                r.result_revision as resultRevision
           from giveaways g join draw_runs r on r.giveaway_id = g.id
          where g.id = ?`,
        [input.giveawayId],
      );
      const row = rows[0];
      if (!row?.snapshotJson) throw new Error('Draw snapshot is missing');
      if (row.state === 'completed') return;
      if (row.state !== 'drawing' || row.resultRevision !== 0) {
        throw new Error('Giveaway cannot complete drawing');
      }
      const snapshot = JSON.parse(row.snapshotJson) as DrawSnapshot;
      const expectedSelection = selectInitialWinners(snapshot);
      const matchesSnapshot =
        input.cursor === expectedSelection.cursor &&
        input.places.length === expectedSelection.places.length &&
        input.places.every((place, index) => {
          const expected = expectedSelection.places[index];
          return (
            expected !== undefined &&
            place.placeNumber === expected.placeNumber &&
            place.status === expected.status &&
            place.participantId === expected.participantId
          );
        });
      if (!matchesSnapshot) {
        throw new Error('Initial result does not match the immutable ticket order');
      }
      const snapshotIds = new Set(
        snapshot.participants.map((participant) => participant.participantId),
      );
      for (const place of input.places) {
        if (place.participantId && !snapshotIds.has(place.participantId)) {
          throw new Error('Winner is not present in the draw snapshot');
        }
        await transaction.execute(
          `insert into prize_place_versions (
             id, draw_run_id, place_number, version, state, participant_id,
             created_at, rejected_at
           ) values (?, ?, ?, 1, ?, ?, ?, null)`,
          [
            this.#dependencies.createId('place_version'),
            row.drawRunId,
            place.placeNumber,
            place.status,
            place.participantId,
            input.now,
          ],
        );
      }
      await transaction.execute(
        `update draw_runs
            set cursor = ?, result_revision = 1, completed_at = ?,
                failure_stage = null, failure_error_kind = null, updated_at = ?
          where id = ?`,
        [input.cursor, input.now, input.now, row.drawRunId],
      );
      await transaction.execute(
        "update giveaways set state = 'completed', updated_at = ? where id = ? and state = 'drawing'",
        [input.now, input.giveawayId],
      );
      await transaction.execute(
        "update join_tokens set state = 'revoked' where giveaway_id = ? and state in ('active', 'pending')",
        [input.giveawayId],
      );
      await transaction.execute(
        "update referral_tokens set state = 'revoked' where giveaway_id = ? and state = 'active'",
        [input.giveawayId],
      );
      await transaction.execute(
        `update sync_tasks set status = 'superseded', updated_at = ?
          where giveaway_id = ? and task_type = 'participant_count'
            and status in ('pending', 'processing')`,
        [input.now, input.giveawayId],
      );
      await transaction.execute(
        `update draw_notifications set status = 'superseded', updated_at = ?
          where giveaway_id = ? and kind = 'team_failure'
            and status in ('pending', 'processing')`,
        [input.now, input.giveawayId],
      );
      await this.#queueResultSynchronization(
        transaction,
        input.giveawayId,
        1,
        input.now,
      );
      for (const recipientTelegramId of new Set(input.teamTelegramIds)) {
        const participantById = new Map(
          snapshot.participants.map((participant) => [
            participant.participantId,
            participant,
          ]),
        );
        const placeLines = input.places.map((place) => {
          const participant = place.participantId
            ? participantById.get(place.participantId)
            : null;
          return participant
            ? `${place.placeNumber}. ${participant.displayName} (Telegram ID ${participant.telegramUserId}; рефералов ${participant.validDirectReferralCount}; билетов ${participant.ticketCount})`
            : `${place.placeNumber}. Место не заполнено`;
        });
        await this.#insertNotification(transaction, {
          giveawayId: input.giveawayId,
          drawRunId: row.drawRunId,
          recipientTelegramId,
          kind: 'team_result',
          payload: JSON.stringify({
            text: [
              `Результат розыгрыша «${await this.#giveawayTitle(transaction, input.giveawayId)}» зафиксирован; публичная синхронизация запущена.`,
              `Допущено участников: ${snapshot.participants.length}. Билетов: ${snapshot.ticketOrder.length}.`,
              ...placeLines,
            ].join('\n'),
          }),
          now: input.now,
        });
      }
      const byId = new Map(
        snapshot.participants.map((participant) => [
          participant.participantId,
          participant,
        ]),
      );
      for (const place of input.places) {
        if (!place.participantId) continue;
        const participant = byId.get(place.participantId)!;
        await this.#insertNotification(transaction, {
          giveawayId: input.giveawayId,
          drawRunId: row.drawRunId,
          recipientTelegramId: participant.telegramUserId,
          kind: 'winner',
          payload: JSON.stringify({
            text: `Вы стали победителем розыгрыша «${await this.#giveawayTitle(transaction, input.giveawayId)}». Ваше место: ${place.placeNumber}.`,
          }),
          now: input.now,
        });
      }
    });
    const completed = await this.getCompletedDraw(input.giveawayId);
    if (!completed) throw new Error('Completed draw was not persisted');
    return completed;
  }

  async failDraw(input: {
    giveawayId: string;
    stage: string;
    errorKind: string;
    teamTelegramIds: readonly number[];
    now: number;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{ state: string; drawRunId: string }>(
        `select g.state, r.id as drawRunId
           from giveaways g join draw_runs r on r.giveaway_id = g.id
          where g.id = ?`,
        [input.giveawayId],
      );
      const row = rows[0];
      if (!row || row.state !== 'drawing') return;
      await transaction.execute(
        "update giveaways set state = 'failed', updated_at = ? where id = ? and state = 'drawing'",
        [input.now, input.giveawayId],
      );
      await transaction.execute(
        `update draw_runs set failure_stage = ?, failure_error_kind = ?,
                              updated_at = ? where id = ?`,
        [input.stage, input.errorKind, input.now, row.drawRunId],
      );
      for (const recipientTelegramId of new Set(input.teamTelegramIds)) {
        await this.#insertNotification(transaction, {
          giveawayId: input.giveawayId,
          drawRunId: row.drawRunId,
          recipientTelegramId,
          kind: 'team_failure',
          payload: JSON.stringify({
            text: `Завершение розыгрыша «${await this.#giveawayTitle(transaction, input.giveawayId)}» остановлено. Этап: ${input.stage}; ошибка: ${input.errorKind}. После устранения причины используйте ручной retry.`,
          }),
          now: input.now,
        });
      }
    });
  }

  async retryFailedDraw(giveawayId: string, now: number): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        state: string;
        drawRunId: string;
        failureStage: string | null;
      }>(
        `select g.state, r.id as drawRunId, r.failure_stage as failureStage
           from giveaways g join draw_runs r on r.giveaway_id = g.id
          where g.id = ?`,
        [giveawayId],
      );
      const row = rows[0];
      if (!row || row.state !== 'failed' || !row.failureStage) return false;
      await transaction.execute(
        "update giveaways set state = 'drawing', updated_at = ? where id = ? and state = 'failed'",
        [now, giveawayId],
      );
      await transaction.execute(
        `update draw_runs set failure_stage = null, failure_error_kind = null,
                              updated_at = ? where id = ?`,
        [now, row.drawRunId],
      );
      return true;
    });
  }

  async startRerollSession(input: {
    id: string;
    giveawayId: string;
    placeNumber: number;
    operatorTelegramId: number;
    now: number;
  }): Promise<RerollSession> {
    await this.#database.transaction(async (transaction) => {
      const wizards = await transaction.all<{ id: string }>(
        "select id from wizard_sessions where administrator_telegram_id = ? and status = 'active'",
        [input.operatorTelegramId],
      );
      if (wizards[0]) {
        throw new Error('Finish or cancel the active giveaway wizard first');
      }
      const places = await transaction.all<{ participantId: string | null }>(
        `select v.participant_id as participantId
           from prize_place_versions v
           join draw_runs r on r.id = v.draw_run_id
           join giveaways g on g.id = r.giveaway_id
          where g.id = ? and g.state = 'completed' and v.place_number = ?
            and v.state = 'selected'`,
        [input.giveawayId, input.placeNumber],
      );
      if (!places[0]?.participantId) {
        throw new Error('Only an occupied completed prize place can be rerolled');
      }
      await transaction.execute(
        `update reroll_sessions set state = 'cancelled', updated_at = ?
          where operator_telegram_id = ?
            and state in ('awaiting_reason', 'awaiting_confirmation')`,
        [input.now, input.operatorTelegramId],
      );
      await transaction.execute(
        `insert into reroll_sessions (
           id, giveaway_id, operator_telegram_id, place_number, state,
           reason, operation_id, created_at, updated_at
         ) values (?, ?, ?, ?, 'awaiting_reason', null, null, ?, ?)`,
        [
          input.id,
          input.giveawayId,
          input.operatorTelegramId,
          input.placeNumber,
          input.now,
          input.now,
        ],
      );
    });
    const session = await this.getRerollSession(
      input.id,
      input.operatorTelegramId,
    );
    if (!session) throw new Error('Reroll session was not persisted');
    return session;
  }

  getRerollSession(
    sessionId: string,
    operatorTelegramId: number,
  ): Promise<RerollSession | null> {
    return this.#readRerollSession(sessionId, operatorTelegramId);
  }

  async getActiveRerollSession(
    operatorTelegramId: number,
  ): Promise<RerollSession | null> {
    const rows = await this.#database.all<{ id: string }>(
      `select id from reroll_sessions
        where operator_telegram_id = ?
          and state in ('awaiting_reason', 'awaiting_confirmation')
        order by updated_at desc limit 1`,
      [operatorTelegramId],
    );
    return rows[0]
      ? this.#readRerollSession(rows[0].id, operatorTelegramId)
      : null;
  }

  async saveRerollReason(input: {
    sessionId: string;
    operatorTelegramId: number;
    reason: string;
    now: number;
  }): Promise<RerollSession> {
    await this.#database.execute(
      `update reroll_sessions
          set reason = ?, state = 'awaiting_confirmation', updated_at = ?
        where id = ? and operator_telegram_id = ? and state = 'awaiting_reason'`,
      [
        input.reason,
        input.now,
        input.sessionId,
        input.operatorTelegramId,
      ],
    );
    const session = await this.getRerollSession(
      input.sessionId,
      input.operatorTelegramId,
    );
    if (!session || session.state !== 'awaiting_confirmation') {
      throw new Error('Reroll session is not awaiting a reason');
    }
    return session;
  }

  async getRerollContext(giveawayId: string): Promise<RerollContext | null> {
    const draw = await this.getCompletedDraw(giveawayId);
    if (!draw) return null;
    const channels = await this.#database.all<{
      id: string;
      telegramChatId: number;
      username: string;
      title: string;
    }>(
      `select id, telegram_chat_id as telegramChatId, username, title
         from giveaway_channels
        where giveaway_id = ? and status = 'confirmed'
        order by created_at, id`,
      [giveawayId],
    );
    return { ...draw, channels };
  }

  async commitReroll(input: {
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
  }): Promise<RerollResult> {
    await this.#database.transaction(async (transaction) => {
      const existing = await transaction.all<{ id: string }>(
        'select id from reroll_operations where id = ?',
        [input.operationId],
      );
      if (existing[0]) return;
      const sessions = await transaction.all<{
        giveawayId: string;
        placeNumber: number;
        reason: string | null;
        state: string;
        operationId: string | null;
        startedAt: number;
      }>(
        `select giveaway_id as giveawayId, place_number as placeNumber,
                reason, state, operation_id as operationId,
                created_at as startedAt
           from reroll_sessions
          where id = ? and operator_telegram_id = ?`,
        [input.sessionId, input.operatorTelegramId],
      );
      const session = sessions[0];
      if (!session) throw new Error('Reroll session is unavailable');
      if (session.state === 'completed' && session.operationId) return;
      if (session.state !== 'awaiting_confirmation' || !session.reason) {
        throw new Error('Reroll session is not ready');
      }
      const draws = await transaction.all<{
        drawRunId: string;
        title: string;
        state: string;
        snapshotJson: string;
        cursor: number;
        resultRevision: number;
      }>(
        `select r.id as drawRunId, g.title, g.state,
                r.snapshot_json as snapshotJson, r.cursor,
                r.result_revision as resultRevision
           from draw_runs r join giveaways g on g.id = r.giveaway_id
          where g.id = ?`,
        [session.giveawayId],
      );
      const draw = draws[0];
      if (!draw || draw.state !== 'completed' || draw.cursor !== input.cursorBefore) {
        throw new Error('Draw changed before reroll commit');
      }
      const snapshot = JSON.parse(draw.snapshotJson) as DrawSnapshot;
      if (
        input.cursorAfter < input.cursorBefore ||
        input.cursorAfter > snapshot.ticketOrder.length
      ) {
        throw new Error('Reroll cursor must advance within the snapshot order');
      }
      const participants = new Map(
        snapshot.participants.map((participant) => [
          participant.participantId,
          participant,
        ]),
      );
      if (input.newParticipantId && !participants.has(input.newParticipantId)) {
        throw new Error('Reroll candidate is absent from snapshot');
      }
      const activeWinners = await transaction.all<{ participantId: string }>(
        `select participant_id as participantId
           from prize_place_versions
          where draw_run_id = ? and state = 'selected'
            and participant_id is not null`,
        [draw.drawRunId],
      );
      const activeWinnerParticipantIds = new Set(
        activeWinners.map((winner) => winner.participantId),
      );
      const storedExclusions = await transaction.all<{ participantId: string }>(
        `select participant_id as participantId from draw_exclusions
          where draw_run_id = ?`,
        [draw.drawRunId],
      );
      const excludedParticipantIds = new Set(
        storedExclusions.map((exclusion) => exclusion.participantId),
      );
      if (input.newParticipantId) {
        if (activeWinnerParticipantIds.has(input.newParticipantId)) {
          throw new Error('Reroll candidate already occupies a prize place');
        }
        if (excludedParticipantIds.has(input.newParticipantId)) {
          throw new Error('Reroll candidate is already excluded');
        }
      }
      const places = await transaction.all<{
        id: string;
        version: number;
        participantId: string | null;
      }>(
        `select id, version, participant_id as participantId
           from prize_place_versions
          where draw_run_id = ? and place_number = ? and state = 'selected'`,
        [draw.drawRunId, session.placeNumber],
      );
      const previous = places[0];
      if (previous?.participantId !== input.previousParticipantId) {
        throw new Error('Current winner changed before reroll commit');
      }
      assertRerollProgressMatchesSnapshot({
        snapshot,
        cursorBefore: input.cursorBefore,
        cursorAfter: input.cursorAfter,
        activeWinnerParticipantIds,
        excludedParticipantIds,
        skippedCandidates: input.skippedCandidates,
        newParticipantId: input.newParticipantId,
      });
      const previousParticipant = participants.get(
        input.previousParticipantId,
      )!;
      const newParticipant = input.newParticipantId
        ? participants.get(input.newParticipantId)!
        : null;
      const newRevision = draw.resultRevision + 1;
      await transaction.execute(
        `insert into reroll_operations (
           id, draw_run_id, place_number, operator_telegram_id, reason,
           previous_participant_id, new_participant_id, skipped_candidates,
           status, cursor_before, cursor_after, result_revision,
           sync_status, notification_status, started_at, finished_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?,
                   'pending', 'pending', ?, ?)`,
        [
          input.operationId,
          draw.drawRunId,
          session.placeNumber,
          input.operatorTelegramId,
          session.reason,
          input.previousParticipantId,
          input.newParticipantId,
          JSON.stringify(input.skippedCandidates),
          input.cursorBefore,
          input.cursorAfter,
          newRevision,
          session.startedAt,
          input.now,
        ],
      );
      await transaction.execute(
        "update prize_place_versions set state = 'rejected', rejected_at = ? where id = ? and state = 'selected'",
        [input.now, previous.id],
      );
      const exclusions = [
        {
          participantId: input.previousParticipantId,
          reason: session.reason,
        },
        ...input.skippedCandidates,
      ];
      for (const exclusion of exclusions) {
        await transaction.execute(
          `insert into draw_exclusions (
             draw_run_id, participant_id, reason, reroll_operation_id, created_at
           ) values (?, ?, ?, ?, ?)`,
          [
            draw.drawRunId,
            exclusion.participantId,
            exclusion.reason,
            input.operationId,
            input.now,
          ],
        );
      }
      await transaction.execute(
        `insert into prize_place_versions (
           id, draw_run_id, place_number, version, state, participant_id,
           created_at, rejected_at
         ) values (?, ?, ?, ?, ?, ?, ?, null)`,
        [
          this.#dependencies.createId('place_version'),
          draw.drawRunId,
          session.placeNumber,
          previous.version + 1,
          input.newParticipantId ? 'selected' : 'empty',
          input.newParticipantId,
          input.now,
        ],
      );
      await transaction.execute(
        `update draw_runs set cursor = ?, result_revision = ?, updated_at = ?
          where id = ?`,
        [input.cursorAfter, newRevision, input.now, draw.drawRunId],
      );
      await this.#queueResultSynchronization(
        transaction,
        session.giveawayId,
        newRevision,
        input.now,
        input.operationId,
      );
      await this.#supersedeWinnerNotifications(
        transaction,
        session.giveawayId,
        previousParticipant.telegramUserId,
        input.now,
      );
      for (const recipientTelegramId of new Set(input.teamTelegramIds)) {
        await this.#insertNotification(transaction, {
          giveawayId: session.giveawayId,
          drawRunId: draw.drawRunId,
          rerollOperationId: input.operationId,
          recipientTelegramId,
          kind: 'team_reroll',
          payload: JSON.stringify({
            text: [
              `В розыгрыше «${draw.title}» перевыбрано место ${session.placeNumber}.`,
              `Причина: ${session.reason}.`,
              `Прежний победитель: ${previousParticipant.displayName} (${previousParticipant.telegramUserId}).`,
              `Новый победитель: ${newParticipant ? `${newParticipant.displayName} (${newParticipant.telegramUserId})` : 'место не заполнено'}.`,
              `Автоматически пропущено: ${input.skippedCandidates.length}.`,
            ].join('\n'),
          }),
          now: input.now,
        });
      }
      if (newParticipant) {
        await this.#insertNotification(transaction, {
          giveawayId: session.giveawayId,
          drawRunId: draw.drawRunId,
          rerollOperationId: input.operationId,
          recipientTelegramId: newParticipant.telegramUserId,
          kind: 'winner',
          payload: JSON.stringify({
            text: `Вы стали победителем розыгрыша «${draw.title}». Ваше место: ${session.placeNumber}.`,
          }),
          now: input.now,
        });
      }
      await transaction.execute(
        `update reroll_sessions
            set state = 'completed', operation_id = ?, updated_at = ?
          where id = ? and state = 'awaiting_confirmation'`,
        [input.operationId, input.now, input.sessionId],
      );
    });
    const session = await this.getRerollSession(
      input.sessionId,
      input.operatorTelegramId,
    );
    const operationId = session?.operationId ?? input.operationId;
    const result = await this.getRerollOperation(operationId);
    if (!result) throw new Error('Reroll operation was not persisted');
    return result;
  }

  async getRerollOperation(operationId: string): Promise<RerollResult | null> {
    const rows = await this.#database.all<{
      operationId: string;
      giveawayId: string;
      placeNumber: number;
      previousParticipantId: string;
      newParticipantId: string | null;
      cursor: number;
      resultRevision: number;
    }>(
      `select o.id as operationId, r.giveaway_id as giveawayId,
              o.place_number as placeNumber,
              o.previous_participant_id as previousParticipantId,
              o.new_participant_id as newParticipantId,
              o.cursor_after as cursor, o.result_revision as resultRevision
         from reroll_operations o join draw_runs r on r.id = o.draw_run_id
        where o.id = ? and o.status = 'completed'`,
      [operationId],
    );
    return rows[0] ?? null;
  }

  async listRerollAudit(giveawayId: string): Promise<RerollAuditEntry[]> {
    const rows = await this.#database.all<{
      operationId: string;
      giveawayId: string;
      placeNumber: number;
      operatorTelegramId: number;
      reason: string;
      previousParticipantId: string;
      newParticipantId: string | null;
      skippedCandidates: string;
      cursor: number;
      resultRevision: number;
      syncStatus: string;
      notificationStatus: string;
      snapshotJson: string;
      startedAt: number;
      finishedAt: number;
    }>(
      `select o.id as operationId, r.giveaway_id as giveawayId,
              o.place_number as placeNumber,
              o.operator_telegram_id as operatorTelegramId, o.reason,
              o.previous_participant_id as previousParticipantId,
              o.new_participant_id as newParticipantId,
              o.skipped_candidates as skippedCandidates,
              o.cursor_after as cursor, o.result_revision as resultRevision,
              o.sync_status as syncStatus,
              o.notification_status as notificationStatus,
              r.snapshot_json as snapshotJson,
              o.started_at as startedAt, o.finished_at as finishedAt
         from reroll_operations o join draw_runs r on r.id = o.draw_run_id
        where r.giveaway_id = ? order by o.result_revision, o.id`,
      [giveawayId],
    );
    return rows.map(({ snapshotJson, ...row }) => {
      const snapshot = JSON.parse(snapshotJson) as DrawSnapshot;
      const previousParticipant = snapshot.participants.find(
        (participant) => participant.participantId === row.previousParticipantId,
      );
      const newParticipant = row.newParticipantId
        ? snapshot.participants.find(
            (participant) => participant.participantId === row.newParticipantId,
          )
        : null;
      if (!previousParticipant || (row.newParticipantId && !newParticipant)) {
        throw new Error('Reroll audit participant is absent from snapshot');
      }
      const skippedCandidates = (
        JSON.parse(row.skippedCandidates) as Array<{
          participantId: string;
          reason: 'subscription_missing';
        }>
      ).map((candidate) => {
        const participant = snapshot.participants.find(
          (entry) => entry.participantId === candidate.participantId,
        );
        if (!participant) {
          throw new Error('Skipped reroll candidate is absent from snapshot');
        }
        return { ...candidate, participant };
      });
      return {
        ...row,
        previousParticipant,
        newParticipant: newParticipant ?? null,
        skippedCandidates,
      };
    });
  }

  async recoverInterruptedNotifications(now: number): Promise<void> {
    await this.#database.execute(
      `update draw_notifications
          set status = 'pending', available_at = min(available_at, ?),
              last_error_kind = 'interrupted', updated_at = ?
        where status = 'processing'`,
      [now, now],
    );
  }

  async listDueNotifications(now: number): Promise<DrawNotification[]> {
    const rows = await this.#database.all<{
      id: string;
      recipientTelegramId: number;
      payload: string;
      attempts: number;
    }>(
      `select id, recipient_telegram_id as recipientTelegramId,
              payload, attempts
         from draw_notifications
        where status = 'pending' and available_at <= ?
        order by created_at, id`,
      [now],
    );
    return rows.map((row) => ({
      id: row.id,
      recipientTelegramId: row.recipientTelegramId,
      text: notificationText(row.payload),
      attempts: row.attempts,
    }));
  }

  async claimNotification(
    id: string,
    now: number,
  ): Promise<DrawNotification | null> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        id: string;
        recipientTelegramId: number;
        payload: string;
        attempts: number;
      }>(
        `select id, recipient_telegram_id as recipientTelegramId,
                payload, attempts
           from draw_notifications
          where id = ? and status = 'pending' and available_at <= ?`,
        [id, now],
      );
      const row = rows[0];
      if (!row) return null;
      await transaction.execute(
        "update draw_notifications set status = 'processing', updated_at = ? where id = ? and status = 'pending'",
        [now, id],
      );
      return {
        id: row.id,
        recipientTelegramId: row.recipientTelegramId,
        text: notificationText(row.payload),
        attempts: row.attempts,
      };
    });
  }

  async completeNotification(id: string, now: number): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{ operationId: string | null }>(
        'select reroll_operation_id as operationId from draw_notifications where id = ?',
        [id],
      );
      await transaction.execute(
        `update draw_notifications
            set status = 'delivered', attempts = attempts + 1,
                last_error_kind = null, updated_at = ?
          where id = ? and status = 'processing'`,
        [now, id],
      );
      if (rows[0]?.operationId) {
        await this.#refreshOperationNotificationStatus(
          transaction,
          rows[0].operationId,
        );
      }
    });
  }

  async failNotification(input: {
    id: string;
    terminal: boolean;
    errorKind: string;
    availableAt: number;
    now: number;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{ operationId: string | null }>(
        'select reroll_operation_id as operationId from draw_notifications where id = ?',
        [input.id],
      );
      await transaction.execute(
        `update draw_notifications
            set status = ?, attempts = attempts + 1, available_at = ?,
                last_error_kind = ?, updated_at = ?
          where id = ? and status = 'processing'`,
        [
          input.terminal ? 'failed' : 'pending',
          input.availableAt,
          input.errorKind,
          input.now,
          input.id,
        ],
      );
      if (rows[0]?.operationId) {
        await this.#refreshOperationNotificationStatus(
          transaction,
          rows[0].operationId,
        );
      }
    });
  }

  async getCompletedDraw(giveawayId: string): Promise<CompletedDraw | null> {
    const rows = await this.#database.all<{
      drawRunId: string;
      title: string;
      snapshotJson: string | null;
      cursor: number;
      resultRevision: number;
    }>(
      `select r.id as drawRunId, g.title, r.snapshot_json as snapshotJson,
              r.cursor, r.result_revision as resultRevision
         from draw_runs r join giveaways g on g.id = r.giveaway_id
        where r.giveaway_id = ? and g.state = 'completed'`,
      [giveawayId],
    );
    const row = rows[0];
    if (!row?.snapshotJson) return null;
    const snapshot = JSON.parse(row.snapshotJson) as DrawSnapshot;
    const participants = new Map(
      snapshot.participants.map((participant) => [
        participant.participantId,
        participant,
      ]),
    );
    const placeRows = await this.#database.all<{
      placeNumber: number;
      version: number;
      state: 'selected' | 'empty';
      participantId: string | null;
    }>(
      `select place_number as placeNumber, version, state,
              participant_id as participantId
         from prize_place_versions
        where draw_run_id = ? and state in ('selected', 'empty')
        order by place_number`,
      [row.drawRunId],
    );
    const places: CurrentDrawPlace[] = placeRows.map((place) => ({
      placeNumber: place.placeNumber,
      version: place.version,
      status: place.state,
      participantId: place.participantId,
      participant: place.participantId
        ? (participants.get(place.participantId) ?? null)
        : null,
    }));
    const exclusions = await this.#database.all<{ participantId: string }>(
      'select participant_id as participantId from draw_exclusions where draw_run_id = ? order by created_at, participant_id',
      [row.drawRunId],
    );
    return {
      giveawayId,
      title: row.title,
      snapshot,
      cursor: row.cursor,
      resultRevision: row.resultRevision,
      places,
      excludedParticipantIds: exclusions.map((entry) => entry.participantId),
    };
  }

  async #readTarget(
    boundary: DatabaseBoundary,
    giveawayId: string,
  ): Promise<DrawTarget | null> {
    const rows = await boundary.all<{
      id: string;
      title: string;
      state: 'drawing';
      winnerCount: number;
      deadlineUtc: number;
      referralsEnabled: number;
      createdByTelegramId: number;
      snapshotJson: string | null;
    }>(
      `select g.id, g.title, g.state, g.winner_count as winnerCount,
              g.deadline_utc as deadlineUtc,
              g.referrals_enabled as referralsEnabled,
              g.created_by_telegram_id as createdByTelegramId,
              r.snapshot_json as snapshotJson
         from giveaways g join draw_runs r on r.giveaway_id = g.id
        where g.id = ? and g.state = 'drawing'`,
      [giveawayId],
    );
    const row = rows[0];
    if (!row) return null;
    const [channels, participants] = await Promise.all([
      boundary.all<{
        id: string;
        telegramChatId: number;
        username: string;
        title: string;
      }>(
        `select id, telegram_chat_id as telegramChatId, username, title
           from giveaway_channels
          where giveaway_id = ? and status = 'confirmed'
          order by created_at, id`,
        [giveawayId],
      ),
      boundary.all<{
        participantId: string;
        telegramUserId: number;
        username: string | null;
        displayName: string;
        inviterParticipantId: string | null;
      }>(
        `select id as participantId, telegram_user_id as telegramUserId,
                username, display_name as displayName,
                inviter_participant_id as inviterParticipantId
           from participants where giveaway_id = ? order by joined_at, id`,
        [giveawayId],
      ),
    ]);
    return {
      ...row,
      referralsEnabled: row.referralsEnabled === 1,
      channels,
      participants,
      snapshot: row.snapshotJson
        ? (JSON.parse(row.snapshotJson) as DrawSnapshot)
        : null,
    };
  }

  async #queueResultSynchronization(
    transaction: DatabaseBoundary,
    giveawayId: string,
    revision: number,
    now: number,
    rerollOperationId?: string,
  ): Promise<void> {
    const channels = await transaction.all<{ id: string }>(
      `select distinct c.id
         from giveaway_channels c
         join publication_deliveries d on d.giveaway_channel_id = c.id
         join publication_runs r on r.id = d.publication_run_id
        where c.giveaway_id = ? and r.status = 'succeeded'
          and d.status = 'delivered' and d.message_id is not null`,
      [giveawayId],
    );
    for (const channel of channels) {
      const existing = await transaction.all<{ id: string }>(
        `select id from sync_tasks
          where giveaway_id = ? and giveaway_channel_id = ?
            and task_type = 'result'`,
        [giveawayId, channel.id],
      );
      const payload = JSON.stringify({
        revision,
        ...(rerollOperationId ? { rerollOperationId } : {}),
      });
      if (existing[0]) {
        const current = await transaction.all<{ payload: string }>(
          'select payload from sync_tasks where id = ?',
          [existing[0].id],
        );
        const previousOperationId = resultOperationId(
          current[0]?.payload ?? '',
        );
        if (
          previousOperationId &&
          previousOperationId !== rerollOperationId
        ) {
          await transaction.execute(
            `update reroll_operations set sync_status = 'superseded'
              where id = ? and sync_status in ('pending', 'retrying')`,
            [previousOperationId],
          );
        }
        await transaction.execute(
          `update sync_tasks
              set payload = ?, status = 'pending', attempts = 0,
                  available_at = ?, last_error_kind = null, updated_at = ?
            where id = ?`,
          [payload, now, now, existing[0].id],
        );
      } else {
        await transaction.execute(
          `insert into sync_tasks (
             id, giveaway_id, giveaway_channel_id, task_type, payload, status,
             attempts, available_at, last_error_kind, created_at, updated_at
           ) values (?, ?, ?, 'result', ?, 'pending', 0, ?, null, ?, ?)`,
          [
            this.#dependencies.createId('sync_task'),
            giveawayId,
            channel.id,
            payload,
            now,
            now,
            now,
          ],
        );
      }
    }
  }

  async #insertNotification(
    transaction: DatabaseBoundary,
    input: {
      giveawayId: string;
      drawRunId: string;
      recipientTelegramId: number;
      kind: string;
      payload: string;
      rerollOperationId?: string;
      now: number;
    },
  ): Promise<void> {
    await transaction.execute(
      `insert into draw_notifications (
         id, giveaway_id, draw_run_id, reroll_operation_id,
         recipient_telegram_id, kind, payload, status, attempts,
         available_at, last_error_kind, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, null, ?, ?)`,
      [
        this.#dependencies.createId('draw_notification'),
        input.giveawayId,
        input.drawRunId,
        input.rerollOperationId ?? null,
        input.recipientTelegramId,
        input.kind,
        input.payload,
        input.now,
        input.now,
        input.now,
      ],
    );
  }

  async #supersedeWinnerNotifications(
    transaction: DatabaseBoundary,
    giveawayId: string,
    recipientTelegramId: number,
    now: number,
  ): Promise<void> {
    const operations = await transaction.all<{ operationId: string | null }>(
      `select distinct reroll_operation_id as operationId
         from draw_notifications
        where giveaway_id = ? and recipient_telegram_id = ?
          and kind = 'winner' and status in ('pending', 'processing')`,
      [giveawayId, recipientTelegramId],
    );
    await transaction.execute(
      `update draw_notifications set status = 'superseded', updated_at = ?
        where giveaway_id = ? and recipient_telegram_id = ?
          and kind = 'winner' and status in ('pending', 'processing')`,
      [now, giveawayId, recipientTelegramId],
    );
    for (const operation of operations) {
      if (operation.operationId) {
        await this.#refreshOperationNotificationStatus(
          transaction,
          operation.operationId,
        );
      }
    }
  }

  async #readRerollSession(
    sessionId: string,
    operatorTelegramId: number,
  ): Promise<RerollSession | null> {
    const rows = await this.#database.all<{
      id: string;
      giveawayId: string;
      title: string;
      operatorTelegramId: number;
      placeNumber: number;
      state: 'awaiting_reason' | 'awaiting_confirmation' | 'completed';
      reason: string | null;
      operationId: string | null;
      currentParticipantId: string | null;
      snapshotJson: string;
    }>(
      `select s.id, s.giveaway_id as giveawayId, g.title,
              s.operator_telegram_id as operatorTelegramId,
              s.place_number as placeNumber, s.state, s.reason,
              s.operation_id as operationId,
              coalesce(o.previous_participant_id, v.participant_id)
                as currentParticipantId,
              r.snapshot_json as snapshotJson
         from reroll_sessions s
         join giveaways g on g.id = s.giveaway_id
         join draw_runs r on r.giveaway_id = g.id
         left join reroll_operations o on o.id = s.operation_id
         left join prize_place_versions v
           on v.draw_run_id = r.id and v.place_number = s.place_number
          and v.state = 'selected'
        where s.id = ? and s.operator_telegram_id = ?
          and s.state in ('awaiting_reason', 'awaiting_confirmation', 'completed')
        limit 1`,
      [sessionId, operatorTelegramId],
    );
    const row = rows[0];
    if (!row?.currentParticipantId) return null;
    const snapshot = JSON.parse(row.snapshotJson) as DrawSnapshot;
    const currentParticipant = snapshot.participants.find(
      (participant) => participant.participantId === row.currentParticipantId,
    );
    if (!currentParticipant) {
      throw new Error('Reroll participant is absent from snapshot');
    }
    return { ...row, currentParticipant };
  }

  async #giveawayTitle(
    transaction: DatabaseBoundary,
    giveawayId: string,
  ): Promise<string> {
    const rows = await transaction.all<{ title: string }>(
      'select title from giveaways where id = ?',
      [giveawayId],
    );
    const title = rows[0]?.title;
    if (!title) throw new Error('Unknown giveaway');
    return title;
  }

  async #refreshOperationNotificationStatus(
    transaction: DatabaseBoundary,
    operationId: string,
  ): Promise<void> {
    const rows = await transaction.all<{ status: string }>(
      'select status from draw_notifications where reroll_operation_id = ?',
      [operationId],
    );
    const status = rows.some((row) =>
      ['pending', 'processing'].includes(row.status),
    )
      ? 'pending'
      : rows.some((row) => row.status === 'failed')
        ? 'partial_failure'
        : 'delivered';
    await transaction.execute(
      'update reroll_operations set notification_status = ? where id = ?',
      [status, operationId],
    );
  }
}

function notificationText(payload: string): string {
  const parsed = JSON.parse(payload) as { text?: unknown };
  if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
    throw new Error('Draw notification text is missing');
  }
  return parsed.text;
}

function resultOperationId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { rerollOperationId?: unknown };
    return typeof parsed.rerollOperationId === 'string'
      ? parsed.rerollOperationId
      : null;
  } catch {
    return null;
  }
}

function assertRerollProgressMatchesSnapshot(input: {
  snapshot: DrawSnapshot;
  cursorBefore: number;
  cursorAfter: number;
  activeWinnerParticipantIds: ReadonlySet<string>;
  excludedParticipantIds: ReadonlySet<string>;
  skippedCandidates: Array<{
    participantId: string;
    reason: 'subscription_missing';
  }>;
  newParticipantId: string | null;
}): void {
  const excluded = new Set(input.excludedParticipantIds);
  let skippedIndex = 0;
  let selected = false;
  for (let cursor = input.cursorBefore; cursor < input.cursorAfter; cursor += 1) {
    const participantId = input.snapshot.ticketOrder[cursor];
    if (!participantId) {
      throw new Error('Reroll progress does not match the saved ticket order');
    }
    if (
      input.activeWinnerParticipantIds.has(participantId) ||
      excluded.has(participantId)
    ) {
      continue;
    }
    const skipped = input.skippedCandidates[skippedIndex];
    if (
      skipped?.participantId === participantId &&
      skipped.reason === 'subscription_missing'
    ) {
      excluded.add(participantId);
      skippedIndex += 1;
      continue;
    }
    if (
      input.newParticipantId === participantId &&
      cursor + 1 === input.cursorAfter
    ) {
      selected = true;
      continue;
    }
    throw new Error('Reroll progress does not match the saved ticket order');
  }
  if (
    skippedIndex !== input.skippedCandidates.length ||
    (input.newParticipantId !== null && !selected) ||
    (input.newParticipantId === null &&
      input.cursorAfter !== input.snapshot.ticketOrder.length)
  ) {
    throw new Error('Reroll progress does not match the saved ticket order');
  }
}
