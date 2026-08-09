import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/database/client.js';
import { SqliteDrawRepository } from '../../src/database/draw-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import type { DrawSnapshot } from '../../src/domain/giveaway-draw.js';

const NOW = Date.UTC(2026, 7, 9, 10, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function openDrawDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-draw-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { force: true, recursive: true });
  });
  await migrateDatabase(opened.database);
  let sequence = 0;
  const repository = new SqliteDrawRepository(opened.database, {
    createId: (kind) => `${kind}-${++sequence}`,
  });
  return { ...opened, repository };
}

async function seedGiveaway(
  database: Awaited<ReturnType<typeof openDrawDatabase>>['database'],
  id: string,
  deadlineUtc = NOW - 1,
) {
  await database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, content_entities, created_by_telegram_id,
       created_at, updated_at
     ) values (?, ?, 'active', 2, ?, 1, 'text', 'Gift', '[]', 700, ?, ?)`,
    [id, `Gift ${id}`, deadlineUtc, NOW - 100, NOW - 100],
  );
  await database.execute(
    `insert into giveaway_channels (
       id, giveaway_id, telegram_chat_id, username, title, owner_telegram_id,
       status, created_at, updated_at
     ) values (?, ?, ?, ?, 'Channel', 700, 'confirmed', ?, ?)`,
    [`channel-${id}`, id, -1000 - id.length, `channel_${id}`, NOW, NOW],
  );
  await database.execute(
    `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
     values (?, ?, 'succeeded', ?, ?)`,
    [`publication-${id}`, id, NOW, NOW],
  );
  await database.execute(
    `insert into publication_deliveries (
       id, publication_run_id, giveaway_channel_id, status, message_id,
       message_kind, created_at, updated_at
     ) values (?, ?, ?, 'delivered', 42, 'text', ?, ?)`,
    [`delivery-${id}`, `publication-${id}`, `channel-${id}`, NOW, NOW],
  );
  await database.execute(
    `insert into join_tokens (token_hash, giveaway_id, state, expires_at, created_at)
     values (?, ?, 'active', null, ?)`,
    [`join-${id}`, id, NOW],
  );
  await database.execute(
    `insert into participants (
       id, giveaway_id, telegram_user_id, username, display_name,
       inviter_participant_id, joined_at, updated_at
     ) values (?, ?, 101, 'alice', 'Alice', null, ?, ?),
              (?, ?, 102, null, 'Bob', ?, ?, ?),
              (?, ?, 103, 'carol', 'Carol', null, ?, ?)`,
    [
      `alice-${id}`,
      id,
      NOW - 50,
      NOW - 50,
      `bob-${id}`,
      id,
      `alice-${id}`,
      NOW - 40,
      NOW - 40,
      `carol-${id}`,
      id,
      NOW - 30,
      NOW - 30,
    ],
  );
}

function snapshot(giveawayId: string): DrawSnapshot {
  return {
    version: 1,
    createdAt: NOW,
    winnerCount: 2,
    participants: [
      {
        participantId: `alice-${giveawayId}`,
        telegramUserId: 101,
        username: 'alice',
        displayName: 'Alice',
        inviterParticipantId: null,
        validDirectReferralCount: 1,
        ticketCount: 1,
      },
      {
        participantId: `bob-${giveawayId}`,
        telegramUserId: 102,
        username: null,
        displayName: 'Bob',
        inviterParticipantId: `alice-${giveawayId}`,
        validDirectReferralCount: 0,
        ticketCount: 1,
      },
      {
        participantId: `carol-${giveawayId}`,
        telegramUserId: 103,
        username: 'carol',
        displayName: 'Carol',
        inviterParticipantId: null,
        validDirectReferralCount: 0,
        ticketCount: 1,
      },
    ],
    ticketOrder: [
      `alice-${giveawayId}`,
      `bob-${giveawayId}`,
      `carol-${giveawayId}`,
    ],
  };
}

describe('SqliteDrawRepository', () => {
  it('atomically claims each due giveaway once and ignores future deadlines', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await seedGiveaway(database, 'two');
    await seedGiveaway(database, 'future', NOW + 60_000);

    const [first, second] = await Promise.all([
      repository.claimNextDue(NOW),
      repository.claimNextDue(NOW),
    ]);

    expect(new Set([first?.id, second?.id])).toEqual(new Set(['one', 'two']));
    expect(await repository.claimNextDue(NOW)).toBeNull();
    expect(
      await database.all('select id, state from giveaways order by id'),
    ).toEqual([
      { id: 'future', state: 'active' },
      { id: 'one', state: 'drawing' },
      { id: 'two', state: 'drawing' },
    ]);
  });

  it('persists the first snapshot and returns it unchanged after restart', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);

    expect(
      await repository.saveSnapshot({
        giveawayId: 'one',
        snapshot: snapshot('one'),
        now: NOW,
      }),
    ).toEqual(snapshot('one'));
    const replacement = { ...snapshot('one'), ticketOrder: ['bob-one', 'alice-one'] };
    expect(
      await repository.saveSnapshot({
        giveawayId: 'one',
        snapshot: replacement,
        now: NOW + 1,
      }),
    ).toEqual(snapshot('one'));
    expect((await repository.listDrawing())[0]?.snapshot).toEqual(snapshot('one'));
    await expect(
      database.execute(
        "update draw_runs set snapshot_json = '{}' where giveaway_id = 'one'",
      ),
    ).rejects.toThrow('immutable');
  });

  it('completes from the stored snapshot and creates result, sync and notification state atomically', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);
    await repository.saveSnapshot({
      giveawayId: 'one',
      snapshot: snapshot('one'),
      now: NOW,
    });

    const completed = await repository.completeDraw({
      giveawayId: 'one',
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice-one' },
        { placeNumber: 2, status: 'selected', participantId: 'bob-one' },
      ],
      cursor: 2,
      teamTelegramIds: [700, 701],
      now: NOW + 1,
    });

    expect(completed).toMatchObject({
      giveawayId: 'one',
      cursor: 2,
      resultRevision: 1,
      places: [
        { placeNumber: 1, participantId: 'alice-one' },
        { placeNumber: 2, participantId: 'bob-one' },
      ],
    });
    expect(await database.all("select state from giveaways where id = 'one'"))
      .toEqual([{ state: 'completed' }]);
    expect(await database.all("select state from join_tokens where giveaway_id = 'one'"))
      .toEqual([{ state: 'revoked' }]);
    expect(
      await database.all(
        "select task_type, payload, status from sync_tasks where giveaway_id = 'one'",
      ),
    ).toEqual([
      { task_type: 'result', payload: '{"revision":1}', status: 'pending' },
    ]);
    expect(
      await database.all(
        "select kind, recipient_telegram_id, status from draw_notifications where giveaway_id = 'one' order by kind, recipient_telegram_id",
      ),
    ).toEqual([
      { kind: 'team_result', recipient_telegram_id: 700, status: 'pending' },
      { kind: 'team_result', recipient_telegram_id: 701, status: 'pending' },
      { kind: 'winner', recipient_telegram_id: 101, status: 'pending' },
      { kind: 'winner', recipient_telegram_id: 102, status: 'pending' },
    ]);
  });

  it('rejects an initial result that does not match the immutable ticket order', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);
    await repository.saveSnapshot({
      giveawayId: 'one',
      snapshot: snapshot('one'),
      now: NOW,
    });

    await expect(
      repository.completeDraw({
        giveawayId: 'one',
        places: [
          { placeNumber: 1, status: 'selected', participantId: 'alice-one' },
          { placeNumber: 2, status: 'selected', participantId: 'alice-one' },
        ],
        cursor: 2,
        teamTelegramIds: [700],
        now: NOW + 1,
      }),
    ).rejects.toThrow('immutable ticket order');
    expect(await database.all("select state from giveaways where id = 'one'"))
      .toEqual([{ state: 'drawing' }]);
    expect(await database.all('select id from prize_place_versions')).toEqual([]);
  });

  it('fails without selecting and only returns to drawing after an explicit retry', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);

    await repository.failDraw({
      giveawayId: 'one',
      stage: 'final_eligibility',
      errorKind: 'telegram_unknown',
      teamTelegramIds: [700],
      now: NOW + 1,
    });

    expect(await repository.listDrawing()).toEqual([]);
    expect(await repository.retryFailedDraw('one', NOW + 2)).toBe(true);
    expect(await repository.retryFailedDraw('one', NOW + 3)).toBe(false);
    expect((await repository.getDrawing('one'))?.snapshot).toBeNull();
    expect(
      await database.all(
        "select failure_stage, failure_error_kind from draw_runs where giveaway_id = 'one'",
      ),
    ).toEqual([{ failure_stage: null, failure_error_kind: null }]);
    await repository.saveSnapshot({
      giveawayId: 'one',
      snapshot: snapshot('one'),
      now: NOW + 3,
    });
    await repository.completeDraw({
      giveawayId: 'one',
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice-one' },
        { placeNumber: 2, status: 'selected', participantId: 'bob-one' },
      ],
      cursor: 2,
      teamTelegramIds: [700],
      now: NOW + 4,
    });
    expect(
      await database.all(
        "select status from draw_notifications where giveaway_id = 'one' and kind = 'team_failure'",
      ),
    ).toEqual([{ status: 'superseded' }]);
  });

  it('rerolls one occupied place atomically and replays the saved operation', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);
    await repository.saveSnapshot({
      giveawayId: 'one',
      snapshot: snapshot('one'),
      now: NOW,
    });
    await repository.completeDraw({
      giveawayId: 'one',
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice-one' },
        { placeNumber: 2, status: 'selected', participantId: 'bob-one' },
      ],
      cursor: 2,
      teamTelegramIds: [700],
      now: NOW + 1,
    });
    const session = await repository.startRerollSession({
      id: 'session-one',
      giveawayId: 'one',
      placeNumber: 1,
      operatorTelegramId: 700,
      now: NOW + 2,
    });
    expect(session.currentParticipant.participantId).toBe('alice-one');
    await repository.saveRerollReason({
      sessionId: session.id,
      operatorTelegramId: 700,
      reason: 'bot_or_suspicious_account',
      now: NOW + 3,
    });
    const input = {
      operationId: 'operation-one',
      sessionId: session.id,
      operatorTelegramId: 700,
      previousParticipantId: 'alice-one',
      newParticipantId: 'carol-one',
      skippedCandidates: [],
      cursorBefore: 2,
      cursorAfter: 3,
      teamTelegramIds: [700],
      now: NOW + 4,
    } as const;

    await expect(
      repository.commitReroll({
        ...input,
        operationId: 'backward-cursor',
        cursorAfter: 1,
      }),
    ).rejects.toThrow('cursor');
    await expect(
      repository.commitReroll({
        ...input,
        operationId: 'unconsumed-candidate',
        cursorAfter: 2,
      }),
    ).rejects.toThrow('saved ticket order');
    await expect(
      repository.commitReroll({
        ...input,
        operationId: 'duplicate-winner',
        newParticipantId: 'bob-one',
      }),
    ).rejects.toThrow('already occupies');

    const first = await repository.commitReroll(input);
    const replay = await repository.commitReroll(input);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      operationId: 'operation-one',
      giveawayId: 'one',
      placeNumber: 1,
      previousParticipantId: 'alice-one',
      newParticipantId: 'carol-one',
      cursor: 3,
      resultRevision: 2,
    });
    expect((await repository.getCompletedDraw('one'))?.places).toEqual([
      expect.objectContaining({ placeNumber: 1, participantId: 'carol-one' }),
      expect.objectContaining({ placeNumber: 2, participantId: 'bob-one' }),
    ]);
    expect(
      await database.all(
        "select participant_id, state from prize_place_versions where place_number = 1 order by version",
      ),
    ).toEqual([
      { participant_id: 'alice-one', state: 'rejected' },
      { participant_id: 'carol-one', state: 'selected' },
    ]);
    expect(
      await database.all(
        "select participant_id, reason from draw_exclusions where draw_run_id = 'draw_run-1'",
      ),
    ).toEqual([
      {
        participant_id: 'alice-one',
        reason: 'bot_or_suspicious_account',
      },
    ]);
    expect(
      await database.all(
        "select payload, status from sync_tasks where giveaway_id = 'one' and task_type = 'result'",
      ),
    ).toEqual([
      {
        payload: '{"revision":2,"rerollOperationId":"operation-one"}',
        status: 'pending',
      },
    ]);
    expect(await repository.listRerollAudit('one')).toEqual([
      expect.objectContaining({
        operationId: 'operation-one',
        operatorTelegramId: 700,
        reason: 'bot_or_suspicious_account',
        skippedCandidates: [],
        startedAt: NOW + 2,
        finishedAt: NOW + 4,
      }),
    ]);
    const rerollNotifications = await database.all<{ id: string }>(
      "select id from draw_notifications where reroll_operation_id = 'operation-one' order by kind",
    );
    const firstNotification = await repository.claimNotification(
      rerollNotifications[0]!.id,
      NOW + 5,
    );
    await repository.completeNotification(firstNotification!.id, NOW + 5);
    const secondNotification = await repository.claimNotification(
      rerollNotifications[1]!.id,
      NOW + 5,
    );
    await repository.failNotification({
      id: secondNotification!.id,
      terminal: true,
      errorKind: 'telegram_client',
      availableAt: NOW + 5,
      now: NOW + 5,
    });
    expect(await repository.listRerollAudit('one')).toEqual([
      expect.objectContaining({ notificationStatus: 'partial_failure' }),
    ]);
  });

  it('exposes skipped candidate identities and reasons in the private reroll audit', async () => {
    const { database, repository } = await openDrawDatabase();
    await seedGiveaway(database, 'one');
    await repository.claimNextDue(NOW);
    await repository.saveSnapshot({
      giveawayId: 'one',
      snapshot: snapshot('one'),
      now: NOW,
    });
    await repository.completeDraw({
      giveawayId: 'one',
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice-one' },
        { placeNumber: 2, status: 'selected', participantId: 'bob-one' },
      ],
      cursor: 2,
      teamTelegramIds: [700],
      now: NOW + 1,
    });
    const session = await repository.startRerollSession({
      id: 'session-audit',
      giveawayId: 'one',
      placeNumber: 1,
      operatorTelegramId: 700,
      now: NOW + 2,
    });
    await repository.saveRerollReason({
      sessionId: session.id,
      operatorTelegramId: 700,
      reason: 'manual_check',
      now: NOW + 3,
    });
    await repository.commitReroll({
      operationId: 'operation-audit',
      sessionId: session.id,
      operatorTelegramId: 700,
      previousParticipantId: 'alice-one',
      newParticipantId: null,
      skippedCandidates: [
        { participantId: 'carol-one', reason: 'subscription_missing' },
      ],
      cursorBefore: 2,
      cursorAfter: 3,
      teamTelegramIds: [700],
      now: NOW + 4,
    });

    expect((await repository.listRerollAudit('one'))[0]?.skippedCandidates).toEqual([
      {
        participantId: 'carol-one',
        reason: 'subscription_missing',
        participant: expect.objectContaining({
          telegramUserId: 103,
          username: 'carol',
          displayName: 'Carol',
        }),
      },
    ]);
  });
});
