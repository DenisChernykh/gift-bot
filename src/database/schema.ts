import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const giveaways = sqliteTable('giveaways', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  winnerCount: integer('winner_count').notNull(),
  deadlineUtc: integer('deadline_utc').notNull(),
  referralsEnabled: integer('referrals_enabled', { mode: 'boolean' }).notNull(),
  contentKind: text('content_kind').notNull(),
  contentText: text('content_text').notNull(),
  createdByTelegramId: integer('created_by_telegram_id').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const wizardSessions = sqliteTable(
  'wizard_sessions',
  {
    id: text('id').primaryKey(),
    administratorTelegramId: integer('administrator_telegram_id').notNull(),
    giveawayId: text('giveaway_id').references(() => giveaways.id),
    step: text('step').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('wizard_sessions_administrator_status_unique').on(
      table.administratorTelegramId,
      table.status,
    ),
  ],
);

export const giveawayChannels = sqliteTable(
  'giveaway_channels',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    telegramChatId: integer('telegram_chat_id').notNull(),
    username: text('username').notNull(),
    title: text('title').notNull(),
    ownerTelegramId: integer('owner_telegram_id').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('giveaway_channels_giveaway_chat_unique').on(
      table.giveawayId,
      table.telegramChatId,
    ),
  ],
);

export const channelInvites = sqliteTable(
  'channel_invites',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    tokenHash: text('token_hash').notNull(),
    invitedTelegramId: integer('invited_telegram_id'),
    state: text('state').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('channel_invites_token_hash_unique').on(table.tokenHash)],
);

export const pendingChannelConnections = sqliteTable(
  'pending_channel_connections',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    inviteId: text('invite_id').references(() => channelInvites.id),
    telegramUserId: integer('telegram_user_id').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('pending_channel_connections_user_status_index').on(table.telegramUserId, table.status)],
);

export const callbackActions = sqliteTable(
  'callback_actions',
  {
    tokenHash: text('token_hash').primaryKey(),
    giveawayId: text('giveaway_id').references(() => giveaways.id),
    actorTelegramId: integer('actor_telegram_id'),
    action: text('action').notNull(),
    payload: text('payload').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('callback_actions_expiry_index').on(table.expiresAt)],
);

export const joinTokens = sqliteTable(
  'join_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    state: text('state').notNull(),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('join_tokens_giveaway_index').on(table.giveawayId)],
);

export const publicationRuns = sqliteTable(
  'publication_runs',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [index('publication_runs_giveaway_index').on(table.giveawayId)],
);

export const publicationDeliveries = sqliteTable(
  'publication_deliveries',
  {
    id: text('id').primaryKey(),
    publicationRunId: text('publication_run_id')
      .notNull()
      .references(() => publicationRuns.id),
    giveawayChannelId: text('giveaway_channel_id')
      .notNull()
      .references(() => giveawayChannels.id),
    status: text('status').notNull(),
    messageId: integer('message_id'),
    messageKind: text('message_kind'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('publication_deliveries_run_channel_unique').on(
      table.publicationRunId,
      table.giveawayChannelId,
    ),
  ],
);

export const syncTasks = sqliteTable(
  'sync_tasks',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    giveawayChannelId: text('giveaway_channel_id').references(() => giveawayChannels.id),
    taskType: text('task_type').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('sync_tasks_status_index').on(table.status, table.createdAt)],
);
