import type {
  PostSynchronizationRepository,
  PostSynchronizationTask,
} from '../application/ports/post-synchronization-repository.js';
import type { TelegramPostEdit } from '../application/ports/telegram-gateway.js';
import { renderGiveawayMessage } from '../domain/giveaway-rendering.js';
import { renderGiveawayResult } from '../domain/giveaway-result-rendering.js';
import type { DrawSnapshot } from '../domain/giveaway-draw.js';
import { createStoredToken } from '../domain/tokens.js';
import type { GiveawayMessageEntity } from '../domain/giveaway-validation.js';
import type { DatabaseBoundary } from './client.js';

type PostSynchronizationRepositoryDependencies = {
  botUsername: string;
  createToken: typeof createStoredToken;
  now: () => number;
};

const defaultDependencies: Omit<
  PostSynchronizationRepositoryDependencies,
  'botUsername'
> = {
  createToken: createStoredToken,
  now: Date.now,
};

export class SqlitePostSynchronizationRepository
  implements PostSynchronizationRepository
{
  readonly #database: DatabaseBoundary;
  readonly #dependencies: PostSynchronizationRepositoryDependencies;

  constructor(
    database: DatabaseBoundary,
    dependencies: Partial<PostSynchronizationRepositoryDependencies> &
      Pick<PostSynchronizationRepositoryDependencies, 'botUsername'>,
  ) {
    this.#database = database;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async recoverInterrupted(now: number): Promise<void> {
    await this.#database.execute(
      `update sync_tasks
          set status = 'pending',
              available_at = case
                when task_type = 'participant_count' then available_at
                else min(available_at, ?)
              end,
              last_error_kind = 'interrupted', updated_at = ?
        where status = 'processing'
          and task_type in ('cancel_message', 'result', 'participant_count')`,
      [now, now],
    );
  }

  async listDueTasks(now: number): Promise<PostSynchronizationTask[]> {
    return this.#database.all<PostSynchronizationTask>(
      `select id, task_type as taskType, payload, attempts
         from sync_tasks
        where status = 'pending' and available_at <= ?
          and task_type in ('cancel_message', 'result', 'participant_count')
        order by case task_type
                   when 'cancel_message' then 0
                   when 'result' then 1
                   else 2
                 end,
                 created_at, id`,
      [now],
    );
  }

  async claimTask(
    id: string,
    now: number,
  ): Promise<PostSynchronizationTask | null> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<PostSynchronizationTask>(
        `select id, task_type as taskType, payload, attempts
           from sync_tasks
          where id = ? and status = 'pending' and available_at <= ?`,
        [id, now],
      );
      const task = rows[0];
      if (!task) return null;
      await transaction.execute(
        `update sync_tasks
            set status = 'processing',
                available_at = case
                  when task_type = 'participant_count'
                    then max(available_at, ?)
                  else available_at
                end,
                updated_at = ?
          where id = ? and status = 'pending'`,
        [now + 60_000, now, id],
      );
      return task;
    });
  }

  async getTaskEdit(
    task: PostSynchronizationTask,
  ): Promise<TelegramPostEdit | null> {
    if (task.taskType === 'cancel_message') {
      const payload = JSON.parse(task.payload) as {
        chatId: number;
        messageId: number;
        messageKind: 'text' | 'photo';
        text: string;
      };
      return {
        chatId: payload.chatId,
        messageId: payload.messageId,
        kind: payload.messageKind,
        text: payload.text,
        entities: [],
        removeParticipationButton: true,
      };
    }

    if (task.taskType === 'result') {
      const rows = await this.#database.all<{
        title: string;
        snapshotJson: string;
        chatId: number;
        messageId: number;
        messageKind: 'text' | 'photo';
      }>(
        `select g.title, r.snapshot_json as snapshotJson,
                c.telegram_chat_id as chatId, d.message_id as messageId,
                d.message_kind as messageKind
           from sync_tasks t
           join giveaways g on g.id = t.giveaway_id
           join draw_runs r on r.giveaway_id = g.id
           join giveaway_channels c on c.id = t.giveaway_channel_id
           join publication_deliveries d on d.giveaway_channel_id = c.id
           join publication_runs p on p.id = d.publication_run_id
          where t.id = ? and t.task_type = 'result'
            and g.state = 'completed' and r.snapshot_json is not null
            and p.giveaway_id = g.id and p.status = 'succeeded'
            and d.status = 'delivered' and d.message_id is not null
          order by d.created_at desc, d.id desc limit 1`,
        [task.id],
      );
      const row = rows[0];
      if (!row) return null;
      const snapshot = JSON.parse(row.snapshotJson) as DrawSnapshot;
      const participants = new Map(
        snapshot.participants.map((participant) => [
          participant.participantId,
          participant,
        ]),
      );
      const places = await this.#database.all<{
        placeNumber: number;
        participantId: string | null;
      }>(
        `select v.place_number as placeNumber,
                v.participant_id as participantId
           from prize_place_versions v
           join draw_runs r on r.id = v.draw_run_id
           join sync_tasks t on t.giveaway_id = r.giveaway_id
          where t.id = ? and v.state in ('selected', 'empty')
          order by v.place_number`,
        [task.id],
      );
      const rendered = renderGiveawayResult({
        title: row.title,
        kind: row.messageKind,
        eligibleParticipantCount: snapshot.participants.length,
        places: places.map((place) => ({
          placeNumber: place.placeNumber,
          participant: place.participantId
            ? (participants.get(place.participantId) ?? null)
            : null,
        })),
      });
      return {
        chatId: row.chatId,
        messageId: row.messageId,
        kind: row.messageKind,
        ...rendered,
        removeParticipationButton: true,
      };
    }

    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        state: string;
        giveawayId: string;
        title: string;
        winnerCount: number;
        deadlineUtc: number;
        referralsEnabled: number;
        contentKind: 'text' | 'photo';
        contentText: string;
        contentEntities: string;
        chatId: number;
        messageId: number;
        messageKind: 'text' | 'photo';
        participantCount: number;
      }>(
        `select g.state, g.id as giveawayId, g.title,
                g.winner_count as winnerCount,
                g.deadline_utc as deadlineUtc,
                g.referrals_enabled as referralsEnabled,
                g.content_kind as contentKind, g.content_text as contentText,
                g.content_entities as contentEntities,
                c.telegram_chat_id as chatId, d.message_id as messageId,
                d.message_kind as messageKind,
                (select count(*) from participants p
                  where p.giveaway_id = g.id) as participantCount
           from sync_tasks t
           join giveaways g on g.id = t.giveaway_id
           join giveaway_channels c on c.id = t.giveaway_channel_id
           join publication_deliveries d on d.giveaway_channel_id = c.id
           join publication_runs r on r.id = d.publication_run_id
          where t.id = ? and r.giveaway_id = g.id and r.status = 'succeeded'
            and d.status = 'delivered' and d.message_id is not null
          order by d.created_at desc, d.id desc limit 1`,
        [task.id],
      );
      const row = rows[0];
      if (!row || row.state !== 'active') return null;

      const joinToken = this.#dependencies.createToken();
      await transaction.execute(
        `insert into join_tokens (
           token_hash, giveaway_id, state, expires_at, created_at
         ) values (?, ?, 'active', null, ?)`,
        [joinToken.tokenHash, row.giveawayId, this.#dependencies.now()],
      );

      const content =
        row.contentKind === 'text'
          ? ({ kind: 'text', text: row.contentText } as const)
          : ({ kind: 'photo', caption: row.contentText } as const);
      const rendered = renderGiveawayMessage(
        {
          title: row.title,
          winnerCount: row.winnerCount,
          deadlineUtc: row.deadlineUtc,
          referralsEnabled: row.referralsEnabled === 1,
          content,
        },
        row.participantCount,
      );
      const sourceEntities = JSON.parse(
        row.contentEntities,
      ) as GiveawayMessageEntity[];
      const contentOffset = row.title.length + 2;
      return {
        chatId: row.chatId,
        messageId: row.messageId,
        kind: row.messageKind,
        text: rendered.text,
        entities: sourceEntities.map((entity) => ({
          ...entity,
          offset: entity.offset + contentOffset,
        })),
        removeParticipationButton: false,
        joinUrl: `https://t.me/${this.#dependencies.botUsername}?start=join_${joinToken.token}`,
      };
    });
  }

  async completeTask(input: {
    id: string;
    expectedPayload: string;
    availableAt: number;
    now: number;
  }): Promise<void> {
    await this.#database.execute(
      `update sync_tasks
          set status = case
                when payload = ? then 'completed'
                else 'pending'
              end,
              attempts = attempts + 1,
              available_at = case
                when task_type = 'participant_count' and payload <> ?
                  then max(available_at, ?)
                else available_at
              end,
              last_error_kind = null, updated_at = ?
        where id = ? and status in ('processing', 'pending')`,
      [
        input.expectedPayload,
        input.expectedPayload,
        input.availableAt,
        input.now,
        input.id,
      ],
    );
    await this.#refreshRerollSyncStatus(input.id, input.expectedPayload, false);
  }

  async failTask(input: {
    id: string;
    errorKind: string;
    terminal: boolean;
    availableAt: number;
    now: number;
  }): Promise<void> {
    await this.#database.execute(
      `update sync_tasks
          set status = ?, attempts = attempts + 1,
              available_at = max(available_at, ?),
              last_error_kind = ?, updated_at = ?
        where id = ? and status in ('processing', 'pending')`,
      [
        input.terminal ? 'failed' : 'pending',
        input.availableAt,
        input.errorKind,
        input.now,
        input.id,
      ],
    );
    const tasks = await this.#database.all<{ payload: string }>(
      'select payload from sync_tasks where id = ?',
      [input.id],
    );
    await this.#refreshRerollSyncStatus(
      input.id,
      tasks[0]?.payload ?? '',
      input.terminal ? 'failed' : 'retrying',
    );
  }

  async supersedeTask(id: string, now: number): Promise<void> {
    await this.#database.execute(
      `update sync_tasks set status = 'superseded', updated_at = ?
        where id = ? and status in ('pending', 'processing')`,
      [now, id],
    );
  }

  async #refreshRerollSyncStatus(
    taskId: string,
    payload: string,
    failureStatus: 'retrying' | 'failed' | false,
  ): Promise<void> {
    const operationId = resultOperationId(payload);
    if (!operationId) return;
    if (failureStatus) {
      await this.#database.execute(
        `update reroll_operations set sync_status = ?
          where id = ? and sync_status in ('pending', 'retrying')`,
        [failureStatus, operationId],
      );
      return;
    }
    const taskRows = await this.#database.all<{
      giveawayId: string;
    }>(
      'select giveaway_id as giveawayId from sync_tasks where id = ?',
      [taskId],
    );
    const giveawayId = taskRows[0]?.giveawayId;
    if (!giveawayId) return;
    const resultTasks = await this.#database.all<{
      payload: string;
      status: string;
      lastErrorKind: string | null;
    }>(
      `select payload, status, last_error_kind as lastErrorKind from sync_tasks
        where giveaway_id = ? and task_type = 'result'`,
      [giveawayId],
    );
    const delivered =
      resultTasks.length > 0 &&
      resultTasks.every(
        (task) =>
          resultOperationId(task.payload) === operationId &&
          task.status === 'completed',
      );
    const retrying = resultTasks.some(
      (task) =>
        resultOperationId(task.payload) === operationId &&
        task.lastErrorKind !== null,
    );
    await this.#database.execute(
      `update reroll_operations set sync_status = ?
        where id = ? and sync_status in ('pending', 'retrying')`,
      [delivered ? 'delivered' : retrying ? 'retrying' : 'pending', operationId],
    );
  }
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
