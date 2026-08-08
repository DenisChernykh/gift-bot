import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ParticipantRegistrationService } from '../../src/application/participant-registration-service.js';
import type { ParticipantMembership } from '../../src/domain/participant-rules.js';
import { hashToken } from '../../src/domain/tokens.js';
import { openDatabase } from '../../src/database/client.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { SqliteParticipantRepository } from '../../src/database/participant-repository.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';

const NOW = Date.UTC(2026, 7, 9, 8, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class FakeMembershipGateway {
  readonly participantMemberships = new Map<number, ParticipantMembership>();
  readonly botAdministrator = new Map<number, boolean>();
  failure: Error | null = null;
  afterParticipantCheck: (() => Promise<void>) | null = null;

  async getChannelSnapshot(chatId: number) {
    if (this.failure) throw this.failure;
    return {
      username: `channel_${Math.abs(chatId)}`,
      title: `Channel ${chatId}`,
      membership: {
        status: this.botAdministrator.get(chatId) === false ? 'left' : 'administrator',
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
    if (this.failure) throw this.failure;
    const membership =
      this.participantMemberships.get(telegramUserId) ?? { status: 'left' as const };
    const afterParticipantCheck = this.afterParticipantCheck;
    this.afterParticipantCheck = null;
    await afterParticipantCheck?.();
    return membership;
  }
}

async function openApplication(options: { referralsEnabled?: boolean; channels?: number[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-participant-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { force: true, recursive: true });
  });
  await migrateDatabase(opened.database);
  await opened.database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, created_by_telegram_id, created_at, updated_at
     ) values ('giveaway-1', 'August gift', 'active', 1, ?, ?,
               'text', 'Conditions', 700, ?, ?)`,
    [NOW + 86_400_000, options.referralsEnabled ? 1 : 0, NOW, NOW],
  );
  await opened.database.execute(
    `insert into join_tokens (token_hash, giveaway_id, state, expires_at, created_at)
     values (?, 'giveaway-1', 'active', null, ?)`,
    [hashToken('join-token'), NOW],
  );
  await opened.database.execute(
    `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
     values ('run-1', 'giveaway-1', 'succeeded', ?, ?)`,
    [NOW, NOW],
  );
  for (const [index, chatId] of (options.channels ?? [-1001]).entries()) {
    const channelId = `channel-${index + 1}`;
    await opened.database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title, owner_telegram_id,
         status, created_at, updated_at
       ) values (?, 'giveaway-1', ?, ?, ?, 700, 'confirmed', ?, ?)`,
      [channelId, chatId, `channel_${index + 1}`, `Channel ${index + 1}`, NOW, NOW],
    );
    await opened.database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values (?, 'run-1', ?, 'delivered', ?, 'text', ?, ?)`,
      [`delivery-${index + 1}`, channelId, 100 + index, NOW, NOW],
    );
  }

  let id = 0;
  let token = 0;
  let currentNow = NOW;
  const repository = new SqliteParticipantRepository(opened.database, {
    createId: (kind) => `${kind}-${++id}`,
  });
  const gateway = new FakeMembershipGateway();
  const service = new ParticipantRegistrationService(repository, gateway, {
    now: () => currentNow,
    createToken: () => {
      const raw = `referral-${++token}`;
      return { token: raw, tokenHash: hashToken(raw) };
    },
    botUsername: 'gift_bot',
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

describe('participant registration', () => {
  it('creates one participant and one coalesced counter task per published post', async () => {
    const { database, gateway, service } = await openApplication({
      channels: [-1001, -1002],
    });
    gateway.participantMemberships.set(900, { status: 'member' });

    const first = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: null, displayName: 'No Username' },
    });
    const repeated = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: 'new_name', displayName: 'Updated Name' },
    });

    expect(first).toMatchObject({ kind: 'registered', created: true, participantCount: 1 });
    expect(repeated).toMatchObject({ kind: 'registered', created: false, participantCount: 1 });
    expect(
      await database.all(
        `select telegram_user_id, username, display_name, joined_at,
                inviter_participant_id from participants`,
      ),
    ).toEqual([
      {
        telegram_user_id: 900,
        username: 'new_name',
        display_name: 'Updated Name',
        joined_at: NOW,
        inviter_participant_id: null,
      },
    ]);
    expect(
      await database.all(
        `select giveaway_channel_id, task_type, status, payload
           from sync_tasks order by giveaway_channel_id`,
      ),
    ).toEqual([
      {
        giveaway_channel_id: 'channel-1',
        task_type: 'participant_count',
        status: 'pending',
        payload: '{"targetCount":1}',
      },
      {
        giveaway_channel_id: 'channel-2',
        task_type: 'participant_count',
        status: 'pending',
        payload: '{"targetCount":1}',
      },
    ]);
  });

  it('lists every missing channel and creates no participant', async () => {
    const { database, gateway, service } = await openApplication({
      channels: [-1001, -1002],
    });
    gateway.participantMemberships.set(900, { status: 'left' });

    const result = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });

    expect(result).toMatchObject({
      kind: 'missing_memberships',
      channels: [{ username: 'channel_1' }, { username: 'channel_2' }],
    });
    expect(await database.all('select id from participants')).toEqual([]);
  });

  it('fails closed on Telegram errors and exposes retry_after without inserting', async () => {
    const { database, gateway, service } = await openApplication();
    gateway.failure = new TelegramDeliveryError('Too many requests', 'definite', 9_000);

    const result = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });

    expect(result).toMatchObject({ kind: 'retry_later', retryAfterMs: 9_000 });
    expect(await database.all('select id from participants')).toEqual([]);
  });

  it('deduplicates an active rights-loss alert and blocks registration', async () => {
    const { database, gateway, service } = await openApplication();
    gateway.botAdministrator.set(-1001, false);

    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });
    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 901, username: 'second', displayName: 'Second' },
    });

    expect(
      await database.all(
        `select giveaway_id, giveaway_channel_id, kind, state, notified_at
           from channel_health_alerts`,
      ),
    ).toEqual([
      {
        giveaway_id: 'giveaway-1',
        giveaway_channel_id: 'channel-1',
        kind: 'bot_admin_rights_lost',
        state: 'active',
        notified_at: null,
      },
    ]);
    expect(await database.all('select id from participants')).toEqual([]);
  });

  it('records rights-loss alerts for every affected channel', async () => {
    const { database, gateway, service } = await openApplication({
      channels: [-1001, -1002],
    });
    gateway.botAdministrator.set(-1001, false);
    gateway.botAdministrator.set(-1002, false);

    const result = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });

    expect(result).toMatchObject({ kind: 'retry_later' });
    expect(
      await database.all(
        `select giveaway_channel_id, state
           from channel_health_alerts order by giveaway_channel_id`,
      ),
    ).toEqual([
      { giveaway_channel_id: 'channel-1', state: 'active' },
      { giveaway_channel_id: 'channel-2', state: 'active' },
    ]);
    expect(await database.all('select id from participants')).toEqual([]);
  });

  it('closes the active rights alert after a later successful bot check', async () => {
    const { database, gateway, service } = await openApplication();
    gateway.botAdministrator.set(-1001, false);
    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: null, displayName: 'Guest' },
    });

    gateway.botAdministrator.set(-1001, true);
    gateway.participantMemberships.set(900, { status: 'left' });
    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: null, displayName: 'Guest' },
    });

    expect(
      await database.all(
        'select state, resolved_at from channel_health_alerts',
      ),
    ).toEqual([{ state: 'resolved', resolved_at: NOW }]);
  });

  it('rechecks cancellation inside the insert transaction', async () => {
    const { database, gateway, service } = await openApplication();
    gateway.participantMemberships.set(900, { status: 'member' });
    gateway.afterParticipantCheck = async () => {
      await database.execute(
        "update giveaways set state = 'cancelled' where id = 'giveaway-1'",
      );
    };

    await expect(
      service.joinWithToken({
        kind: 'join',
        token: 'join-token',
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(await database.all('select id from participants')).toEqual([]);
  });

  it('coalesces concurrent attempts through the unique participant identity', async () => {
    const { database, gateway, service } = await openApplication();
    gateway.participantMemberships.set(900, { status: 'member' });

    const results = await Promise.all([
      service.joinWithToken({
        kind: 'join',
        token: 'join-token',
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
      service.joinWithToken({
        kind: 'join',
        token: 'join-token',
        user: { telegramUserId: 900, username: 'guest', displayName: 'Guest 2' },
      }),
    ]);

    expect(results.map((result) => result.kind)).toEqual([
      'registered',
      'registered',
    ]);
    expect(await database.all('select count(*) as count from participants')).toEqual([
      { count: 1 },
    ]);
  });

  it('coalesces later participant counts and throttles a completed post edit for one minute', async () => {
    const { database, gateway, service, advanceTime } = await openApplication();
    await database.execute(
      `insert into sync_tasks (
         id, giveaway_id, giveaway_channel_id, task_type, payload,
         status, attempts, available_at, created_at, updated_at
       ) values ('completed-counter', 'giveaway-1', 'channel-1',
                 'participant_count', '{"targetCount":0}', 'completed', 1,
                 ?, ?, ?)`,
      [NOW, NOW, NOW],
    );
    advanceTime(10_000);
    gateway.participantMemberships.set(900, { status: 'member' });
    gateway.participantMemberships.set(901, { status: 'member' });

    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 900, username: null, displayName: 'One' },
    });
    await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 901, username: null, displayName: 'Two' },
    });

    expect(
      await database.all(
        `select count(*) as count, status, payload, available_at
           from sync_tasks where task_type = 'participant_count'`,
      ),
    ).toEqual([
      {
        count: 1,
        status: 'pending',
        payload: '{"targetCount":2}',
        available_at: NOW + 60_000,
      },
    ]);
  });

  it('rejects unknown and expired entry tokens', async () => {
    const { database, service } = await openApplication();
    await database.execute(
      "update giveaways set deadline_utc = ? where id = 'giveaway-1'",
      [NOW],
    );

    await expect(
      service.joinWithToken({
        kind: 'join',
        token: 'unknown',
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(
      service.joinWithToken({
        kind: 'join',
        token: 'join-token',
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('referral registration', () => {
  it('assigns only the first valid inviter and returns a fresh link on each status view', async () => {
    const { database, gateway, service, advanceTime } = await openApplication({
      referralsEnabled: true,
    });
    gateway.participantMemberships.set(800, { status: 'member' });
    gateway.participantMemberships.set(801, { status: 'member' });
    gateway.participantMemberships.set(900, { status: 'member' });

    const inviterOne = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 800, username: 'one', displayName: 'One' },
    });
    const inviterTwo = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 801, username: 'two', displayName: 'Two' },
    });
    if (inviterOne.kind !== 'registered' || inviterTwo.kind !== 'registered') {
      throw new Error('Inviters were not registered');
    }
    advanceTime(1);

    const first = await service.joinWithToken({
      kind: 'referral',
      token: inviterOne.referralToken!,
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });
    const repeated = await service.joinWithToken({
      kind: 'referral',
      token: inviterTwo.referralToken!,
      user: { telegramUserId: 900, username: 'guest', displayName: 'Guest' },
    });

    expect(first).toMatchObject({ kind: 'registered', created: true });
    expect(repeated).toMatchObject({ kind: 'registered', created: false });
    expect(first.kind === 'registered' && repeated.kind === 'registered'
      ? first.referralToken === repeated.referralToken
      : true).toBe(false);
    expect(
      await database.all(
        `select inviter.telegram_user_id as inviterTelegramUserId
           from participants invited
           join participants inviter on inviter.id = invited.inviter_participant_id
          where invited.telegram_user_id = 900`,
      ),
    ).toEqual([{ inviterTelegramUserId: 800 }]);
  });

  it('does not create a self-referral for an already registered inviter', async () => {
    const { database, gateway, service } = await openApplication({
      referralsEnabled: true,
    });
    gateway.participantMemberships.set(800, { status: 'member' });
    const inviter = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 800, username: 'one', displayName: 'One' },
    });
    if (inviter.kind !== 'registered') throw new Error('Missing inviter');

    await expect(
      service.joinWithToken({
        kind: 'referral',
        token: inviter.referralToken!,
        user: { telegramUserId: 800, username: 'one', displayName: 'One' },
      }),
    ).resolves.toMatchObject({ kind: 'registered', created: false });
    expect(
      await database.all(
        'select inviter_participant_id from participants where telegram_user_id = 800',
      ),
    ).toEqual([{ inviter_participant_id: null }]);
  });

  it('rejects a cross-giveaway inviter candidate from a retry payload', async () => {
    const { database, gateway, service } = await openApplication({
      referralsEnabled: true,
    });
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('giveaway-2', 'Other', 'active', 1, ?, 1,
                 'text', 'Other conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into participants (
         id, giveaway_id, telegram_user_id, username, display_name,
         inviter_participant_id, joined_at, updated_at
       ) values ('other-inviter', 'giveaway-2', 800, 'other', 'Other', null, ?, ?)`,
      [NOW - 1, NOW - 1],
    );
    gateway.participantMemberships.set(900, { status: 'member' });

    await expect(
      service.recheck({
        giveawayId: 'giveaway-1',
        inviterParticipantId: 'other-inviter',
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(
      await database.all(
        "select id from participants where giveaway_id = 'giveaway-1'",
      ),
    ).toEqual([]);
  });

  it('rejects a referral if the program is disabled during membership checks', async () => {
    const { database, gateway, service, advanceTime } = await openApplication({
      referralsEnabled: true,
    });
    gateway.participantMemberships.set(800, { status: 'member' });
    gateway.participantMemberships.set(900, { status: 'member' });
    const inviter = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 800, username: 'one', displayName: 'One' },
    });
    if (inviter.kind !== 'registered') throw new Error('Missing inviter');
    advanceTime(1);
    gateway.afterParticipantCheck = async () => {
      await database.execute(
        "update giveaways set referrals_enabled = 0 where id = 'giveaway-1'",
      );
    };

    await expect(
      service.joinWithToken({
        kind: 'referral',
        token: inviter.referralToken!,
        user: { telegramUserId: 900, username: null, displayName: 'Guest' },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(
      await database.all(
        "select id from participants where telegram_user_id = 900",
      ),
    ).toEqual([]);
  });

  it('does not issue a new referral token after the giveaway closes', async () => {
    const { database, gateway, repository, service } = await openApplication({
      referralsEnabled: true,
    });
    gateway.participantMemberships.set(800, { status: 'member' });
    const participant = await service.joinWithToken({
      kind: 'join',
      token: 'join-token',
      user: { telegramUserId: 800, username: 'one', displayName: 'One' },
    });
    if (participant.kind !== 'registered') throw new Error('Missing participant');
    await database.execute(
      "update giveaways set state = 'cancelled' where id = 'giveaway-1'",
    );

    await expect(
      repository.storeReferralToken({
        tokenHash: hashToken('late-referral'),
        giveawayId: 'giveaway-1',
        inviterParticipantId: participant.participantId,
        now: NOW + 1,
      }),
    ).resolves.toBe(false);
    expect(
      await database.all('select count(*) as count from referral_tokens'),
    ).toEqual([{ count: 1 }]);
  });
});
