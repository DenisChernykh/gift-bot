import type {
  ParticipantEntryTarget,
  ParticipantRepository,
  ParticipantStatus,
} from '../application/ports/participant-repository.js';
import type {
  ChannelHealthAlertRepository,
  PendingChannelHealthAlert,
} from '../application/ports/channel-health-alert-repository.js';
import type { DatabaseBoundary } from './client.js';

type ParticipantRepositoryDependencies = {
  createId: (kind: 'participant' | 'sync_task' | 'channel_alert') => string;
};

const defaultDependencies: ParticipantRepositoryDependencies = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
};

type EntryRow = {
  giveawayId: string;
  title: string;
  deadlineUtc: number;
  referralsEnabled: number;
  createdByTelegramId: number;
  inviterParticipantId: string | null;
};

export class SqliteParticipantRepository
  implements ParticipantRepository, ChannelHealthAlertRepository
{
  readonly #database: DatabaseBoundary;
  readonly #dependencies: ParticipantRepositoryDependencies;

  constructor(
    database: DatabaseBoundary,
    dependencies: Partial<ParticipantRepositoryDependencies> = {},
  ) {
    this.#database = database;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async resolveEntryToken(input: {
    kind: 'join' | 'referral';
    tokenHash: string;
    now: number;
  }): Promise<ParticipantEntryTarget | null> {
    const rows =
      input.kind === 'join'
        ? await this.#database.all<EntryRow>(
            `select g.id as giveawayId, g.title, g.deadline_utc as deadlineUtc,
                    g.referrals_enabled as referralsEnabled,
                    g.created_by_telegram_id as createdByTelegramId,
                    null as inviterParticipantId
               from join_tokens t
               join giveaways g on g.id = t.giveaway_id
              where t.token_hash = ? and t.state = 'active'
                and g.state = 'active' and g.deadline_utc > ?`,
            [input.tokenHash, input.now],
          )
        : await this.#database.all<EntryRow>(
            `select g.id as giveawayId, g.title, g.deadline_utc as deadlineUtc,
                    g.referrals_enabled as referralsEnabled,
                    g.created_by_telegram_id as createdByTelegramId,
                    t.inviter_participant_id as inviterParticipantId
               from referral_tokens t
               join giveaways g on g.id = t.giveaway_id
               join participants p on p.id = t.inviter_participant_id
                                  and p.giveaway_id = t.giveaway_id
              where t.token_hash = ? and t.state = 'active'
                and g.state = 'active' and g.deadline_utc > ?
                and g.referrals_enabled = 1`,
            [input.tokenHash, input.now],
          );
    return rows[0] ? this.#hydrateTarget(this.#database, rows[0]) : null;
  }

  async findActiveEntryTarget(input: {
    giveawayId: string;
    inviterParticipantId: string | null;
    now: number;
  }): Promise<ParticipantEntryTarget | null> {
    const rows = input.inviterParticipantId
      ? await this.#database.all<EntryRow>(
          `select g.id as giveawayId, g.title,
                  g.deadline_utc as deadlineUtc,
                  g.referrals_enabled as referralsEnabled,
                  g.created_by_telegram_id as createdByTelegramId,
                  p.id as inviterParticipantId
             from giveaways g
             join participants p on p.id = ? and p.giveaway_id = g.id
            where g.id = ? and g.state = 'active' and g.deadline_utc > ?
              and g.referrals_enabled = 1 and p.joined_at < ?`,
          [
            input.inviterParticipantId,
            input.giveawayId,
            input.now,
            input.now,
          ],
        )
      : await this.#database.all<EntryRow>(
          `select id as giveawayId, title, deadline_utc as deadlineUtc,
                  referrals_enabled as referralsEnabled,
                  created_by_telegram_id as createdByTelegramId,
                  null as inviterParticipantId
             from giveaways
            where id = ? and state = 'active' and deadline_utc > ?`,
          [input.giveawayId, input.now],
        );
    return rows[0] ? this.#hydrateTarget(this.#database, rows[0]) : null;
  }

  findParticipant(giveawayId: string, telegramUserId: number) {
    return this.#findParticipant(this.#database, giveawayId, telegramUserId);
  }

  async registerParticipant(input: {
    giveawayId: string;
    telegramUserId: number;
    username: string | null;
    displayName: string;
    inviterParticipantId: string | null;
    now: number;
  }) {
    return this.#database.transaction(async (transaction) => {
      const giveaways = await transaction.all<{
        state: string;
        deadlineUtc: number;
        referralsEnabled: number;
      }>(
        `select state, deadline_utc as deadlineUtc,
                referrals_enabled as referralsEnabled
           from giveaways where id = ?`,
        [input.giveawayId],
      );
      const giveaway = giveaways[0];
      if (
        !giveaway ||
        giveaway.state !== 'active' ||
        giveaway.deadlineUtc <= input.now
      ) {
        return null;
      }

      const existing = await this.#findParticipant(
        transaction,
        input.giveawayId,
        input.telegramUserId,
      );
      if (existing) {
        await transaction.execute(
          `update participants set username = ?, display_name = ?, updated_at = ?
            where id = ?`,
          [input.username, input.displayName, input.now, existing.id],
        );
        const refreshed = await this.#findParticipant(
          transaction,
          input.giveawayId,
          input.telegramUserId,
        );
        return refreshed ? { ...refreshed, created: false } : null;
      }

      let inviterParticipantId: string | null = null;
      if (input.inviterParticipantId) {
        if (giveaway.referralsEnabled !== 1) return null;
        const inviters = await transaction.all<{ id: string }>(
          `select id from participants
            where id = ? and giveaway_id = ? and telegram_user_id <> ?
              and joined_at < ?`,
          [
            input.inviterParticipantId,
            input.giveawayId,
            input.telegramUserId,
            input.now,
          ],
        );
        const inviter = inviters[0];
        if (!inviter) return null;
        inviterParticipantId = inviter.id;
      }

      const participantId = this.#dependencies.createId('participant');
      await transaction.execute(
        `insert into participants (
           id, giveaway_id, telegram_user_id, username, display_name,
           inviter_participant_id, joined_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          participantId,
          input.giveawayId,
          input.telegramUserId,
          input.username,
          input.displayName,
          inviterParticipantId,
          input.now,
          input.now,
        ],
      );
      const [{ count: participantCount } = { count: 0 }] =
        await transaction.all<{ count: number }>(
          'select count(*) as count from participants where giveaway_id = ?',
          [input.giveawayId],
        );
      const deliveries = await transaction.all<{ giveawayChannelId: string }>(
        `select d.giveaway_channel_id as giveawayChannelId
           from publication_deliveries d
           join publication_runs r on r.id = d.publication_run_id
          where r.giveaway_id = ? and r.status = 'succeeded'
            and d.status = 'delivered' and d.message_id is not null
          order by d.created_at, d.id`,
        [input.giveawayId],
      );
      for (const delivery of deliveries) {
        await transaction.execute(
          `insert into sync_tasks (
             id, giveaway_id, giveaway_channel_id, task_type, payload,
             status, attempts, available_at, last_error_kind, created_at, updated_at
           ) values (?, ?, ?, 'participant_count', ?, 'pending', 0, ?, null, ?, ?)
           on conflict (giveaway_id, giveaway_channel_id)
             where task_type = 'participant_count'
           do update set
             payload = excluded.payload,
             status = 'pending',
             available_at = case
               when sync_tasks.status = 'completed'
                 then max(sync_tasks.updated_at + 60000, excluded.available_at)
               else sync_tasks.available_at
             end,
             last_error_kind = null,
             updated_at = excluded.updated_at`,
          [
            this.#dependencies.createId('sync_task'),
            input.giveawayId,
            delivery.giveawayChannelId,
            JSON.stringify({ targetCount: participantCount }),
            input.now,
            input.now,
            input.now,
          ],
        );
      }
      const created = await this.#findParticipant(
        transaction,
        input.giveawayId,
        input.telegramUserId,
      );
      return created ? { ...created, created: true } : null;
    });
  }

  async storeReferralToken(input: {
    tokenHash: string;
    giveawayId: string;
    inviterParticipantId: string;
    now: number;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const targets = await transaction.all<{ participantId: string }>(
        `select p.id as participantId
           from giveaways g
           join participants p on p.giveaway_id = g.id and p.id = ?
          where g.id = ? and g.state = 'active' and g.deadline_utc > ?
            and g.referrals_enabled = 1 and p.joined_at <= ?`,
        [
          input.inviterParticipantId,
          input.giveawayId,
          input.now,
          input.now,
        ],
      );
      if (!targets[0]) return false;

      await transaction.execute(
        `insert into referral_tokens (
           token_hash, giveaway_id, inviter_participant_id, state, created_at
         ) values (?, ?, ?, 'active', ?)`,
        [
          input.tokenHash,
          input.giveawayId,
          input.inviterParticipantId,
          input.now,
        ],
      );
      return true;
    });
  }

  async recordBotRightsLoss(input: {
    giveawayId: string;
    giveawayChannelId: string;
    now: number;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const alerts = await transaction.all<{ id: string }>(
        `select id from channel_health_alerts
          where giveaway_id = ? and giveaway_channel_id = ?
            and kind = 'bot_admin_rights_lost' and state = 'active'`,
        [input.giveawayId, input.giveawayChannelId],
      );
      if (alerts[0]) {
        await transaction.execute(
          'update channel_health_alerts set last_detected_at = ? where id = ?',
          [input.now, alerts[0].id],
        );
        return;
      }
      await transaction.execute(
        `insert into channel_health_alerts (
           id, giveaway_id, giveaway_channel_id, kind, state,
           first_detected_at, last_detected_at, notified_at, resolved_at
         ) values (?, ?, ?, 'bot_admin_rights_lost', 'active', ?, ?, null, null)`,
        [
          this.#dependencies.createId('channel_alert'),
          input.giveawayId,
          input.giveawayChannelId,
          input.now,
          input.now,
        ],
      );
    });
  }

  async resolveBotRightsLoss(input: {
    giveawayId: string;
    giveawayChannelId: string;
    now: number;
  }): Promise<void> {
    await this.#database.execute(
      `update channel_health_alerts
          set state = 'resolved', resolved_at = ?, last_detected_at = ?
        where giveaway_id = ? and giveaway_channel_id = ?
          and kind = 'bot_admin_rights_lost' and state = 'active'`,
      [input.now, input.now, input.giveawayId, input.giveawayChannelId],
    );
  }

  listPendingBotRightsAlerts(): Promise<PendingChannelHealthAlert[]> {
    return this.#database.all<PendingChannelHealthAlert>(
      `select a.id, a.giveaway_id as giveawayId, g.title as giveawayTitle,
              c.username as channelUsername, c.title as channelTitle,
              g.created_by_telegram_id as createdByTelegramId
         from channel_health_alerts a
         join giveaways g on g.id = a.giveaway_id
         join giveaway_channels c on c.id = a.giveaway_channel_id
        where a.kind = 'bot_admin_rights_lost'
          and a.state = 'active' and a.notified_at is null
        order by a.first_detected_at, a.id`,
    );
  }

  async markBotRightsAlertNotified(
    id: string,
    notifiedAt: number,
  ): Promise<void> {
    await this.#database.execute(
      `update channel_health_alerts set notified_at = ?
        where id = ? and state = 'active' and notified_at is null`,
      [notifiedAt, id],
    );
  }

  async #hydrateTarget(
    boundary: DatabaseBoundary,
    row: EntryRow,
  ): Promise<ParticipantEntryTarget> {
    const channels = await boundary.all<ParticipantEntryTarget['channels'][number]>(
      `select id, telegram_chat_id as telegramChatId, username, title
         from giveaway_channels
        where giveaway_id = ? and status = 'confirmed'
        order by created_at, id`,
      [row.giveawayId],
    );
    return {
      giveawayId: row.giveawayId,
      title: row.title,
      deadlineUtc: row.deadlineUtc,
      referralsEnabled: row.referralsEnabled === 1,
      createdByTelegramId: row.createdByTelegramId,
      inviterParticipantId: row.inviterParticipantId,
      channels,
    };
  }

  async #findParticipant(
    boundary: DatabaseBoundary,
    giveawayId: string,
    telegramUserId: number,
  ): Promise<ParticipantStatus | null> {
    const rows = await boundary.all<Omit<ParticipantStatus, 'participantCount' | 'directReferralCount'>>(
      `select id, giveaway_id as giveawayId,
              telegram_user_id as telegramUserId, username,
              display_name as displayName,
              inviter_participant_id as inviterParticipantId,
              joined_at as joinedAt
         from participants
        where giveaway_id = ? and telegram_user_id = ?`,
      [giveawayId, telegramUserId],
    );
    const row = rows[0];
    if (!row) return null;
    const [participantCounts, referralCounts] = await Promise.all([
      boundary.all<{ count: number }>(
        'select count(*) as count from participants where giveaway_id = ?',
        [giveawayId],
      ),
      boundary.all<{ count: number }>(
        `select count(*) as count from participants
          where giveaway_id = ? and inviter_participant_id = ?`,
        [giveawayId, row.id],
      ),
    ]);
    return {
      ...row,
      participantCount: participantCounts[0]?.count ?? 0,
      directReferralCount: referralCounts[0]?.count ?? 0,
    };
  }
}
