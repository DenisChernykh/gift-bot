import type { DatabaseBoundary } from './client.js';
import type {
  CallbackActionRepository,
  StoredCallbackAction,
} from '../application/ports/callback-action-repository.js';
import type {
  ChannelAuthorizationRepository,
  ChannelCandidate,
  ChannelInvitation,
  ConfirmedGiveawayChannel,
  PendingChannelConnection,
  PendingConnectionResult,
} from '../application/ports/channel-authorization-repository.js';
import type {
  ActiveWizard,
  GiveawayCreationRepository,
  GiveawayDraft,
  StartWizardResult,
  WizardStep,
} from '../application/ports/giveaway-creation-repository.js';

type WizardRow = {
  id: string;
  administratorTelegramId: number;
  giveawayId: string | null;
  step: WizardStep;
  status: 'active';
  draftData: string;
  createdAt: number;
  updatedAt: number;
};

export class SqliteGiveawayCreationRepository
  implements
    GiveawayCreationRepository,
    CallbackActionRepository,
    ChannelAuthorizationRepository
{
  readonly #database: DatabaseBoundary;

  constructor(database: DatabaseBoundary) {
    this.#database = database;
  }

  async startOrResumeWizard(input: {
    id: string;
    administratorTelegramId: number;
    now: number;
  }): Promise<StartWizardResult> {
    return this.#database.transaction(async (transaction) => {
      const active = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (active) {
        return { kind: 'resumed', wizard: active };
      }

      const draft: GiveawayDraft = { referralsEnabled: false };
      await transaction.execute(
        `insert into wizard_sessions (
           id, administrator_telegram_id, giveaway_id, step, status,
           draft_data, created_at, updated_at
         ) values (?, ?, null, 'title', 'active', ?, ?, ?)`,
        [
          input.id,
          input.administratorTelegramId,
          JSON.stringify(draft),
          input.now,
          input.now,
        ],
      );

      const wizard = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (!wizard) {
        throw new Error('Failed to persist active wizard');
      }
      return { kind: 'created', wizard };
    });
  }

  async advanceWizard(input: {
    administratorTelegramId: number;
    expectedStep: WizardStep;
    nextStep: WizardStep;
    draftPatch: Partial<GiveawayDraft>;
    now: number;
    materializeGiveawayId?: string;
  }): Promise<ActiveWizard> {
    return this.#database.transaction(async (transaction) => {
      const wizard = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (!wizard) {
        throw new Error('No active wizard for administrator');
      }
      if (wizard.step !== input.expectedStep) {
        throw new Error(
          `Expected wizard step ${input.expectedStep}, current step is ${wizard.step}`,
        );
      }

      const draft = { ...wizard.draft, ...input.draftPatch };
      let giveawayId = wizard.giveawayId;
      if (input.materializeGiveawayId) {
        const complete = this.#completeGiveaway(
          input.materializeGiveawayId,
          draft,
        );
        giveawayId = complete.id;
        await transaction.execute(
          `insert into giveaways (
             id, title, state, winner_count, deadline_utc, referrals_enabled,
             content_kind, content_text, created_by_telegram_id, created_at, updated_at
           ) values (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            complete.id,
            complete.title,
            complete.winnerCount,
            complete.deadlineUtc,
            complete.referralsEnabled ? 1 : 0,
            complete.content.kind,
            complete.content.kind === 'text'
              ? complete.content.text
              : complete.content.caption,
            input.administratorTelegramId,
            input.now,
            input.now,
          ],
        );
      }

      await transaction.execute(
        `update wizard_sessions
            set giveaway_id = ?, step = ?, draft_data = ?, updated_at = ?
          where id = ?`,
        [
          giveawayId ?? null,
          input.nextStep,
          JSON.stringify(draft),
          input.now,
          wizard.id,
        ],
      );

      const updated = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (!updated) {
        throw new Error('Failed to persist wizard progress');
      }
      return updated;
    });
  }

  async advanceWizardToPreview(input: {
    administratorTelegramId: number;
    now: number;
  }): Promise<ActiveWizard> {
    return this.#database.transaction(async (transaction) => {
      const wizard = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (!wizard) {
        throw new Error('No active wizard for administrator');
      }
      if (wizard.step !== 'channels') {
        throw new Error(
          `Expected wizard step channels, current step is ${wizard.step}`,
        );
      }
      if (!wizard.giveawayId) {
        throw new Error('Wizard has no materialized giveaway');
      }

      await this.#expireInvitesForGiveaway(
        transaction,
        wizard.giveawayId,
        input.now,
      );

      const [{ count } = { count: 0 }] = await transaction.all<{ count: number }>(
        "select count(*) as count from giveaway_channels where giveaway_id = ? and status = 'confirmed'",
        [wizard.giveawayId],
      );
      if (count === 0) {
        throw new Error('At least one confirmed channel is required');
      }
      const [{ count: pendingCount } = { count: 0 }] = await transaction.all<{
        count: number;
      }>(
        `select (
           (select count(*) from pending_channel_connections
             where giveaway_id = ? and status = 'active') +
           (select count(*) from channel_invites
             where giveaway_id = ? and state = 'active')
         ) as count`,
        [wizard.giveawayId, wizard.giveawayId],
      );
      if (pendingCount > 0) {
        throw new Error('All channel connections must be confirmed');
      }

      await transaction.execute(
        "update wizard_sessions set step = 'preview', updated_at = ? where id = ?",
        [input.now, wizard.id],
      );
      const updated = await this.#findActiveWizard(
        transaction,
        input.administratorTelegramId,
      );
      if (!updated) {
        throw new Error('Failed to persist preview step');
      }
      return updated;
    });
  }

  async storeCallbackAction(
    input: StoredCallbackAction & { tokenHash: string; createdAt: number },
  ): Promise<void> {
    await this.#database.execute(
      `insert into callback_actions (
         token_hash, giveaway_id, actor_telegram_id, action, payload,
         expires_at, consumed_at, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.tokenHash,
        input.giveawayId,
        input.actorTelegramId,
        input.action,
        JSON.stringify(input.payload),
        input.expiresAt,
        input.consumedAt,
        input.createdAt,
      ],
    );
  }

  async consumeCallbackAction(input: {
    tokenHash: string;
    actorTelegramId: number;
    now: number;
  }): Promise<StoredCallbackAction & { alreadyConsumed: boolean }> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.all<{
        actorTelegramId: number;
        giveawayId: string | null;
        action: string;
        payload: string;
        expiresAt: number;
        consumedAt: number | null;
      }>(
        `select actor_telegram_id as actorTelegramId,
                giveaway_id as giveawayId,
                action,
                payload,
                expires_at as expiresAt,
                consumed_at as consumedAt
           from callback_actions where token_hash = ?`,
        [input.tokenHash],
      );
      const row = rows[0];
      if (!row) {
        throw new Error('Unknown callback action');
      }
      if (row.actorTelegramId !== input.actorTelegramId) {
        throw new Error('Callback action does not belong to this actor');
      }
      const alreadyConsumed = row.consumedAt !== null;
      if (!alreadyConsumed && row.expiresAt <= input.now) {
        throw new Error('Callback action has expired');
      }

      if (!alreadyConsumed) {
        await transaction.execute(
          'update callback_actions set consumed_at = ? where token_hash = ?',
          [input.now, input.tokenHash],
        );
      }

      return {
        actorTelegramId: row.actorTelegramId,
        giveawayId: row.giveawayId,
        action: row.action,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt ?? input.now,
        alreadyConsumed,
      };
    });
  }

  async createExternalInvite(input: {
    id: string;
    giveawayId: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
  }): Promise<ChannelInvitation> {
    await this.#database.execute(
      `insert into channel_invites (
         id, giveaway_id, token_hash, invited_telegram_id, state,
         expires_at, consumed_at, revoked_at, created_at
       ) values (?, ?, ?, null, 'active', ?, null, null, ?)`,
      [input.id, input.giveawayId, input.tokenHash, input.expiresAt, input.now],
    );
    const invite = await this.#findInviteById(this.#database, input.id);
    if (!invite) {
      throw new Error('Failed to persist channel invitation');
    }
    return invite;
  }

  async createOwnConnection(input: {
    id: string;
    giveawayId: string;
    telegramUserId: number;
    confirmSwitch: boolean;
    now: number;
  }): Promise<PendingConnectionResult> {
    return this.#database.transaction(async (transaction) => {
      const current = await this.#findActiveConnection(
        transaction,
        input.telegramUserId,
      );
      if (
        current?.giveawayId === input.giveawayId &&
        current.inviteId === null
      ) {
        return { kind: 'ready', context: current };
      }
      if (current && !input.confirmSwitch) {
        return {
          kind: 'switch_confirmation_required',
          current,
          requested: { giveawayId: input.giveawayId, inviteId: null },
        };
      }
      if (current) {
        await this.#supersedeConnection(transaction, current.id, input.now);
      }

      return {
        kind: 'ready',
        context: await this.#insertConnection(transaction, {
          id: input.id,
          giveawayId: input.giveawayId,
          inviteId: null,
          telegramUserId: input.telegramUserId,
          now: input.now,
        }),
      };
    });
  }

  async openExternalInvite(input: {
    id: string;
    tokenHash: string;
    telegramUserId: number;
    confirmSwitch: boolean;
    now: number;
  }): Promise<PendingConnectionResult> {
    const result = await this.#database.transaction<
      PendingConnectionResult | { error: Error }
    >(async (transaction) => {
      const invite = await this.#findInviteByHash(transaction, input.tokenHash);
      if (!invite) {
        return { error: new Error('Unknown channel invitation') };
      }
      if (invite.state === 'active' && invite.expiresAt <= input.now) {
        await transaction.execute(
          "update channel_invites set state = 'expired' where id = ?",
          [invite.id],
        );
        await transaction.execute(
          "update pending_channel_connections set status = 'superseded', updated_at = ? where invite_id = ? and status = 'active'",
          [input.now, invite.id],
        );
        return { error: new Error('Channel invitation has expired') };
      }
      if (invite.state !== 'active') {
        return {
          error: new Error(`Channel invitation is ${invite.state}`),
        };
      }
      if (
        invite.invitedTelegramId !== null &&
        invite.invitedTelegramId !== input.telegramUserId
      ) {
        return {
          error: new Error('Channel invitation belongs to another user'),
        };
      }
      if (invite.invitedTelegramId === null) {
        await transaction.execute(
          'update channel_invites set invited_telegram_id = ? where id = ?',
          [input.telegramUserId, invite.id],
        );
      }

      const current = await this.#findActiveConnection(
        transaction,
        input.telegramUserId,
      );
      if (current?.inviteId === invite.id) {
        return { kind: 'ready', context: current };
      }
      if (current && !input.confirmSwitch) {
        return {
          kind: 'switch_confirmation_required',
          current,
          requested: { giveawayId: invite.giveawayId, inviteId: invite.id },
        };
      }
      if (current) {
        await this.#supersedeConnection(transaction, current.id, input.now);
      }

      return {
        kind: 'ready',
        context: await this.#insertConnection(transaction, {
          id: input.id,
          giveawayId: invite.giveawayId,
          inviteId: invite.id,
          telegramUserId: input.telegramUserId,
          now: input.now,
        }),
      };
    });

    if ('error' in result) {
      throw result.error;
    }
    return result;
  }

  async revokeExternalInvite(input: {
    inviteId: string;
    now: number;
  }): Promise<ChannelInvitation> {
    return this.#database.transaction(async (transaction) => {
      const invite = await this.#findInviteById(transaction, input.inviteId);
      if (!invite) {
        throw new Error('Unknown channel invitation');
      }
      if (invite.state === 'consumed') {
        throw new Error('Consumed channel invitation cannot be revoked');
      }
      await this.#expireInvitesForGiveaway(
        transaction,
        invite.giveawayId,
        input.now,
      );
      const current = await this.#findInviteById(transaction, input.inviteId);
      if (!current) {
        throw new Error('Unknown channel invitation');
      }
      if (current.state === 'active') {
        await transaction.execute(
          "update channel_invites set state = 'revoked', revoked_at = ? where id = ?",
          [input.now, input.inviteId],
        );
        await transaction.execute(
          "update pending_channel_connections set status = 'superseded', updated_at = ? where invite_id = ? and status = 'active'",
          [input.now, input.inviteId],
        );
      }

      const updated = await this.#findInviteById(transaction, input.inviteId);
      if (!updated) {
        throw new Error('Failed to revoke channel invitation');
      }
      return updated;
    });
  }

  async storeChannelCandidate(input: {
    telegramUserId: number;
    candidate: ChannelCandidate;
    now: number;
  }): Promise<
    | { kind: 'candidate_ready'; candidate: ChannelCandidate }
    | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
  > {
    const result = await this.#database.transaction<
      | { kind: 'candidate_ready'; candidate: ChannelCandidate }
      | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
      | { error: Error }
    >(async (transaction) => {
      const connection = await this.#findActiveConnection(
        transaction,
        input.telegramUserId,
      );
      if (!connection) {
        const existing = await this.#findChannelByOwnerAndChat(
          transaction,
          input.telegramUserId,
          input.candidate.telegramChatId,
        );
        return existing
          ? { kind: 'already_connected', channel: existing }
          : { error: new Error('No active channel connection for this user') };
      }

      const inviteError = await this.#expireOrValidateConnectionInvite(
        transaction,
        connection,
        input.now,
      );
      if (inviteError) {
        return { error: inviteError };
      }

      await transaction.execute(
        `update pending_channel_connections
            set candidate_telegram_chat_id = ?, candidate_username = ?,
                candidate_title = ?, rights_verified_at = ?, updated_at = ?
          where id = ?`,
        [
          input.candidate.telegramChatId,
          input.candidate.username,
          input.candidate.title,
          input.now,
          input.now,
          connection.id,
        ],
      );
      return { kind: 'candidate_ready', candidate: input.candidate };
    });

    if ('error' in result) {
      throw result.error;
    }
    return result;
  }

  async confirmChannel(input: {
    id: string;
    telegramUserId: number;
    telegramChatId: number;
    now: number;
  }): Promise<
    | { kind: 'connected'; channel: ConfirmedGiveawayChannel }
    | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
  > {
    const result = await this.#database.transaction<
      | { kind: 'connected'; channel: ConfirmedGiveawayChannel }
      | { kind: 'already_connected'; channel: ConfirmedGiveawayChannel }
      | { error: Error }
    >(async (transaction) => {
      const connection = await this.#findActiveConnection(
        transaction,
        input.telegramUserId,
      );
      if (!connection) {
        const existing = await this.#findChannelByOwnerAndChat(
          transaction,
          input.telegramUserId,
          input.telegramChatId,
        );
        return existing
          ? { kind: 'already_connected', channel: existing }
          : { error: new Error('No active channel connection for this user') };
      }
      if (
        !connection.candidate ||
        connection.candidate.telegramChatId !== input.telegramChatId
      ) {
        return { error: new Error('Channel candidate has not been confirmed') };
      }

      const inviteError = await this.#expireOrValidateConnectionInvite(
        transaction,
        connection,
        input.now,
      );
      if (inviteError) {
        return { error: inviteError };
      }

      const duplicate = await this.#findChannelByGiveawayAndChat(
        transaction,
        connection.giveawayId,
        input.telegramChatId,
      );
      if (duplicate) {
        return duplicate.ownerTelegramId === input.telegramUserId
          ? { kind: 'already_connected', channel: duplicate }
          : {
              error: new Error(
                'Channel is already connected to this giveaway',
              ),
            };
      }

      await transaction.execute(
        `insert into giveaway_channels (
           id, giveaway_id, telegram_chat_id, username, title,
           owner_telegram_id, status, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        [
          input.id,
          connection.giveawayId,
          connection.candidate.telegramChatId,
          connection.candidate.username,
          connection.candidate.title,
          input.telegramUserId,
          input.now,
          input.now,
        ],
      );
      await transaction.execute(
        "update pending_channel_connections set status = 'completed', updated_at = ? where id = ?",
        [input.now, connection.id],
      );
      if (connection.inviteId) {
        await transaction.execute(
          "update channel_invites set state = 'consumed', consumed_at = ? where id = ? and state = 'active'",
          [input.now, connection.inviteId],
        );
      }

      const channel = await this.#findChannelByGiveawayAndChat(
        transaction,
        connection.giveawayId,
        input.telegramChatId,
      );
      if (!channel) {
        return { error: new Error('Failed to persist confirmed channel') };
      }
      return { kind: 'connected', channel };
    });

    if ('error' in result) {
      throw result.error;
    }
    return result;
  }

  async #insertConnection(
    database: DatabaseBoundary,
    input: {
      id: string;
      giveawayId: string;
      inviteId: string | null;
      telegramUserId: number;
      now: number;
    },
  ): Promise<PendingChannelConnection> {
    await database.execute(
      `insert into pending_channel_connections (
         id, giveaway_id, invite_id, telegram_user_id, status,
         candidate_telegram_chat_id, candidate_username, candidate_title,
         rights_verified_at, created_at, updated_at
       ) values (?, ?, ?, ?, 'active', null, null, null, null, ?, ?)`,
      [
        input.id,
        input.giveawayId,
        input.inviteId,
        input.telegramUserId,
        input.now,
        input.now,
      ],
    );
    const connection = await this.#findActiveConnection(
      database,
      input.telegramUserId,
    );
    if (!connection) {
      throw new Error('Failed to persist pending channel connection');
    }
    return connection;
  }

  async #supersedeConnection(
    database: DatabaseBoundary,
    connectionId: string,
    now: number,
  ): Promise<void> {
    await database.execute(
      "update pending_channel_connections set status = 'superseded', updated_at = ? where id = ? and status = 'active'",
      [now, connectionId],
    );
  }

  async #expireOrValidateConnectionInvite(
    database: DatabaseBoundary,
    connection: PendingChannelConnection,
    now: number,
  ): Promise<Error | undefined> {
    if (!connection.inviteId) {
      return undefined;
    }
    const invite = await this.#findInviteById(database, connection.inviteId);
    if (!invite) {
      return new Error('Unknown channel invitation');
    }
    if (invite.state === 'active' && invite.expiresAt <= now) {
      await database.execute(
        "update channel_invites set state = 'expired' where id = ?",
        [invite.id],
      );
      await this.#supersedeConnection(database, connection.id, now);
      return new Error('Channel invitation has expired');
    }
    if (invite.state !== 'active') {
      return new Error(`Channel invitation is ${invite.state}`);
    }
    return undefined;
  }

  async #expireInvitesForGiveaway(
    database: DatabaseBoundary,
    giveawayId: string,
    now: number,
  ): Promise<void> {
    await database.execute(
      `update pending_channel_connections
          set status = 'superseded', updated_at = ?
        where giveaway_id = ? and status = 'active'
          and invite_id in (
            select id from channel_invites
             where giveaway_id = ? and state = 'active' and expires_at <= ?
          )`,
      [now, giveawayId, giveawayId, now],
    );
    await database.execute(
      `update channel_invites
          set state = 'expired'
        where giveaway_id = ? and state = 'active' and expires_at <= ?`,
      [giveawayId, now],
    );
  }

  async #findInviteByHash(
    database: DatabaseBoundary,
    tokenHash: string,
  ): Promise<ChannelInvitation | undefined> {
    return this.#findInvite(database, 'token_hash', tokenHash);
  }

  async #findInviteById(
    database: DatabaseBoundary,
    id: string,
  ): Promise<ChannelInvitation | undefined> {
    return this.#findInvite(database, 'id', id);
  }

  async #findInvite(
    database: DatabaseBoundary,
    column: 'id' | 'token_hash',
    value: string,
  ): Promise<ChannelInvitation | undefined> {
    const rows = await database.all<{
      id: string;
      giveawayId: string;
      invitedTelegramId: number | null;
      state: ChannelInvitation['state'];
      expiresAt: number;
      consumedAt: number | null;
      revokedAt: number | null;
      createdAt: number;
    }>(
      `select id,
              giveaway_id as giveawayId,
              invited_telegram_id as invitedTelegramId,
              state,
              expires_at as expiresAt,
              consumed_at as consumedAt,
              revoked_at as revokedAt,
              created_at as createdAt
         from channel_invites where ${column} = ?`,
      [value],
    );
    return rows[0];
  }

  async #findActiveConnection(
    database: DatabaseBoundary,
    telegramUserId: number,
  ): Promise<PendingChannelConnection | undefined> {
    const rows = await database.all<{
      id: string;
      giveawayId: string;
      inviteId: string | null;
      telegramUserId: number;
      status: PendingChannelConnection['status'];
      candidateTelegramChatId: number | null;
      candidateUsername: string | null;
      candidateTitle: string | null;
      createdAt: number;
      updatedAt: number;
    }>(
      `select id,
              giveaway_id as giveawayId,
              invite_id as inviteId,
              telegram_user_id as telegramUserId,
              status,
              candidate_telegram_chat_id as candidateTelegramChatId,
              candidate_username as candidateUsername,
              candidate_title as candidateTitle,
              created_at as createdAt,
              updated_at as updatedAt
         from pending_channel_connections
        where telegram_user_id = ? and status = 'active'
        limit 1`,
      [telegramUserId],
    );
    return rows[0] ? this.#mapConnection(rows[0]) : undefined;
  }

  #mapConnection(row: {
    id: string;
    giveawayId: string;
    inviteId: string | null;
    telegramUserId: number;
    status: PendingChannelConnection['status'];
    candidateTelegramChatId: number | null;
    candidateUsername: string | null;
    candidateTitle: string | null;
    createdAt: number;
    updatedAt: number;
  }): PendingChannelConnection {
    const candidate =
      row.candidateTelegramChatId !== null &&
      row.candidateUsername !== null &&
      row.candidateTitle !== null
        ? {
            telegramChatId: row.candidateTelegramChatId,
            username: row.candidateUsername,
            title: row.candidateTitle,
          }
        : null;
    return {
      id: row.id,
      giveawayId: row.giveawayId,
      inviteId: row.inviteId,
      telegramUserId: row.telegramUserId,
      status: row.status,
      candidate,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async #findChannelByOwnerAndChat(
    database: DatabaseBoundary,
    ownerTelegramId: number,
    telegramChatId: number,
  ): Promise<ConfirmedGiveawayChannel | undefined> {
    const rows = await this.#findChannels(
      database,
      'owner_telegram_id = ? and telegram_chat_id = ?',
      [ownerTelegramId, telegramChatId],
    );
    return rows[0];
  }

  async #findChannelByGiveawayAndChat(
    database: DatabaseBoundary,
    giveawayId: string,
    telegramChatId: number,
  ): Promise<ConfirmedGiveawayChannel | undefined> {
    const rows = await this.#findChannels(
      database,
      'giveaway_id = ? and telegram_chat_id = ?',
      [giveawayId, telegramChatId],
    );
    return rows[0];
  }

  async #findChannels(
    database: DatabaseBoundary,
    where: string,
    parameters: Array<string | number>,
  ): Promise<ConfirmedGiveawayChannel[]> {
    return database.all<ConfirmedGiveawayChannel>(
      `select id,
              giveaway_id as giveawayId,
              telegram_chat_id as telegramChatId,
              username,
              title,
              owner_telegram_id as ownerTelegramId,
              status,
              created_at as createdAt,
              updated_at as updatedAt
         from giveaway_channels where ${where}
        order by updated_at desc, id desc
        limit 1`,
      parameters,
    );
  }

  #completeGiveaway(
    id: string,
    draft: GiveawayDraft,
  ): {
    id: string;
    title: string;
    winnerCount: number;
    deadlineUtc: number;
    referralsEnabled: boolean;
    content: NonNullable<GiveawayDraft['content']>;
  } {
    if (
      draft.title === undefined ||
      draft.winnerCount === undefined ||
      draft.deadlineUtc === undefined ||
      draft.content === undefined
    ) {
      throw new Error('Cannot materialize an incomplete giveaway draft');
    }

    return {
      id,
      title: draft.title,
      winnerCount: draft.winnerCount,
      deadlineUtc: draft.deadlineUtc,
      referralsEnabled: draft.referralsEnabled,
      content: draft.content,
    };
  }

  async #findActiveWizard(
    database: DatabaseBoundary,
    administratorTelegramId: number,
  ): Promise<ActiveWizard | undefined> {
    const rows = await database.all<WizardRow>(
      `select id,
              administrator_telegram_id as administratorTelegramId,
              giveaway_id as giveawayId,
              step,
              status,
              draft_data as draftData,
              created_at as createdAt,
              updated_at as updatedAt
         from wizard_sessions
        where administrator_telegram_id = ? and status = 'active'
        limit 1`,
      [administratorTelegramId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      administratorTelegramId: row.administratorTelegramId,
      giveawayId: row.giveawayId ?? undefined,
      step: row.step,
      status: 'active',
      draft: JSON.parse(row.draftData) as GiveawayDraft,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
