import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DraftWizardService } from '../../src/application/draft-wizard-service.js';
import { ChannelAuthorizationService } from '../../src/application/channel-authorization-service.js';
import { openDatabase } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function openTestApplication(databasePath?: string) {
  const directory = databasePath ? undefined : mkdtempSync(join(tmpdir(), 'gift-bot-wizard-'));
  const path = databasePath ?? join(directory!, 'gift-bot.sqlite');
  const opened = openDatabase(path);
  await migrateDatabase(opened.database);
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  const service = new DraftWizardService(repository, {
    createId: (() => {
      let sequence = 0;
      return (kind) => `${kind}-${++sequence}`;
    })(),
    now: () => Date.UTC(2026, 7, 8, 7, 0),
  });

  if (directory) {
    cleanups.push(async () => {
      await opened.close();
      rmSync(directory, { recursive: true, force: true });
    });
  }

  return { ...opened, path, repository, service };
}

describe('DraftWizardService', () => {
  it('resumes /new instead of creating a second active wizard for a team member', async () => {
    const { database, service } = await openTestApplication();

    const first = await service.startOrResume(101);
    const resumed = await service.startOrResume(101);

    expect(first.kind).toBe('created');
    expect(resumed).toEqual({ kind: 'resumed', wizard: first.wizard });
    expect(
      await database.all<{ count: number }>(
        "select count(*) as count from wizard_sessions where administrator_telegram_id = ? and status = 'active'",
        [101],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('restores persisted draft progress after the database is reopened', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gift-bot-wizard-restart-'));
    const databasePath = join(directory, 'gift-bot.sqlite');
    const firstProcess = await openTestApplication(databasePath);

    const started = await firstProcess.service.startOrResume(202);
    expect(started.wizard.step).toBe('title');
    await firstProcess.service.submitTitle(202, '  August giveaway  ');
    await firstProcess.close();

    const secondProcess = await openTestApplication(databasePath);
    cleanups.push(async () => {
      await secondProcess.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const resumed = await secondProcess.service.startOrResume(202);
    expect(resumed.kind).toBe('resumed');
    expect(resumed.wizard).toMatchObject({
      administratorTelegramId: 202,
      step: 'winner_count',
      draft: { title: 'August giveaway', referralsEnabled: false },
    });
  });

  it('persists the required step order and materializes a complete giveaway before channels', async () => {
    const { database, service } = await openTestApplication();
    await service.startOrResume(303);

    await expect(service.submitWinnerCount(303, 2)).rejects.toThrow(
      'Expected wizard step winner_count, current step is title',
    );

    await service.submitTitle(303, 'Team giveaway');
    await service.submitWinnerCount(303, 2);
    await service.submitDeadline(303, '10.08.2026 15:30');
    await service.submitReferrals(303, true);
    const wizard = await service.submitContent(303, {
      kind: 'text',
      text: 'Win a gift',
    });

    expect(wizard).toMatchObject({
      step: 'channels',
      giveawayId: 'giveaway-2',
      draft: {
        title: 'Team giveaway',
        winnerCount: 2,
        deadlineUtc: Date.UTC(2026, 7, 10, 10, 30),
        referralsEnabled: true,
        content: { kind: 'text', text: 'Win a gift' },
      },
    });
    expect(
      await database.all(
        `select title, state, winner_count, deadline_utc, referrals_enabled,
                content_kind, content_text, created_by_telegram_id
           from giveaways where id = ?`,
        ['giveaway-2'],
      ),
    ).toEqual([
      {
        title: 'Team giveaway',
        state: 'draft',
        winner_count: 2,
        deadline_utc: Date.UTC(2026, 7, 10, 10, 30),
        referrals_enabled: 1,
        content_kind: 'text',
        content_text: 'Win a gift',
        created_by_telegram_id: 303,
      },
    ]);
  });

  it('advances from channels to preview only after a channel is confirmed', async () => {
    const { repository, service } = await openTestApplication();
    await service.startOrResume(404);
    await service.submitTitle(404, 'Preview giveaway');
    await service.submitWinnerCount(404, 1);
    await service.submitDeadline(404, '10.08.2026 15:30');
    await service.submitReferrals(404, false);
    const channelsStep = await service.submitContent(404, {
      kind: 'text',
      text: 'Preview this',
    });

    await expect(service.continueToPreview(404)).rejects.toThrow(
      'At least one confirmed channel is required',
    );

    const channels = new ChannelAuthorizationService(repository, {
      createId: (kind) => `${kind}-preview`,
      now: () => Date.UTC(2026, 7, 8, 7, 0),
    });
    await channels.createOwnConnection({
      giveawayId: channelsStep.giveawayId!,
      telegramUserId: 404,
    });
    await channels.observeChannel({
      telegramUserId: 404,
      telegramChatId: -1404,
      username: 'preview_channel',
      title: 'Preview Channel',
      membership: {
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      },
    });
    await channels.confirmChannel({ telegramUserId: 404, telegramChatId: -1404 });

    const unconfirmed = await channels.createExternalInvite(
      channelsStep.giveawayId!,
    );
    await expect(service.continueToPreview(404)).rejects.toThrow(
      'All channel connections must be confirmed',
    );
    await channels.revokeExternalInvite(unconfirmed.id);

    expect(await service.continueToPreview(404)).toMatchObject({
      giveawayId: channelsStep.giveawayId,
      step: 'preview',
    });
  });

  it('expires an unopened old invite so a consumed replacement does not block preview', async () => {
    const { database, repository, service } = await openTestApplication();
    await service.startOrResume(405);
    await service.submitTitle(405, 'Replacement giveaway');
    await service.submitWinnerCount(405, 1);
    await service.submitDeadline(405, '10.08.2026 15:30');
    await service.submitReferrals(405, false);
    const wizard = await service.submitContent(405, {
      kind: 'text',
      text: 'Replacement content',
    });

    let sequence = 0;
    const channels = new ChannelAuthorizationService(repository, {
      createId: (kind) => `${kind}-replacement-${++sequence}`,
      now: () => Date.UTC(2026, 7, 8, 7, 0),
    });
    const expired = await channels.createExternalInvite(wizard.giveawayId!);
    await database.execute(
      'update channel_invites set expires_at = ? where id = ?',
      [Date.UTC(2026, 7, 8, 7, 0), expired.id],
    );
    const replacement = await channels.createExternalInvite(wizard.giveawayId!);
    await channels.openExternalInvite({
      token: replacement.token,
      telegramUserId: 805,
    });
    await channels.observeChannel({
      telegramUserId: 805,
      telegramChatId: -1405,
      username: 'replacement_channel',
      title: 'Replacement Channel',
      membership: {
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      },
    });
    await channels.confirmChannel({ telegramUserId: 805, telegramChatId: -1405 });

    expect(await service.continueToPreview(405)).toMatchObject({ step: 'preview' });
    expect(
      await database.all('select state from channel_invites where id = ?', [
        expired.id,
      ]),
    ).toEqual([{ state: 'expired' }]);
  });
});
