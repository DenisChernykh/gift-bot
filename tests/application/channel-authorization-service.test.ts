import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelAuthorizationService } from '../../src/application/channel-authorization-service.js';
import { openDatabase } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { hashToken } from '../../src/domain/tokens.js';

const NOW = Date.UTC(2026, 7, 8, 7, 0);
const FULL_RIGHTS = {
  status: 'administrator',
  canPostMessages: true,
  canEditMessages: true,
  canDeleteMessages: true,
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function openTestService() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-channel-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  for (const id of ['giveaway-1', 'giveaway-2']) {
    await opened.database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values (?, ?, 'draft', 1, ?, 0, 'text', 'Content', 700, ?, ?)`,
      [id, id, NOW + 86_400_000, NOW, NOW],
    );
  }

  let now = NOW;
  let sequence = 0;
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  const service = new ChannelAuthorizationService(repository, {
    createId: (kind) => `${kind}-${++sequence}`,
    now: () => now,
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { ...opened, service, setNow: (value: number) => (now = value) };
}

describe('ChannelAuthorizationService pending context', () => {
  it('creates an own-channel context for the team member without an external token', async () => {
    const { database, service } = await openTestService();

    const result = await service.createOwnConnection({
      giveawayId: 'giveaway-1',
      telegramUserId: 700,
    });

    expect(result).toMatchObject({
      kind: 'ready',
      context: {
        giveawayId: 'giveaway-1',
        telegramUserId: 700,
        inviteId: null,
        status: 'active',
      },
    });
    expect(
      await database.all('select invite_id, status from pending_channel_connections'),
    ).toEqual([{ invite_id: null, status: 'active' }]);
  });

  it('requires explicit confirmation to switch invitations without revoking the old invite', async () => {
    const { database, service } = await openTestService();
    const first = await service.createExternalInvite('giveaway-1');
    const second = await service.createExternalInvite('giveaway-2');

    await service.openExternalInvite({ token: first.token, telegramUserId: 801 });
    const confirmation = await service.openExternalInvite({
      token: second.token,
      telegramUserId: 801,
    });

    expect(confirmation).toMatchObject({
      kind: 'switch_confirmation_required',
      current: { giveawayId: 'giveaway-1' },
      requested: { giveawayId: 'giveaway-2' },
    });
    expect(
      await database.all(
        'select giveaway_id, state from channel_invites order by giveaway_id',
      ),
    ).toEqual([
      { giveaway_id: 'giveaway-1', state: 'active' },
      { giveaway_id: 'giveaway-2', state: 'active' },
    ]);
    expect(
      await database.all(
        "select giveaway_id from pending_channel_connections where telegram_user_id = 801 and status = 'active'",
      ),
    ).toEqual([{ giveaway_id: 'giveaway-1' }]);

    const switched = await service.openExternalInvite({
      token: second.token,
      telegramUserId: 801,
      confirmSwitch: true,
    });
    expect(switched).toMatchObject({
      kind: 'ready',
      context: { giveawayId: 'giveaway-2', status: 'active' },
    });
    expect(
      await database.all(
        'select giveaway_id, status from pending_channel_connections where telegram_user_id = 801 order by created_at, id',
      ),
    ).toEqual([
      { giveaway_id: 'giveaway-1', status: 'superseded' },
      { giveaway_id: 'giveaway-2', status: 'active' },
    ]);
  });
});

describe('ChannelAuthorizationService invitation lifecycle', () => {
  it('stores a 32-byte invitation as SHA-256 only and expires it after 24 hours', async () => {
    const { database, service, setNow } = await openTestService();
    const invite = await service.createExternalInvite('giveaway-1');

    expect(invite).toMatchObject({ state: 'active', expiresAt: NOW + 86_400_000 });
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await database.all(
        'select token_hash, state, expires_at from channel_invites where id = ?',
        [invite.id],
      ),
    ).toEqual([
      {
        token_hash: hashToken(invite.token),
        state: 'active',
        expires_at: NOW + 86_400_000,
      },
    ]);

    setNow(NOW + 86_400_000);
    await expect(
      service.openExternalInvite({ token: invite.token, telegramUserId: 802 }),
    ).rejects.toThrow('Channel invitation has expired');
    expect(
      await database.all('select state from channel_invites where id = ?', [invite.id]),
    ).toEqual([{ state: 'expired' }]);
  });

  it('revokes an active invitation and prevents it from opening', async () => {
    const { database, service } = await openTestService();
    const invite = await service.createExternalInvite('giveaway-1');

    expect(await service.revokeExternalInvite(invite.id)).toMatchObject({
      id: invite.id,
      state: 'revoked',
      revokedAt: NOW,
    });
    await expect(
      service.openExternalInvite({ token: invite.token, telegramUserId: 803 }),
    ).rejects.toThrow('Channel invitation is revoked');
    expect(
      await database.all('select state, revoked_at from channel_invites where id = ?', [
        invite.id,
      ]),
    ).toEqual([{ state: 'revoked', revoked_at: NOW }]);
  });
});

describe('ChannelAuthorizationService channel confirmation', () => {
  it('requires a public username, full bot rights, and the pending actor', async () => {
    const { service } = await openTestService();
    await service.createOwnConnection({
      giveawayId: 'giveaway-1',
      telegramUserId: 700,
    });

    await expect(
      service.observeChannel({
        telegramUserId: 700,
        telegramChatId: -1001,
        username: null,
        title: 'Private channel',
        membership: FULL_RIGHTS,
      }),
    ).rejects.toThrow('Channel must have a public username');
    await expect(
      service.observeChannel({
        telegramUserId: 700,
        telegramChatId: -1001,
        username: 'public_channel',
        title: 'Public channel',
        membership: { ...FULL_RIGHTS, canDeleteMessages: false },
      }),
    ).rejects.toThrow('Bot requires post, edit, and delete administrator rights');
    await expect(
      service.observeChannel({
        telegramUserId: 999,
        telegramChatId: -1001,
        username: 'public_channel',
        title: 'Public channel',
        membership: FULL_RIGHTS,
      }),
    ).rejects.toThrow('No active channel connection for this user');
  });

  it('persists the candidate, consumes an external invite on confirmation, and is idempotent', async () => {
    const { database, service } = await openTestService();
    const invite = await service.createExternalInvite('giveaway-1');
    await service.openExternalInvite({ token: invite.token, telegramUserId: 804 });

    const candidate = await service.observeChannel({
      telegramUserId: 804,
      telegramChatId: -1002,
      username: '@Gift_Public',
      title: 'Gift Public',
      membership: FULL_RIGHTS,
    });
    expect(candidate).toMatchObject({
      kind: 'candidate_ready',
      candidate: {
        telegramChatId: -1002,
        username: 'gift_public',
        title: 'Gift Public',
      },
    });

    const connected = await service.confirmChannel({
      telegramUserId: 804,
      telegramChatId: -1002,
    });
    expect(connected).toMatchObject({
      kind: 'connected',
      channel: {
        giveawayId: 'giveaway-1',
        telegramChatId: -1002,
        ownerTelegramId: 804,
        status: 'confirmed',
      },
    });
    expect(await service.confirmChannel({ telegramUserId: 804, telegramChatId: -1002 })).toMatchObject({
      kind: 'already_connected',
      channel: { telegramChatId: -1002 },
    });
    expect(
      await database.all('select state, consumed_at from channel_invites where id = ?', [
        invite.id,
      ]),
    ).toEqual([{ state: 'consumed', consumed_at: NOW }]);
  });

  it('rejects the same channel twice within one giveaway', async () => {
    const { service } = await openTestService();
    await service.createOwnConnection({ giveawayId: 'giveaway-1', telegramUserId: 700 });
    await service.observeChannel({
      telegramUserId: 700,
      telegramChatId: -1003,
      username: 'one',
      title: 'One',
      membership: FULL_RIGHTS,
    });
    await service.confirmChannel({ telegramUserId: 700, telegramChatId: -1003 });

    await service.createOwnConnection({ giveawayId: 'giveaway-1', telegramUserId: 701 });
    await service.observeChannel({
      telegramUserId: 701,
      telegramChatId: -1003,
      username: 'one',
      title: 'One',
      membership: FULL_RIGHTS,
    });
    await expect(
      service.confirmChannel({ telegramUserId: 701, telegramChatId: -1003 }),
    ).rejects.toThrow('Channel is already connected to this giveaway');
  });
});
