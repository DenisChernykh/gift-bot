import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const giveaways = sqliteTable('giveaways', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  winnerCount: integer('winner_count').notNull(),
  deadlineUtc: integer('deadline_utc').notNull(),
  referralsEnabled: integer('referrals_enabled', { mode: 'boolean' }).notNull(),
  contentKind: text('content_kind').notNull(),
  contentText: text('content_text').notNull(),
  contentFileId: text('content_file_id'),
  contentEntities: text('content_entities').notNull().default('[]'),
  failureRunId: text('failure_run_id'),
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
    draftData: text('draft_data').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('wizard_sessions_administrator_active_unique')
      .on(table.administratorTelegramId)
      .where(sql`${table.status} = 'active'`),
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
    candidateTelegramChatId: integer('candidate_telegram_chat_id'),
    candidateUsername: text('candidate_username'),
    candidateTitle: text('candidate_title'),
    rightsVerifiedAt: integer('rights_verified_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('pending_channel_connections_user_status_index').on(
      table.telegramUserId,
      table.status,
    ),
    uniqueIndex('pending_channel_connections_user_active_unique')
      .on(table.telegramUserId)
      .where(sql`${table.status} = 'active'`),
  ],
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

export const participants = sqliteTable(
  'participants',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    telegramUserId: integer('telegram_user_id').notNull(),
    username: text('username'),
    displayName: text('display_name').notNull(),
    inviterParticipantId: text('inviter_participant_id'),
    joinedAt: integer('joined_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('participants_giveaway_user_unique').on(
      table.giveawayId,
      table.telegramUserId,
    ),
    uniqueIndex('participants_id_giveaway_unique').on(
      table.id,
      table.giveawayId,
    ),
    index('participants_giveaway_inviter_index').on(
      table.giveawayId,
      table.inviterParticipantId,
    ),
    foreignKey({
      columns: [table.inviterParticipantId, table.giveawayId],
      foreignColumns: [table.id, table.giveawayId],
      name: 'participants_inviter_same_giveaway_fk',
    }),
  ],
);

export const referralTokens = sqliteTable(
  'referral_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    inviterParticipantId: text('inviter_participant_id').notNull(),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('referral_tokens_giveaway_inviter_index').on(
      table.giveawayId,
      table.inviterParticipantId,
    ),
    foreignKey({
      columns: [table.inviterParticipantId, table.giveawayId],
      foreignColumns: [participants.id, participants.giveawayId],
      name: 'referral_tokens_inviter_same_giveaway_fk',
    }),
  ],
);

export const channelHealthAlerts = sqliteTable(
  'channel_health_alerts',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    giveawayChannelId: text('giveaway_channel_id')
      .notNull()
      .references(() => giveawayChannels.id),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    firstDetectedAt: integer('first_detected_at').notNull(),
    lastDetectedAt: integer('last_detected_at').notNull(),
    notifiedAt: integer('notified_at'),
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    uniqueIndex('channel_health_alerts_active_unique')
      .on(table.giveawayId, table.giveawayChannelId, table.kind)
      .where(sql`${table.state} = 'active'`),
    index('channel_health_alerts_pending_notification_index').on(
      table.state,
      table.notifiedAt,
    ),
  ],
);

export const publicationRuns = sqliteTable(
  'publication_runs',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
  status: text('status').notNull(),
  failureStage: text('failure_stage'),
  failureErrorKind: text('failure_error_kind'),
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
    availableAt: integer('available_at').notNull().default(0),
    lastErrorKind: text('last_error_kind'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('sync_tasks_status_index').on(table.status, table.availableAt),
    uniqueIndex('sync_tasks_participant_count_unique')
      .on(table.giveawayId, table.giveawayChannelId)
      .where(sql`${table.taskType} = 'participant_count'`),
    uniqueIndex('sync_tasks_result_unique')
      .on(table.giveawayId, table.giveawayChannelId)
      .where(sql`${table.taskType} = 'result'`),
  ],
);

export const drawRuns = sqliteTable(
  'draw_runs',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    snapshotVersion: integer('snapshot_version'),
    snapshotJson: text('snapshot_json'),
    cursor: integer('cursor').notNull().default(0),
    resultRevision: integer('result_revision').notNull().default(0),
    failureStage: text('failure_stage'),
    failureErrorKind: text('failure_error_kind'),
    startedAt: integer('started_at').notNull(),
    snapshotCreatedAt: integer('snapshot_created_at'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('draw_runs_giveaway_unique').on(table.giveawayId),
    index('draw_runs_failure_index').on(table.failureStage, table.updatedAt),
  ],
);

export const prizePlaceVersions = sqliteTable(
  'prize_place_versions',
  {
    id: text('id').primaryKey(),
    drawRunId: text('draw_run_id')
      .notNull()
      .references(() => drawRuns.id),
    placeNumber: integer('place_number').notNull(),
    version: integer('version').notNull(),
    state: text('state').notNull(),
    participantId: text('participant_id'),
    createdAt: integer('created_at').notNull(),
    rejectedAt: integer('rejected_at'),
  },
  (table) => [
    uniqueIndex('prize_place_versions_run_place_version_unique').on(
      table.drawRunId,
      table.placeNumber,
      table.version,
    ),
    uniqueIndex('prize_place_versions_active_unique')
      .on(table.drawRunId, table.placeNumber)
      .where(sql`${table.state} in ('selected', 'empty')`),
  ],
);

export const rerollOperations = sqliteTable(
  'reroll_operations',
  {
    id: text('id').primaryKey(),
    drawRunId: text('draw_run_id')
      .notNull()
      .references(() => drawRuns.id),
    placeNumber: integer('place_number').notNull(),
    operatorTelegramId: integer('operator_telegram_id').notNull(),
    reason: text('reason').notNull(),
    previousParticipantId: text('previous_participant_id').notNull(),
    newParticipantId: text('new_participant_id'),
    skippedCandidates: text('skipped_candidates').notNull().default('[]'),
    status: text('status').notNull(),
    cursorBefore: integer('cursor_before').notNull(),
    cursorAfter: integer('cursor_after').notNull(),
    resultRevision: integer('result_revision'),
    syncStatus: text('sync_status').notNull().default('pending'),
    notificationStatus: text('notification_status').notNull().default('pending'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('reroll_operations_draw_index').on(
      table.drawRunId,
      table.startedAt,
    ),
  ],
);

export const drawExclusions = sqliteTable(
  'draw_exclusions',
  {
    drawRunId: text('draw_run_id')
      .notNull()
      .references(() => drawRuns.id),
    participantId: text('participant_id').notNull(),
    reason: text('reason').notNull(),
    rerollOperationId: text('reroll_operation_id').references(
      () => rerollOperations.id,
    ),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('draw_exclusions_run_participant_unique').on(
      table.drawRunId,
      table.participantId,
    ),
  ],
);

export const rerollSessions = sqliteTable(
  'reroll_sessions',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    operatorTelegramId: integer('operator_telegram_id').notNull(),
    placeNumber: integer('place_number').notNull(),
    state: text('state').notNull(),
    reason: text('reason'),
    operationId: text('operation_id').references(() => rerollOperations.id),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('reroll_sessions_operator_active_unique')
      .on(table.operatorTelegramId)
      .where(sql`${table.state} in ('awaiting_reason', 'awaiting_confirmation')`),
  ],
);

export const drawNotifications = sqliteTable(
  'draw_notifications',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    drawRunId: text('draw_run_id')
      .notNull()
      .references(() => drawRuns.id),
    rerollOperationId: text('reroll_operation_id').references(
      () => rerollOperations.id,
    ),
    recipientTelegramId: integer('recipient_telegram_id').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: integer('available_at').notNull().default(0),
    lastErrorKind: text('last_error_kind'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('draw_notifications_due_index').on(
      table.status,
      table.availableAt,
    ),
  ],
);
