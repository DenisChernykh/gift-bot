import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GiveawayPostSynchronizationService } from '../../src/application/giveaway-post-synchronization-service.js';
import type { TelegramPostEdit } from '../../src/application/ports/telegram-gateway.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';
import { openDatabase } from '../../src/database/client.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { SqliteParticipantRepository } from '../../src/database/participant-repository.js';
import { SqlitePostSynchronizationRepository } from '../../src/database/post-synchronization-repository.js';
import { hashToken } from '../../src/domain/tokens.js';

const NOW = Date.UTC(2026, 7, 9, 9, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class FakeEditGateway {
  readonly edits: TelegramPostEdit[] = [];
  readonly failures: Array<Error | null> = [];
  beforeEdit?: (input: TelegramPostEdit) => Promise<void>;
  activeEdits = 0;
  maximumConcurrentEdits = 0;

  async editGiveawayPost(input: TelegramPostEdit): Promise<void> {
    this.activeEdits += 1;
    this.maximumConcurrentEdits = Math.max(
      this.maximumConcurrentEdits,
      this.activeEdits,
    );
    try {
      await this.beforeEdit?.(input);
      this.edits.push(input);
      const failure = this.failures.shift();
      if (failure) throw failure;
    } finally {
      this.activeEdits -= 1;
    }
  }
}

async function openSynchronization() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-post-sync-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { force: true, recursive: true });
  });
  await migrateDatabase(opened.database);
  await opened.database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, content_entities, created_by_telegram_id,
       created_at, updated_at
     ) values ('giveaway-1', 'Gift', 'active', 1, ?, 0, 'text', 'Bold',
               '[{"type":"bold","offset":0,"length":4}]', 700, ?, ?)`,
    [NOW + 86_400_000, NOW, NOW],
  );
  await opened.database.execute(
    `insert into giveaway_channels (
       id, giveaway_id, telegram_chat_id, username, title, owner_telegram_id,
       status, created_at, updated_at
     ) values ('channel-1', 'giveaway-1', -1001, 'channel_one', 'One', 700,
               'confirmed', ?, ?)`,
    [NOW, NOW],
  );
  await opened.database.execute(
    `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
     values ('run-1', 'giveaway-1', 'succeeded', ?, ?)`,
    [NOW, NOW],
  );
  await opened.database.execute(
    `insert into publication_deliveries (
       id, publication_run_id, giveaway_channel_id, status, message_id,
       message_kind, created_at, updated_at
     ) values ('delivery-1', 'run-1', 'channel-1', 'delivered', 42, 'text', ?, ?)`,
    [NOW, NOW],
  );
  await opened.database.execute(
    `insert into participants (
       id, giveaway_id, telegram_user_id, username, display_name,
       inviter_participant_id, joined_at, updated_at
     ) values ('participant-1', 'giveaway-1', 900, null, 'Participant', null, ?, ?)`,
    [NOW, NOW],
  );
  await opened.database.execute(
    `insert into sync_tasks (
       id, giveaway_id, giveaway_channel_id, task_type, payload, status,
       attempts, available_at, last_error_kind, created_at, updated_at
     ) values ('counter-1', 'giveaway-1', 'channel-1', 'participant_count',
               '{"targetCount":1}', 'pending', 0, ?, null, ?, ?)`,
    [NOW, NOW, NOW],
  );
  let currentNow = NOW;
  let joinTokenSequence = 0;
  const gateway = new FakeEditGateway();
  const repository = new SqlitePostSynchronizationRepository(opened.database, {
    botUsername: 'gift_test_bot',
    createToken: () => {
      const token = `counter-token-${++joinTokenSequence}`;
      return { token, tokenHash: hashToken(token) };
    },
    now: () => currentNow,
  });
  const service = new GiveawayPostSynchronizationService(repository, gateway, {
    now: () => currentNow,
  });
  return {
    ...opened,
    gateway,
    repository,
    service,
    advanceTime: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

async function seedCompletedDraw(
  database: Awaited<ReturnType<typeof openSynchronization>>['database'],
) {
  const snapshot = {
    version: 1,
    createdAt: NOW,
    winnerCount: 1,
    participants: [
      {
        participantId: 'participant-1',
        telegramUserId: 900,
        username: null,
        displayName: 'Participant',
        inviterParticipantId: null,
        validDirectReferralCount: 0,
        ticketCount: 1,
      },
      {
        participantId: 'participant-2',
        telegramUserId: 901,
        username: 'next_winner',
        displayName: 'Next Winner',
        inviterParticipantId: null,
        validDirectReferralCount: 0,
        ticketCount: 1,
      },
    ],
    ticketOrder: ['participant-1', 'participant-2'],
  };
  await database.execute(
    "update giveaways set state = 'completed' where id = 'giveaway-1'",
  );
  await database.execute(
    `insert into draw_runs (
       id, giveaway_id, snapshot_version, snapshot_json, cursor,
       result_revision, started_at, snapshot_created_at, completed_at, updated_at
     ) values ('draw-1', 'giveaway-1', 1, ?, 1, 1, ?, ?, ?, ?)`,
    [JSON.stringify(snapshot), NOW, NOW, NOW, NOW],
  );
  await database.execute(
    `insert into prize_place_versions (
       id, draw_run_id, place_number, version, state, participant_id,
       created_at, rejected_at
     ) values ('place-1', 'draw-1', 1, 1, 'selected', 'participant-1', ?, null)`,
    [NOW],
  );
  await database.execute(
    `update sync_tasks
        set task_type = 'result', payload = '{"revision":1}', status = 'pending',
            available_at = ? where id = 'counter-1'`,
    [NOW],
  );
}

describe('giveaway post synchronization', () => {
  it('publishes only the current result and removes the participation button', async () => {
    const { database, gateway, service } = await openSynchronization();
    await seedCompletedDraw(database);

    expect(await service.synchronizePending()).toBe(1);

    expect(gateway.edits).toEqual([
      {
        chatId: -1001,
        messageId: 42,
        kind: 'text',
        text: ['Gift', '', 'Итоги:', '1. Participant'].join('\n'),
        entities: [
          {
            type: 'text_link',
            offset: 16,
            length: 11,
            url: 'tg://user?id=900',
          },
        ],
        removeParticipationButton: true,
      },
    ]);
  });

  it('keeps a result task pending when a newer revision arrives during editing', async () => {
    const { database, gateway, service } = await openSynchronization();
    await seedCompletedDraw(database);
    gateway.beforeEdit = async () => {
      gateway.beforeEdit = undefined;
      await database.transaction(async (transaction) => {
        await transaction.execute(
          "update prize_place_versions set state = 'rejected', rejected_at = ? where id = 'place-1'",
          [NOW + 1],
        );
        await transaction.execute(
          `insert into prize_place_versions (
             id, draw_run_id, place_number, version, state, participant_id,
             created_at, rejected_at
           ) values ('place-2', 'draw-1', 1, 2, 'selected', 'participant-2', ?, null)`,
          [NOW + 1],
        );
        await transaction.execute(
          "update draw_runs set result_revision = 2 where id = 'draw-1'",
        );
        await transaction.execute(
          `update sync_tasks set payload = '{"revision":2}', status = 'pending'
            where id = 'counter-1'`,
        );
      });
    };

    expect(await service.synchronizePending()).toBe(1);
    expect(
      await database.all("select status, payload from sync_tasks where id = 'counter-1'"),
    ).toEqual([{ status: 'pending', payload: '{"revision":2}' }]);
    expect(await service.synchronizePending()).toBe(1);
    expect(gateway.edits[1]?.text).toContain('@next_winner');
  });

  it('records successful public synchronization in the private reroll audit', async () => {
    const { database, service } = await openSynchronization();
    await seedCompletedDraw(database);
    await database.execute(
      `insert into reroll_operations (
         id, draw_run_id, place_number, operator_telegram_id, reason,
         previous_participant_id, new_participant_id, skipped_candidates,
         status, cursor_before, cursor_after, result_revision,
         sync_status, notification_status, started_at, finished_at
       ) values ('operation-1', 'draw-1', 1, 700, 'manual_review',
                 'participant-1', 'participant-2', '[]', 'completed',
                 1, 2, 2, 'pending', 'pending', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `update sync_tasks
          set payload = '{"revision":2,"rerollOperationId":"operation-1"}'
        where id = 'counter-1'`,
    );

    await service.synchronizePending();

    expect(
      await database.all(
        "select sync_status from reroll_operations where id = 'operation-1'",
      ),
    ).toEqual([{ sync_status: 'delivered' }]);
  });

  it('keeps reroll audit retrying while any channel result task still has an error', async () => {
    const { database, gateway, service } = await openSynchronization();
    await seedCompletedDraw(database);
    await database.execute(
      `insert into reroll_operations (
         id, draw_run_id, place_number, operator_telegram_id, reason,
         previous_participant_id, new_participant_id, skipped_candidates,
         status, cursor_before, cursor_after, result_revision,
         sync_status, notification_status, started_at, finished_at
       ) values ('operation-1', 'draw-1', 1, 700, 'manual_review',
                 'participant-1', 'participant-2', '[]', 'completed',
                 1, 2, 2, 'pending', 'pending', ?, ?)`,
      [NOW, NOW],
    );
    const payload = '{"revision":2,"rerollOperationId":"operation-1"}';
    await database.execute(
      'update sync_tasks set payload = ? where id = ?',
      [payload, 'counter-1'],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('channel-2', 'giveaway-1', -1002, 'channel_two', 'Two',
                 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('delivery-2', 'run-1', 'channel-2', 'delivered', 43,
                 'text', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into sync_tasks (
         id, giveaway_id, giveaway_channel_id, task_type, payload, status,
         attempts, available_at, last_error_kind, created_at, updated_at
       ) values ('result-2', 'giveaway-1', 'channel-2', 'result', ?,
                 'pending', 0, ?, null, ?, ?)`,
      [payload, NOW, NOW, NOW],
    );
    gateway.failures.push(
      new TelegramDeliveryError('cannot edit first channel', 'definite'),
      null,
    );

    expect(await service.synchronizePending()).toBe(2);
    expect(
      await database.all(
        "select sync_status from reroll_operations where id = 'operation-1'",
      ),
    ).toEqual([{ sync_status: 'retrying' }]);
  });

  it('marks a deterministic result rendering failure terminal instead of retrying forever', async () => {
    const { database, service } = await openSynchronization();
    await seedCompletedDraw(database);
    await database.execute(
      "update giveaways set title = ? where id = 'giveaway-1'",
      ['x'.repeat(4_090)],
    );

    expect(await service.synchronizePending()).toBe(1);
    expect(
      await database.all(
        "select status, attempts, last_error_kind from sync_tasks where id = 'counter-1'",
      ),
    ).toEqual([
      { status: 'failed', attempts: 1, last_error_kind: 'result_rendering' },
    ]);
    expect(await service.synchronizePending()).toBe(0);
  });

  it('renders the latest participant count and preserves source entities', async () => {
    const { database, gateway, service } = await openSynchronization();

    expect(await service.synchronizePending()).toBe(1);

    expect(gateway.edits).toEqual([
      expect.objectContaining({
        chatId: -1001,
        messageId: 42,
        kind: 'text',
        entities: [{ type: 'bold', offset: 6, length: 4 }],
        removeParticipationButton: false,
        joinUrl:
          'https://t.me/gift_test_bot?start=join_counter-token-1',
        text: expect.stringContaining('Зарегистрировано участников: 1'),
      }),
    ]);
    expect(
      await database.all(
        'select token_hash, state from join_tokens order by created_at',
      ),
    ).toEqual([
      { token_hash: hashToken('counter-token-1'), state: 'active' },
    ]);
    expect(
      await database.all(
        "select status, attempts, last_error_kind from sync_tasks where id = 'counter-1'",
      ),
    ).toEqual([{ status: 'completed', attempts: 1, last_error_kind: null }]);
  });

  it('keeps a failed edit pending and honors retry_after without changing participation', async () => {
    const { database, gateway, service } = await openSynchronization();
    gateway.failures.push(
      new TelegramDeliveryError('Too many requests', 'definite', 90_000),
    );

    expect(await service.synchronizePending()).toBe(1);

    expect(
      await database.all(
        `select status, attempts, available_at, last_error_kind
           from sync_tasks where id = 'counter-1'`,
      ),
    ).toEqual([
      {
        status: 'pending',
        attempts: 1,
        available_at: NOW + 90_000,
        last_error_kind: 'telegram_definite',
      },
    ]);
    expect(await database.all('select telegram_user_id from participants')).toEqual([
      { telegram_user_id: 900 },
    ]);
  });

  it('requeues interrupted work and serializes overlapping synchronization calls', async () => {
    const { database, gateway, service } = await openSynchronization();
    await database.execute(
      "update sync_tasks set status = 'processing' where id = 'counter-1'",
    );
    const gate = Promise.withResolvers<void>();
    gateway.beforeEdit = async () => gate.promise;

    await service.recoverInterrupted();
    const first = service.synchronizePending();
    const second = service.synchronizePending();
    await Promise.resolve();
    gate.resolve();

    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(gateway.maximumConcurrentEdits).toBe(1);
  });

  it('preserves the counter throttle when recovering an interrupted claim', async () => {
    const { database, gateway, repository, service, advanceTime } =
      await openSynchronization();

    expect(await repository.claimTask('counter-1', NOW)).not.toBeNull();
    advanceTime(10_000);
    await service.recoverInterrupted();

    expect(await service.synchronizePending()).toBe(0);
    expect(gateway.edits).toEqual([]);
    expect(
      await database.all(
        `select status, available_at, last_error_kind
           from sync_tasks where id = 'counter-1'`,
      ),
    ).toEqual([
      {
        status: 'pending',
        available_at: NOW + 60_000,
        last_error_kind: 'interrupted',
      },
    ]);

    advanceTime(50_000);
    expect(await service.synchronizePending()).toBe(1);
    expect(gateway.edits).toHaveLength(1);
  });

  it('completes successful channels while retaining only the failed channel for retry', async () => {
    const { database, gateway, service } = await openSynchronization();
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('channel-2', 'giveaway-1', -1002, 'channel_two', 'Two',
                 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('delivery-2', 'run-1', 'channel-2', 'delivered', 43,
                 'text', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into sync_tasks (
         id, giveaway_id, giveaway_channel_id, task_type, payload, status,
         attempts, available_at, last_error_kind, created_at, updated_at
       ) values ('counter-2', 'giveaway-1', 'channel-2', 'participant_count',
                 '{"targetCount":1}', 'pending', 0, ?, null, ?, ?)`,
      [NOW, NOW, NOW],
    );
    gateway.failures.push(
      null,
      new TelegramDeliveryError('message unavailable', 'definite'),
    );

    expect(await service.synchronizePending()).toBe(2);
    expect(
      await database.all(
        `select id, status, attempts, available_at
           from sync_tasks order by id`,
      ),
    ).toEqual([
      {
        id: 'counter-1',
        status: 'completed',
        attempts: 1,
        available_at: NOW + 60_000,
      },
      {
        id: 'counter-2',
        status: 'pending',
        attempts: 1,
        available_at: NOW + 60_000,
      },
    ]);
    expect(await database.all('select count(*) as count from participants')).toEqual([
      { count: 1 },
    ]);
  });

  it('preserves caption entities when updating a photo post', async () => {
    const { database, gateway, service } = await openSynchronization();
    await database.execute(
      `update giveaways set content_kind = 'photo' where id = 'giveaway-1'`,
    );
    await database.execute(
      `update publication_deliveries set message_kind = 'photo'
        where id = 'delivery-1'`,
    );

    await service.synchronizePending();

    expect(gateway.edits).toEqual([
      expect.objectContaining({
        kind: 'photo',
        entities: [{ type: 'bold', offset: 6, length: 4 }],
        removeParticipationButton: false,
      }),
    ]);
  });

  it('keeps a coalesced registration during processing throttled from the completed edit', async () => {
    const { database, gateway, service, advanceTime } =
      await openSynchronization();
    const editStarted = Promise.withResolvers<void>();
    const releaseEdit = Promise.withResolvers<void>();
    gateway.beforeEdit = async () => {
      gateway.beforeEdit = undefined;
      editStarted.resolve();
      await releaseEdit.promise;
    };

    const firstPass = service.synchronizePending();
    await editStarted.promise;
    advanceTime(10_000);
    const participants = new SqliteParticipantRepository(database, {
      createId: (kind) => `${kind}-during-edit`,
    });
    await participants.registerParticipant({
      giveawayId: 'giveaway-1',
      telegramUserId: 901,
      username: null,
      displayName: 'Second participant',
      inviterParticipantId: null,
      now: NOW + 10_000,
    });
    const queuedPass = service.synchronizePending();
    releaseEdit.resolve();

    expect(await firstPass).toBe(1);
    expect(await queuedPass).toBe(0);
    expect(gateway.edits).toHaveLength(1);
    expect(
      await database.all(
        `select status, payload, attempts, available_at
           from sync_tasks where id = 'counter-1'`,
      ),
    ).toEqual([
      {
        status: 'pending',
        payload: '{"targetCount":2}',
        attempts: 1,
        available_at: NOW + 70_000,
      },
    ]);

    advanceTime(60_000);
    expect(await service.synchronizePending()).toBe(1);
    expect(gateway.edits).toHaveLength(2);
    expect(gateway.edits[1]!.text).toContain(
      'Зарегистрировано участников: 2',
    );
  });

  it('retains coalesced work when the in-flight edit fails', async () => {
    const { database, gateway, service, advanceTime } =
      await openSynchronization();
    const editStarted = Promise.withResolvers<void>();
    const releaseEdit = Promise.withResolvers<void>();
    gateway.beforeEdit = async () => {
      gateway.beforeEdit = undefined;
      editStarted.resolve();
      await releaseEdit.promise;
    };
    gateway.failures.push(
      new TelegramDeliveryError('Too many requests', 'definite', 90_000),
    );

    const firstPass = service.synchronizePending();
    await editStarted.promise;
    advanceTime(10_000);
    const participants = new SqliteParticipantRepository(database, {
      createId: (kind) => `${kind}-during-failure`,
    });
    await participants.registerParticipant({
      giveawayId: 'giveaway-1',
      telegramUserId: 902,
      username: null,
      displayName: 'Second participant',
      inviterParticipantId: null,
      now: NOW + 10_000,
    });
    releaseEdit.resolve();

    expect(await firstPass).toBe(1);
    expect(
      await database.all(
        `select status, payload, attempts, available_at, last_error_kind
           from sync_tasks where id = 'counter-1'`,
      ),
    ).toEqual([
      {
        status: 'pending',
        payload: '{"targetCount":2}',
        attempts: 1,
        available_at: NOW + 100_000,
        last_error_kind: 'telegram_definite',
      },
    ]);

    expect(await service.synchronizePending()).toBe(0);
    advanceTime(90_000);
    expect(await service.synchronizePending()).toBe(1);
    expect(gateway.edits.at(-1)!.text).toContain(
      'Зарегистрировано участников: 2',
    );
  });
});
