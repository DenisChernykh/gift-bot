import type {
  PostSynchronizationRepository,
  PostSynchronizationTask,
} from '../application/ports/post-synchronization-repository.js';
import type { TelegramPostEdit } from '../application/ports/telegram-gateway.js';
import { renderGiveawayMessage } from '../domain/giveaway-rendering.js';
import type { GiveawayMessageEntity } from '../domain/giveaway-validation.js';
import type { DatabaseBoundary } from './client.js';

export class SqlitePostSynchronizationRepository
  implements PostSynchronizationRepository
{
  readonly #database: DatabaseBoundary;

  constructor(database: DatabaseBoundary) {
    this.#database = database;
  }

  async recoverInterrupted(now: number): Promise<void> {
    await this.#database.execute(
      `update sync_tasks
          set status = 'pending', available_at = min(available_at, ?),
              last_error_kind = 'interrupted', updated_at = ?
        where status = 'processing'
          and task_type in ('cancel_message', 'participant_count')`,
      [now, now],
    );
  }

  async listDueTasks(now: number): Promise<PostSynchronizationTask[]> {
    return this.#database.all<PostSynchronizationTask>(
      `select id, task_type as taskType, payload, attempts
         from sync_tasks
        where status = 'pending' and available_at <= ?
          and task_type in ('cancel_message', 'participant_count')
        order by case task_type when 'cancel_message' then 0 else 1 end,
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
        `update sync_tasks set status = 'processing', updated_at = ?
          where id = ? and status = 'pending'`,
        [now, id],
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

    const rows = await this.#database.all<{
      state: string;
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
      `select g.state, g.title, g.winner_count as winnerCount,
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
    const sourceEntities = JSON.parse(row.contentEntities) as GiveawayMessageEntity[];
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
    };
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
  }

  async failTask(input: {
    id: string;
    errorKind: string;
    availableAt: number;
    now: number;
  }): Promise<void> {
    await this.#database.execute(
      `update sync_tasks
          set status = 'pending', attempts = attempts + 1,
              available_at = max(available_at, ?),
              last_error_kind = ?, updated_at = ?
        where id = ? and status in ('processing', 'pending')`,
      [
        input.availableAt,
        input.errorKind,
        input.now,
        input.id,
      ],
    );
  }

  async supersedeTask(id: string, now: number): Promise<void> {
    await this.#database.execute(
      `update sync_tasks set status = 'superseded', updated_at = ?
        where id = ? and status in ('pending', 'processing')`,
      [now, id],
    );
  }
}
