import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { CallbackActionService } from '../../src/application/callback-action-service.js';
import { ChannelAuthorizationService } from '../../src/application/channel-authorization-service.js';
import { DraftWizardService } from '../../src/application/draft-wizard-service.js';
import { GiveawayDrawService } from '../../src/application/giveaway-draw-service.js';
import { GiveawayCancellationService } from '../../src/application/giveaway-cancellation-service.js';
import { GiveawayManagementService } from '../../src/application/giveaway-management-service.js';
import { GiveawayPostSynchronizationService } from '../../src/application/giveaway-post-synchronization-service.js';
import { GiveawayPublicationService } from '../../src/application/giveaway-publication-service.js';
import { GiveawayRerollService } from '../../src/application/giveaway-reroll-service.js';
import { ParticipantRegistrationService } from '../../src/application/participant-registration-service.js';
import type {
  TelegramCancelledMessage,
  TelegramGateway,
  TelegramGiveawayMessage,
  TelegramPostEdit,
} from '../../src/application/ports/telegram-gateway.js';
import { TelegramDeliveryError } from '../../src/application/ports/telegram-gateway.js';
import { openDatabase, type DatabaseBoundary } from '../../src/database/client.js';
import { SqliteDrawRepository } from '../../src/database/draw-repository.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { SqliteParticipantRepository } from '../../src/database/participant-repository.js';
import { SqlitePostSynchronizationRepository } from '../../src/database/post-synchronization-repository.js';
import type { ParticipantMembership } from '../../src/domain/participant-rules.js';
import { hashToken } from '../../src/domain/tokens.js';
import { registerGiftBotHandlers } from '../../src/telegram/gift-bot-adapter.js';

const NOW = Date.UTC(2026, 7, 8, 7, 0);
const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'Gift Bot',
  username: 'gift_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type ApiCall = { method: string; payload: Record<string, unknown> };

class FakeTelegramApi {
  readonly calls: ApiCall[] = [];
  #messageId = 100;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ method, payload });
    const result =
      method === 'answerCallbackQuery' || method.startsWith('edit')
        ? true
        : {
            message_id: ++this.#messageId,
            date: Math.floor(NOW / 1000),
            chat: { id: payload.chat_id, type: 'private' },
            text: payload.text,
          };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  sentMessages() {
    return this.calls.filter((call) => call.method === 'sendMessage');
  }
}

class FakePublicationGateway implements TelegramGateway {
  readonly operations: string[] = [];
  sendResults: Array<number | Error> = [];
  readonly metadata = new Map<number, { username: string | null; title: string }>();
  readonly participantMemberships = new Map<number, ParticipantMembership>();
  readonly botAdministrator = new Map<number, boolean>();
  #messageId = 500;

  async getChannelSnapshot(chatId: number) {
    const metadata = this.metadata.get(chatId) ?? {
      username: chatId === -4001 ? 'gift_channel' : `channel_${Math.abs(chatId)}`,
      title: chatId === -4001 ? 'Gift Channel' : `Channel ${Math.abs(chatId)}`,
    };
    return {
      ...metadata,
      membership: {
        status: this.botAdministrator.get(chatId) === false ? 'left' : 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      },
    };
  }

  async getParticipantMembership(_chatId: number, telegramUserId: number) {
    return this.participantMemberships.get(telegramUserId) ?? { status: 'left' as const };
  }

  async sendGiveawayMessage(input: TelegramGiveawayMessage) {
    this.operations.push(`send:${input.chatId}`);
    const result = this.sendResults.shift() ?? ++this.#messageId;
    if (result instanceof Error) throw result;
    return { messageId: result };
  }

  async deleteMessage(chatId: number, messageId: number) {
    this.operations.push(`delete:${chatId}:${messageId}`);
  }

  async editCancelledMessage(input: TelegramCancelledMessage) {
    await this.editGiveawayPost({
      ...input,
      entities: [],
      removeParticipationButton: true,
    });
  }

  async editGiveawayPost(input: TelegramPostEdit) {
    this.operations.push(`edit:${input.chatId}:${input.messageId}`);
  }

  async sendDirectMessage(chatId: number) {
    this.operations.push(`direct:${chatId}`);
  }
}

async function openTestBot(allowedTelegramIds: number[] = [700]) {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-adapter-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  let sequence = 0;
  let currentNow = NOW;
  const createId = (kind: string) => `${kind}-${++sequence}`;
  const now = () => currentNow;
  const wizard = new DraftWizardService(repository, { createId, now });
  const channels = new ChannelAuthorizationService(repository, { createId, now });
  const callbacks = new CallbackActionService(repository, {
    createToken: () => {
      const token = `token_${String(++sequence).padStart(36, '0')}`;
      return { token, tokenHash: hashToken(token) };
    },
    now,
  });
  const telegramGateway = new FakePublicationGateway();
  const publication = new GiveawayPublicationService(repository, telegramGateway, {
    botUsername: BOT_INFO.username,
    createId,
    createToken: () => ({ token: 'join-token', tokenHash: hashToken('join-token') }),
    now,
  });
  const participantRepository = new SqliteParticipantRepository(opened.database, {
    createId,
  });
  const drawRepository = new SqliteDrawRepository(opened.database, { createId });
  const draws = new GiveawayDrawService(drawRepository, telegramGateway, {
    randomInt: (maximumExclusive) => maximumExclusive - 1,
    teamTelegramIds: allowedTelegramIds,
    now,
  });
  const rerolls = new GiveawayRerollService(drawRepository, telegramGateway, {
    createId,
    teamTelegramIds: allowedTelegramIds,
    now,
    sleep: async () => undefined,
  });
  const participants = new ParticipantRegistrationService(
    participantRepository,
    telegramGateway,
    {
      botUsername: BOT_INFO.username,
      createToken: () => {
        const token = `referral_${String(++sequence).padStart(36, '0')}`;
        return { token, tokenHash: hashToken(token) };
      },
      now,
    },
  );
  const synchronization = new GiveawayPostSynchronizationService(
    new SqlitePostSynchronizationRepository(opened.database, {
      botUsername: 'gift_test_bot',
    }),
    telegramGateway,
    { now },
  );
  const cancellation = new GiveawayCancellationService(
    repository,
    synchronization,
    { createId, now },
  );
  const management = new GiveawayManagementService(repository, { now });
  const fakeApi = new FakeTelegramApi();
  const bot = new Bot<Context>('test-token', {
    botInfo: BOT_INFO,
    client: { fetch: fakeApi.fetch },
  });
  const teamTelegramIds = new Set(allowedTelegramIds);
  registerGiftBotHandlers(bot, {
    teamTelegramIds,
    botUsername: BOT_INFO.username,
    wizard,
    channels,
    callbacks,
    publication,
    cancellation,
    management,
    participants,
    draws,
    rerolls,
  });
  cleanups.push(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...opened,
    bot,
    fakeApi,
    telegramGateway,
    repository,
    channels,
    callbacks,
    participants,
    drawRepository,
    draws,
    rerolls,
    teamTelegramIds,
    advanceTime: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

function privateMessageUpdate(
  updateId: number,
  userId: number,
  text: string,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: userId, type: 'private', first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
        : {}),
    },
  };
}

function photoUpdate(updateId: number, userId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: userId, type: 'private', first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      photo: [
        {
          file_id: 'small-photo',
          file_unique_id: 'small',
          width: 100,
          height: 100,
          file_size: 100,
        },
        {
          file_id: 'largest-photo-file-id',
          file_unique_id: 'large',
          width: 1000,
          height: 1000,
          file_size: 1000,
        },
      ],
      caption: 'Жирные условия',
      caption_entities: [{ type: 'bold', offset: 0, length: 6 }],
    },
  };
}

function callbackUpdate(
  updateId: number,
  userId: number,
  data: string,
): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: 'chat-instance',
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      data,
      message: {
        message_id: updateId,
        date: Math.floor(NOW / 1000),
        chat: { id: userId, type: 'private', first_name: `User ${userId}` },
        text: 'Keyboard',
      },
    },
  };
}

function myChatMemberUpdate(updateId: number, userId: number, chatId: number): Update {
  const botMember = {
    user: BOT_INFO,
    status: 'administrator' as const,
    can_be_edited: true,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    can_post_messages: true,
    can_edit_messages: true,
  };
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: chatId, type: 'channel', title: 'Gift Channel', username: 'gift_channel' },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      date: Math.floor(NOW / 1000),
      old_chat_member: { status: 'left', user: BOT_INFO },
      new_chat_member: botMember,
    },
  };
}

function callbackData(call: ApiCall, buttonText: string): string {
  const markup = call.payload.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  };
  const button = markup.inline_keyboard.flat().find((item) => item.text === buttonText);
  if (!button?.callback_data) throw new Error(`Missing callback ${buttonText}`);
  return button.callback_data;
}

async function seedChannelsWizard(
  database: DatabaseBoundary,
  input: { id: string; title: string; administratorTelegramId: number },
) {
  await database.execute(
    `insert into giveaways (
       id, title, state, winner_count, deadline_utc, referrals_enabled,
       content_kind, content_text, created_by_telegram_id, created_at, updated_at
     ) values (?, ?, 'draft', 1, ?, 0, 'text', 'Conditions', ?, ?, ?)`,
    [
      input.id,
      input.title,
      NOW + 86_400_000,
      input.administratorTelegramId,
      NOW,
      NOW,
    ],
  );
  await database.execute(
    `insert into wizard_sessions (
       id, administrator_telegram_id, giveaway_id, step, status,
       draft_data, created_at, updated_at
     ) values (?, ?, ?, 'channels', 'active', '{}', ?, ?)`,
    [
      `wizard-${input.id}`,
      input.administratorTelegramId,
      input.id,
      NOW,
      NOW,
    ],
  );
}

describe('grammY Gift Bot adapter authorization', () => {
  it('checks the allowlist before every admin command and admin callback', async () => {
    const { bot, database, fakeApi, callbacks } = await openTestBot();
    let updateId = 1;
    for (const command of ['/start', '/new', '/giveaways', '/cancel']) {
      await bot.handleUpdate(privateMessageUpdate(updateId++, 999, command));
    }
    const issued = await callbacks.issue({
      actorTelegramId: 999,
      giveawayId: null,
      action: 'cancel_wizard',
      payload: {},
    });
    await bot.handleUpdate(callbackUpdate(updateId++, 999, `admin:${issued.token}`));

    expect(fakeApi.sentMessages().map((call) => call.payload.text)).toEqual([
      'Эта команда недоступна.',
      'Эта команда недоступна.',
      'Эта команда недоступна.',
      'Эта команда недоступна.',
    ]);
    expect(await database.all('select id from wizard_sessions')).toEqual([]);
    expect(
      await database.all('select consumed_at from callback_actions'),
    ).toEqual([{ consumed_at: null }]);
  });
});

describe('grammY Gift Bot adapter channel and join routes', () => {
  it('keeps ci_ external owners isolated, binds my_chat_member to from.id, and confirms once', async () => {
    const { bot, database, fakeApi, channels } = await openTestBot();
    await seedChannelsWizard(database, {
      id: 'external-giveaway',
      title: 'External gift',
      administratorTelegramId: 700,
    });
    const invite = await channels.createExternalInvite('external-giveaway');

    await bot.handleUpdate(
      privateMessageUpdate(10, 800, `/start ci_${invite.token}`),
    );
    await bot.handleUpdate(privateMessageUpdate(11, 800, '/new'));

    expect(fakeApi.sentMessages()[0]!.payload).toMatchObject({
      chat_id: 800,
      text: expect.stringContaining('External gift'),
    });
    expect(fakeApi.sentMessages()[0]!.payload.text).toContain(
      new Date(invite.expiresAt).toISOString(),
    );
    const startChannelKeyboard = fakeApi.sentMessages()[0]!.payload.reply_markup as {
      inline_keyboard: Array<Array<{ url: string }>>;
    };
    expect(startChannelKeyboard.inline_keyboard[0]![0]!.url).toBe(
      'https://t.me/gift_test_bot?startchannel&admin=post_messages+edit_messages+delete_messages',
    );
    expect(fakeApi.sentMessages()[1]!.payload.text).toBe('Эта команда недоступна.');

    await bot.handleUpdate(myChatMemberUpdate(12, 801, -3001));
    expect(fakeApi.sentMessages()).toHaveLength(2);
    await bot.handleUpdate(myChatMemberUpdate(13, 800, -3001));
    const confirmation = fakeApi.sentMessages().at(-1)!;
    expect(confirmation.payload.chat_id).toBe(800);
    const confirmData = callbackData(confirmation, 'Подтвердить канал');
    expect(confirmData).toMatch(/^external:/);

    await bot.handleUpdate(callbackUpdate(14, 800, confirmData));
    await bot.handleUpdate(callbackUpdate(15, 800, confirmData));
    expect(
      await database.all(
        `select telegram_chat_id, owner_telegram_id from giveaway_channels
          where giveaway_id = 'external-giveaway'`,
      ),
    ).toEqual([{ telegram_chat_id: -3001, owner_telegram_id: 800 }]);
    expect(
      await database.all('select state from channel_invites where id = ?', [invite.id]),
    ).toEqual([{ state: 'consumed' }]);
  });

  it('stores only an invite id in switch callbacks and confirms the pending switch by actor and invite state', async () => {
    const { bot, database, fakeApi, channels } = await openTestBot();
    await seedChannelsWizard(database, {
      id: 'switch-one',
      title: 'Switch one',
      administratorTelegramId: 700,
    });
    await seedChannelsWizard(database, {
      id: 'switch-two',
      title: 'Switch two',
      administratorTelegramId: 701,
    });
    const first = await channels.createExternalInvite('switch-one');
    const second = await channels.createExternalInvite('switch-two');

    await bot.handleUpdate(privateMessageUpdate(16, 810, `/start ci_${first.token}`));
    await bot.handleUpdate(privateMessageUpdate(17, 810, `/start ci_${second.token}`));
    const switchMessage = fakeApi.sentMessages().at(-1)!;
    const switchData = callbackData(switchMessage, 'Переключиться');
    const payloadRows = await database.all<{ payload: string }>(
      'select payload from callback_actions',
    );
    const persistedPayloads = payloadRows.map((row) => row.payload).join('\n');
    expect(persistedPayloads).toContain(second.id);
    expect(persistedPayloads).not.toContain(first.token);
    expect(persistedPayloads).not.toContain(second.token);

    await bot.handleUpdate(callbackUpdate(18, 810, switchData));
    expect(
      await database.all(
        "select giveaway_id from pending_channel_connections where telegram_user_id = 810 and status = 'active'",
      ),
    ).toEqual([{ giveaway_id: 'switch-two' }]);
  });

  it('issues own-channel confirmation as admin-only and rejects a formerly allowlisted operator', async () => {
    const { bot, database, fakeApi, channels, teamTelegramIds } =
      await openTestBot();
    await seedChannelsWizard(database, {
      id: 'own-allowlist',
      title: 'Own allowlist',
      administratorTelegramId: 700,
    });
    await channels.createOwnConnection({
      giveawayId: 'own-allowlist',
      telegramUserId: 700,
    });

    await bot.handleUpdate(myChatMemberUpdate(19, 700, -3010));
    const confirmation = fakeApi.sentMessages().at(-1)!;
    const confirmData = callbackData(confirmation, 'Подтвердить канал');
    expect(confirmData).toMatch(/^admin:/);

    teamTelegramIds.delete(700);
    await bot.handleUpdate(callbackUpdate(20, 700, confirmData));
    expect(
      await database.all(
        "select id from giveaway_channels where giveaway_id = 'own-allowlist'",
      ),
    ).toEqual([]);
  });

  it('registers an active join_ link idempotently without requiring a username', async () => {
    const { bot, database, fakeApi, telegramGateway } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('active-giveaway', 'Active gift', 'active', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into join_tokens (token_hash, giveaway_id, state, expires_at, created_at)
       values (?, 'active-giveaway', 'active', null, ?)`,
      [hashToken('active-join'), NOW],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('active-channel', 'active-giveaway', -4100, 'active_channel',
                 'Active Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    telegramGateway.participantMemberships.set(900, { status: 'member' });

    await bot.handleUpdate(
      privateMessageUpdate(20, 900, '/start join_active-join'),
    );
    await bot.handleUpdate(
      privateMessageUpdate(21, 900, '/start join_active-join'),
    );

    expect(fakeApi.sentMessages().at(-2)!.payload.text).toContain(
      'Вы зарегистрированы',
    );
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Вы уже зарегистрированы',
    );
    expect(
      await database.all(
        `select telegram_user_id, username, display_name
           from participants`,
      ),
    ).toEqual([
      {
        telegram_user_id: 900,
        username: null,
        display_name: 'User 900',
      },
    ]);
  });

  it('keeps referral retry actor-bound, stores only the inviter candidate, and replays idempotently', async () => {
    const { bot, database, fakeApi, telegramGateway, advanceTime } =
      await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('ref-giveaway', 'Referral gift', 'active', 1, ?, 1,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into join_tokens (token_hash, giveaway_id, state, expires_at, created_at)
       values (?, 'ref-giveaway', 'active', null, ?)`,
      [hashToken('ref-join'), NOW],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('ref-channel', 'ref-giveaway', -4200, 'ref_channel',
                 'Referral Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    telegramGateway.participantMemberships.set(800, { status: 'member' });
    await bot.handleUpdate(privateMessageUpdate(22, 800, '/start join_ref-join'));
    advanceTime(1);
    const inviterMessage = fakeApi.sentMessages().at(-1)!;
    const inviterMarkup = inviterMessage.payload.reply_markup as {
      inline_keyboard: Array<Array<{ url?: string }>>;
    };
    const referralUrl = inviterMarkup.inline_keyboard.flat().find((button) =>
      button.url?.includes('?start=ref_'),
    )?.url;
    if (!referralUrl) throw new Error('Missing referral URL');
    const referralToken = referralUrl.split('?start=ref_')[1]!;

    telegramGateway.participantMemberships.set(900, { status: 'left' });
    await bot.handleUpdate(
      privateMessageUpdate(23, 900, `/start ref_${referralToken}`),
    );
    const missingMessage = fakeApi.sentMessages().at(-1)!;
    expect(missingMessage.payload.text).toContain('Подпишитесь на все каналы');
    const missingMarkup = missingMessage.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url?: string }>>;
    };
    expect(
      missingMarkup.inline_keyboard.flat().find((button) => button.url)?.url,
    ).toBe('https://t.me/ref_channel');
    const retryData = callbackData(missingMessage, 'Проверить подписку');
    expect(retryData).toMatch(/^participant:/);
    const [{ payload }] = await database.all<{ payload: string }>(
      "select payload from callback_actions where action = 'participant_recheck'",
    );
    expect(payload).not.toContain(referralToken);
    expect(JSON.parse(payload)).toMatchObject({
      giveawayId: 'ref-giveaway',
      inviterParticipantId: expect.any(String),
    });

    await bot.handleUpdate(callbackUpdate(24, 901, retryData));
    expect(
      fakeApi.calls
        .filter((call) => call.method === 'answerCallbackQuery')
        .at(-1)!.payload.text,
    ).toBe('Действие недоступно.');

    telegramGateway.participantMemberships.set(900, { status: 'member' });
    await bot.handleUpdate(callbackUpdate(25, 900, retryData));
    await bot.handleUpdate(callbackUpdate(26, 900, retryData));
    expect(fakeApi.sentMessages().at(-2)!.payload.text).toContain(
      'Вы зарегистрированы',
    );
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Вы уже зарегистрированы',
    );
    expect(
      await database.all(
        "select count(*) as count from participants where giveaway_id = 'ref-giveaway'",
      ),
    ).toEqual([{ count: 2 }]);
  });
});

describe('grammY Gift Bot adapter persisted wizard', () => {
  it('maps every persisted step to Russian UI, connects an own channel, and publishes idempotently', async () => {
    const { bot, database, fakeApi, telegramGateway } = await openTestBot();
    let updateId = 30;
    await bot.handleUpdate(privateMessageUpdate(updateId++, 700, '/new'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'внутреннее название',
    );
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toBe(
      'Введите внутреннее название розыгрыша (от 1 до 100 символов).',
    );
    await bot.handleUpdate(privateMessageUpdate(updateId++, 700, 'Августовский подарок'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'число победителей',
    );
    await bot.handleUpdate(privateMessageUpdate(updateId++, 700, '2'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain('ДД.ММ.ГГГГ');
    await bot.handleUpdate(privateMessageUpdate(updateId++, 700, '10.08.2026 15:30'));
    const referralsPrompt = fakeApi.sentMessages().at(-1)!;
    const referralsData = callbackData(referralsPrompt, 'Включить рефералы');
    await bot.handleUpdate(callbackUpdate(updateId++, 700, referralsData));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'текст или одно фото',
    );
    await bot.handleUpdate(photoUpdate(updateId++, 700));
    const channelsPrompt = fakeApi.sentMessages().at(-1)!;
    const ownChannelData = callbackData(channelsPrompt, 'Добавить свой канал');
    await bot.handleUpdate(callbackUpdate(updateId++, 700, ownChannelData));
    const ownLink = fakeApi.sentMessages().at(-1)!.payload.reply_markup as {
      inline_keyboard: Array<Array<{ url: string }>>;
    };
    expect(ownLink.inline_keyboard[0]![0]!.url).toBe(
      'https://t.me/gift_test_bot?startchannel&admin=post_messages+edit_messages+delete_messages',
    );
    expect(
      await database.all(
        `select content_file_id, content_entities from giveaways
          where created_by_telegram_id = 700`,
      ),
    ).toEqual([
      {
        content_file_id: 'largest-photo-file-id',
        content_entities: '[{"type":"bold","offset":0,"length":6}]',
      },
    ]);

    await bot.handleUpdate(myChatMemberUpdate(updateId++, 700, -4001));
    const confirmData = callbackData(
      fakeApi.sentMessages().at(-1)!,
      'Подтвердить канал',
    );
    await bot.handleUpdate(callbackUpdate(updateId++, 700, confirmData));
    const channelsAgain = fakeApi.sentMessages().at(-1)!;
    const previewData = callbackData(channelsAgain, 'К предпросмотру');
    await bot.handleUpdate(callbackUpdate(updateId++, 700, previewData));
    const preview = fakeApi.calls.filter((call) => call.method === 'sendPhoto').at(-1)!;
    expect(preview.payload).toMatchObject({
      chat_id: 700,
      photo: 'largest-photo-file-id',
      caption: expect.stringContaining('Екатеринбург, UTC+5'),
    });
    expect(preview.payload.caption).not.toContain('Каналы:');
    const previewSummary = fakeApi.sentMessages().at(-1)!;
    const publishData = callbackData(previewSummary, 'Опубликовать');
    await bot.handleUpdate(callbackUpdate(updateId++, 700, publishData));
    await bot.handleUpdate(callbackUpdate(updateId++, 700, publishData));

    expect(
      fakeApi.calls
        .filter((call) => call.method === 'answerCallbackQuery')
        .at(-1)!.payload.text,
    ).toContain('active');

    expect(telegramGateway.operations.filter((item) => item.startsWith('send:'))).toEqual([
      'send:-4001',
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'active' },
    ]);
  });

  it('sends exact-limit text and photo previews separately from the short controls summary', async () => {
    for (const content of [
      { kind: 'text' as const, value: 'x'.repeat(3959), limit: 4096 },
      { kind: 'photo' as const, value: 'x'.repeat(887), limit: 1024 },
    ]) {
      const { bot, database, fakeApi } = await openTestBot();
      const giveawayId = `limit-${content.kind}`;
      await database.execute(
        `insert into giveaways (
           id, title, state, winner_count, deadline_utc, referrals_enabled,
           content_kind, content_text, content_file_id, created_by_telegram_id,
           created_at, updated_at
         ) values (?, 'Limit', 'draft', 1, ?, 0, ?, ?, ?, 700, ?, ?)`,
        [
          giveawayId,
          Date.UTC(2026, 7, 10, 7, 30),
          content.kind,
          content.value,
          content.kind === 'photo' ? 'limit-photo-file' : null,
          NOW,
          NOW,
        ],
      );
      await database.execute(
        `insert into giveaway_channels (
           id, giveaway_id, telegram_chat_id, username, title,
           owner_telegram_id, status, created_at, updated_at
         ) values (?, ?, ?, 'limit_channel', 'Limit Channel', 700,
                   'confirmed', ?, ?)`,
        [`channel-${giveawayId}`, giveawayId, content.kind === 'text' ? -4010 : -4011, NOW, NOW],
      );
      await database.execute(
        `insert into wizard_sessions (
           id, administrator_telegram_id, giveaway_id, step, status,
           draft_data, created_at, updated_at
         ) values (?, 700, ?, 'preview', 'active', '{}', ?, ?)`,
        [`wizard-${giveawayId}`, giveawayId, NOW, NOW],
      );

      await bot.handleUpdate(privateMessageUpdate(80, 700, '/new'));
      const contentCall = fakeApi.calls.find((call) =>
        content.kind === 'photo'
          ? call.method === 'sendPhoto'
          : call.method === 'sendMessage',
      )!;
      const finalText = String(
        content.kind === 'photo'
          ? contentCall.payload.caption
          : contentCall.payload.text,
      );
      expect(finalText).toHaveLength(content.limit - 15);
      expect(contentCall.payload.reply_markup).toBeUndefined();

      const summary = fakeApi.sentMessages().at(-1)!;
      expect(summary.payload.text).toBe(
        'Каналы:\n@limit_channel — подтверждён\n\nПосле запуска условия нельзя изменить.',
      );
      expect(String(summary.payload.text).length).toBeLessThan(1024);
      expect(callbackData(summary, 'Опубликовать')).toMatch(/^admin:/);
    }
  });

  it('shows the administrator a failed publication diagnostic and keeps it in /giveaways', async () => {
    const { bot, database, fakeApi, telegramGateway, callbacks } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('diagnostic-giveaway', 'Diagnostic gift', 'draft', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('diagnostic-channel', 'diagnostic-giveaway', -6101,
                 'diagnostic_channel', 'Diagnostic channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    telegramGateway.sendResults = [
      new TelegramDeliveryError('connection reset after request', 'unknown'),
    ];
    telegramGateway.metadata.set(-6101, {
      username: 'diagnostic_channel',
      title: 'Diagnostic channel',
    });
    const action = await callbacks.issue({
      actorTelegramId: 700,
      giveawayId: 'diagnostic-giveaway',
      action: 'publish_giveaway',
      payload: { giveawayId: 'diagnostic-giveaway' },
    });

    await bot.handleUpdate(callbackUpdate(70, 700, `admin:${action.token}`));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'diagnostic-giveaway',
    );
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain('send_unknown');
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      '@diagnostic_channel',
    );

    await bot.handleUpdate(privateMessageUpdate(71, 700, '/giveaways'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Diagnostic gift — failed',
    );
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain('send_unknown');
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      '@diagnostic_channel',
    );
  });

  it('lists diagnostics only from the failed run bound to the giveaway', async () => {
    const { bot, database, fakeApi, repository } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('bound-failure', 'Bound failure', 'publishing', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    for (const [id, chatId, username] of [
      ['old-channel', -6201, 'old_channel'],
      ['current-delivered', -6202, 'current_delivered'],
      ['current-unknown', -6203, 'current_unknown'],
    ] as const) {
      await database.execute(
        `insert into giveaway_channels (
           id, giveaway_id, telegram_chat_id, username, title,
           owner_telegram_id, status, created_at, updated_at
         ) values (?, 'bound-failure', ?, ?, ?, 700, 'confirmed', ?, ?)`,
        [id, chatId, username, username, NOW, NOW],
      );
    }
    await database.execute(
      `insert into publication_runs (
         id, giveaway_id, status, failure_stage, failure_error_kind,
         started_at, finished_at
       ) values ('old-failed-run', 'bound-failure', 'failed',
                 'send_unknown', 'telegram_unknown', ?, ?)`,
      [NOW - 2_000, NOW - 1_000],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('old-delivery', 'old-failed-run', 'old-channel', 'delivered',
                 401, 'text', ?, ?)`,
      [NOW - 2_000, NOW - 1_000],
    );
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('current-failed-run', 'bound-failure', 'publishing', ?, null)`,
      [NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values
         ('current-delivery', 'current-failed-run', 'current-delivered',
          'delivered', 502, 'text', ?, ?),
         ('current-unknown-delivery', 'current-failed-run', 'current-unknown',
          'unknown', null, null, ?, ?)`,
      [NOW, NOW, NOW, NOW],
    );

    await repository.failPublication({
      publicationRunId: 'current-failed-run',
      failure: { stage: 'send_unknown', errorKind: 'telegram_unknown' },
      now: NOW,
    });
    await bot.handleUpdate(privateMessageUpdate(72, 700, '/giveaways'));

    const text = String(fakeApi.sentMessages().at(-1)!.payload.text);
    expect(text).toContain('@current_delivered');
    expect(text).toContain('https://t.me/current_delivered/502');
    expect(text).toContain('@current_unknown');
    expect(text).not.toContain('@old_channel');
    expect(text).not.toContain('https://t.me/old_channel/401');
  });

  it('renders an immediate failed publish from the same persisted diagnostic card as /giveaways', async () => {
    const { bot, database, fakeApi, telegramGateway, callbacks } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('callback-failure', 'Callback failure', 'draft', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    for (const [id, chatId, username] of [
      ['callback-delivered', -6301, 'callback_delivered'],
      ['callback-unknown', -6302, 'callback_unknown'],
    ] as const) {
      await database.execute(
        `insert into giveaway_channels (
           id, giveaway_id, telegram_chat_id, username, title,
           owner_telegram_id, status, created_at, updated_at
         ) values (?, 'callback-failure', ?, ?, ?, 700, 'confirmed', ?, ?)`,
        [id, chatId, username, username, NOW, NOW],
      );
    }
    telegramGateway.sendResults = [
      551,
      new TelegramDeliveryError('connection reset after request', 'unknown'),
    ];
    telegramGateway.metadata.set(-6301, {
      username: 'callback_delivered',
      title: 'Callback delivered',
    });
    telegramGateway.metadata.set(-6302, {
      username: 'callback_unknown',
      title: 'Callback unknown',
    });
    const action = await callbacks.issue({
      actorTelegramId: 700,
      giveawayId: 'callback-failure',
      action: 'publish_giveaway',
      payload: { giveawayId: 'callback-failure' },
    });

    await bot.handleUpdate(callbackUpdate(73, 700, `admin:${action.token}`));
    const immediate = String(fakeApi.sentMessages().at(-1)!.payload.text);
    expect(immediate).toContain('https://t.me/callback_delivered/551');
    expect(immediate).toContain('@callback_unknown');

    await bot.handleUpdate(privateMessageUpdate(74, 700, '/giveaways'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toBe(
      `Callback failure — failed\nУчастников: 0\nРефералы: выключены\nСинхронизация: актуально\n${immediate}`,
    );
  });

  it('shows participant totals, referral mode, synchronization, and active rights warnings in /giveaways', async () => {
    const { bot, database, fakeApi } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('health-card', 'Health card', 'active', 1, ?, 1,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('health-channel', 'health-card', -6401, 'health_channel',
                 'Health Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into participants (
         id, giveaway_id, telegram_user_id, username, display_name,
         inviter_participant_id, joined_at, updated_at
       ) values ('health-participant', 'health-card', 900, null, 'Guest', null, ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into sync_tasks (
         id, giveaway_id, giveaway_channel_id, task_type, payload,
         status, attempts, available_at, created_at, updated_at
       ) values ('health-sync', 'health-card', 'health-channel',
                 'participant_count', '{}', 'pending', 0, ?, ?, ?)`,
      [NOW, NOW, NOW],
    );
    await database.execute(
      `insert into channel_health_alerts (
         id, giveaway_id, giveaway_channel_id, kind, state,
         first_detected_at, last_detected_at
       ) values ('health-alert', 'health-card', 'health-channel',
                 'bot_admin_rights_lost', 'active', ?, ?)`,
      [NOW, NOW],
    );

    await bot.handleUpdate(privateMessageUpdate(75, 700, '/giveaways'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toBe(
      'Health card — active\nУчастников: 1\nРефералы: включены\nСинхронизация: ожидает синхронизации\n⚠️ Бот не администратор @health_channel («Health Channel»).',
    );
  });

  it('lists giveaways and confirms /cancel before synchronizing an active post', async () => {
    const { bot, database, fakeApi, telegramGateway } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('cancel-me', 'Cancel gift', 'active', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('cancel-channel', 'cancel-me', -5001, 'cancel_channel',
                 'Cancel Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('cancel-run', 'cancel-me', 'succeeded', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('cancel-delivery', 'cancel-run', 'cancel-channel', 'delivered',
                 601, 'text', ?, ?)`,
      [NOW, NOW],
    );

    await bot.handleUpdate(privateMessageUpdate(60, 700, '/giveaways'));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Cancel gift — active',
    );
    await bot.handleUpdate(privateMessageUpdate(61, 700, '/cancel'));
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'active' },
    ]);
    const cancelData = callbackData(
      fakeApi.sentMessages().at(-1)!,
      'Подтвердить отмену',
    );
    await bot.handleUpdate(callbackUpdate(62, 700, cancelData));

    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'cancelled' },
    ]);
    expect(telegramGateway.operations).toEqual(['edit:-5001:601']);
  });

  it('offers actor-bound cancellation for each exact draft, active, and failed giveaway and makes /cancel select', async () => {
    const { bot, database, fakeApi } = await openTestBot([700, 701]);
    for (const [id, title, state, updatedAt] of [
      ['draft-choice', 'Draft choice', 'draft', NOW + 1],
      ['active-choice', 'Active choice', 'active', NOW + 2],
      ['failed-choice', 'Failed choice', 'failed', NOW + 3],
    ] as const) {
      await database.execute(
        `insert into giveaways (
           id, title, state, winner_count, deadline_utc, referrals_enabled,
           content_kind, content_text, created_by_telegram_id, created_at, updated_at
         ) values (?, ?, ?, 1, ?, 0, 'text', 'Conditions', 700, ?, ?)`,
        [id, title, state, NOW + 86_400_000, NOW, updatedAt],
      );
    }

    await bot.handleUpdate(privateMessageUpdate(90, 700, '/giveaways'));
    const cards = fakeApi.sentMessages().slice(-3);
    expect(cards.map((card) => card.payload.text)).toEqual([
      'Failed choice — failed\nУчастников: 0\nРефералы: выключены\nСинхронизация: актуально',
      'Active choice — active\nУчастников: 0\nРефералы: выключены\nСинхронизация: актуально',
      'Draft choice — draft\nУчастников: 0\nРефералы: выключены\nСинхронизация: актуально',
    ]);
    const failedCardAction = callbackData(cards[0]!, 'Отменить');
    const actionPayloads = await database.all<{ payload: string }>(
      "select payload from callback_actions where action = 'request_cancel_giveaway' order by payload",
    );
    expect(actionPayloads.map((row) => JSON.parse(row.payload))).toEqual([
      { giveawayId: 'active-choice' },
      { giveawayId: 'draft-choice' },
      { giveawayId: 'failed-choice' },
    ]);

    await bot.handleUpdate(privateMessageUpdate(91, 700, '/cancel'));
    const selection = fakeApi.sentMessages().at(-1)!;
    expect(selection.payload.text).toBe('Выберите розыгрыш для отмены.');
    const failedSelection = callbackData(selection, 'Failed choice');
    expect(await database.all('select id, state from giveaways order by id')).toEqual([
      { id: 'active-choice', state: 'active' },
      { id: 'draft-choice', state: 'draft' },
      { id: 'failed-choice', state: 'failed' },
    ]);

    await bot.handleUpdate(callbackUpdate(92, 701, failedCardAction));
    expect(await database.all("select state from giveaways where id = 'failed-choice'")).toEqual([
      { state: 'failed' },
    ]);

    await bot.handleUpdate(callbackUpdate(93, 700, failedSelection));
    const confirmation = fakeApi.sentMessages().at(-1)!;
    expect(confirmation.payload.text).toBe('Отменить розыгрыш «Failed choice»?');
    const confirm = callbackData(confirmation, 'Подтвердить отмену');
    await bot.handleUpdate(callbackUpdate(94, 700, confirm));

    expect(await database.all('select id, state from giveaways order by id')).toEqual([
      { id: 'active-choice', state: 'active' },
      { id: 'draft-choice', state: 'draft' },
      { id: 'failed-choice', state: 'cancelled' },
    ]);
  });

  it('runs an actor-bound reroll reason, confirmation, callback replay, and private audit flow', async () => {
    const {
      bot,
      database,
      fakeApi,
      telegramGateway,
      drawRepository,
    } = await openTestBot();
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, content_entities, created_by_telegram_id,
         created_at, updated_at
       ) values ('reroll-gift', 'Reroll gift', 'active', 2, ?, 0,
                 'text', 'Conditions', '[]', 700, ?, ?)`,
      [NOW - 1, NOW - 100, NOW - 100],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('reroll-channel', 'reroll-gift', -7001, 'reroll_channel',
                 'Reroll Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('reroll-publication', 'reroll-gift', 'succeeded', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('reroll-delivery', 'reroll-publication', 'reroll-channel',
                 'delivered', 777, 'text', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into participants (
         id, giveaway_id, telegram_user_id, username, display_name,
         inviter_participant_id, joined_at, updated_at
       ) values ('alice', 'reroll-gift', 101, 'alice', 'Alice', null, ?, ?),
                ('bob', 'reroll-gift', 102, 'bob', 'Bob', null, ?, ?),
                ('carol', 'reroll-gift', 103, 'carol', 'Carol', null, ?, ?),
                ('dave', 'reroll-gift', 104, 'dave', 'Dave', null, ?, ?)`,
      [
        NOW - 40,
        NOW - 40,
        NOW - 30,
        NOW - 30,
        NOW - 20,
        NOW - 20,
        NOW - 10,
        NOW - 10,
      ],
    );
    await drawRepository.claimNextDue(NOW);
    await drawRepository.saveSnapshot({
      giveawayId: 'reroll-gift',
      snapshot: {
        version: 1,
        createdAt: NOW,
        winnerCount: 2,
        participants: [
          ['alice', 101],
          ['bob', 102],
          ['carol', 103],
          ['dave', 104],
        ].map(([participantId, telegramUserId]) => ({
          participantId: String(participantId),
          telegramUserId: Number(telegramUserId),
          username: String(participantId),
          displayName: String(participantId),
          inviterParticipantId: null,
          validDirectReferralCount: 0,
          ticketCount: 1,
        })),
        ticketOrder: ['alice', 'bob', 'carol', 'dave'],
      },
      now: NOW,
    });
    await drawRepository.completeDraw({
      giveawayId: 'reroll-gift',
      places: [
        { placeNumber: 1, status: 'selected', participantId: 'alice' },
        { placeNumber: 2, status: 'selected', participantId: 'bob' },
      ],
      cursor: 2,
      teamTelegramIds: [700],
      now: NOW,
    });
    telegramGateway.participantMemberships.set(103, { status: 'left' });
    telegramGateway.participantMemberships.set(104, { status: 'member' });

    await bot.handleUpdate(privateMessageUpdate(120, 700, '/giveaways'));
    const card = fakeApi.sentMessages().at(-1)!;
    const start = callbackData(card, 'Перевыбрать место 1');
    await bot.handleUpdate(callbackUpdate(121, 700, start));
    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Введите внутреннюю причину',
    );

    await bot.handleUpdate(
      privateMessageUpdate(122, 700, 'bot_or_suspicious_account'),
    );
    const confirmation = fakeApi.sentMessages().at(-1)!;
    const confirm = callbackData(confirmation, 'Подтвердить перевыбор');
    await bot.handleUpdate(callbackUpdate(123, 700, confirm));
    await bot.handleUpdate(callbackUpdate(124, 700, confirm));

    expect(
      await database.all(
        "select count(*) as count from reroll_operations where draw_run_id = (select id from draw_runs where giveaway_id = 'reroll-gift')",
      ),
    ).toEqual([{ count: 1 }]);
    expect((await drawRepository.getCompletedDraw('reroll-gift'))?.places).toEqual([
      expect.objectContaining({ placeNumber: 1, participantId: 'dave' }),
      expect.objectContaining({ placeNumber: 2, participantId: 'bob' }),
    ]);
    await database.execute(
      `update reroll_operations set sync_status = 'retrying'
        where draw_run_id = (
          select id from draw_runs where giveaway_id = 'reroll-gift'
        )`,
    );

    await bot.handleUpdate(privateMessageUpdate(125, 700, '/giveaways'));
    const firstUpdatedCard = fakeApi.sentMessages().at(-1)!;
    const secondStart = callbackData(
      firstUpdatedCard,
      'Перевыбрать место 1',
    );
    await bot.handleUpdate(callbackUpdate(126, 700, secondStart));
    await bot.handleUpdate(privateMessageUpdate(127, 700, 'second_manual_check'));
    const secondConfirmation = fakeApi.sentMessages().at(-1)!;
    const secondConfirm = callbackData(
      secondConfirmation,
      'Подтвердить перевыбор',
    );
    await bot.handleUpdate(callbackUpdate(128, 700, secondConfirm));
    expect((await drawRepository.getCompletedDraw('reroll-gift'))?.places).toEqual([
      expect.objectContaining({
        placeNumber: 1,
        status: 'empty',
        participantId: null,
      }),
      expect.objectContaining({ placeNumber: 2, participantId: 'bob' }),
    ]);
    expect(
      await database.all(
        `select recipient_telegram_id, status
           from draw_notifications
          where giveaway_id = 'reroll-gift' and kind = 'winner'
          order by recipient_telegram_id`,
      ),
    ).toEqual([
      { recipient_telegram_id: 101, status: 'superseded' },
      { recipient_telegram_id: 102, status: 'pending' },
      { recipient_telegram_id: 104, status: 'superseded' },
    ]);
    expect(
      await database.all(
        `select sync_status
           from reroll_operations
          where draw_run_id = (
            select id from draw_runs where giveaway_id = 'reroll-gift'
          )
          order by result_revision`,
      ),
    ).toEqual([{ sync_status: 'superseded' }, { sync_status: 'pending' }]);
    await database.execute(
      `update draw_notifications set status = 'failed',
             last_error_kind = 'telegram_client'
        where id = (
          select id from draw_notifications
           where giveaway_id = 'reroll-gift' and kind = 'winner'
             and reroll_operation_id is null and status = 'pending'
           order by id limit 1
        )`,
    );

    await bot.handleUpdate(privateMessageUpdate(129, 700, '/giveaways'));
    const finalCard = fakeApi.sentMessages().at(-1)!;
    expect(finalCard.payload.text).toContain('не доставлено 1');
    const audit = callbackData(finalCard, 'История перевыборов');
    await bot.handleUpdate(callbackUpdate(130, 700, audit));
    const auditText = String(fakeApi.sentMessages().at(-1)!.payload.text);
    expect(auditText).toContain('Причина: bot_or_suspicious_account');
    expect(auditText).toContain('@alice → @dave');
    expect(auditText).toContain('@carol: subscription_missing');
    expect(auditText).toContain('Причина: second_manual_check');
    expect(auditText).toContain('@dave → empty');
  });

  it('shows a draw failure diagnostic and retries it only through the actor-bound button', async () => {
    const {
      bot,
      database,
      fakeApi,
      telegramGateway,
      drawRepository,
    } = await openTestBot([700, 701]);
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('retry-draw', 'Retry draw', 'active', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW - 1, NOW - 100, NOW - 100],
    );
    await database.execute(
      `insert into giveaway_channels (
         id, giveaway_id, telegram_chat_id, username, title,
         owner_telegram_id, status, created_at, updated_at
       ) values ('retry-channel', 'retry-draw', -8001, 'retry_channel',
                 'Retry Channel', 700, 'confirmed', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_runs (id, giveaway_id, status, started_at, finished_at)
       values ('retry-run', 'retry-draw', 'succeeded', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into publication_deliveries (
         id, publication_run_id, giveaway_channel_id, status, message_id,
         message_kind, created_at, updated_at
       ) values ('retry-delivery', 'retry-run', 'retry-channel', 'delivered',
                 888, 'text', ?, ?)`,
      [NOW, NOW],
    );
    await database.execute(
      `insert into participants (
         id, giveaway_id, telegram_user_id, username, display_name,
         inviter_participant_id, joined_at, updated_at
       ) values ('retry-participant', 'retry-draw', 201, 'retry_user',
                 'Retry User', null, ?, ?)`,
      [NOW - 10, NOW - 10],
    );
    await drawRepository.claimNextDue(NOW);
    await drawRepository.failDraw({
      giveawayId: 'retry-draw',
      stage: 'final_eligibility',
      errorKind: 'telegram_network',
      teamTelegramIds: [700],
      now: NOW,
    });
    telegramGateway.participantMemberships.set(201, { status: 'member' });

    await bot.handleUpdate(privateMessageUpdate(130, 700, '/giveaways'));
    const card = fakeApi.sentMessages().at(-1)!;
    expect(card.payload.text).toContain('ошибка: telegram_network');
    const retry = callbackData(card, 'Повторить завершение');
    await bot.handleUpdate(callbackUpdate(131, 701, retry));
    expect(await database.all("select state from giveaways where id = 'retry-draw'"))
      .toEqual([{ state: 'failed' }]);
    await bot.handleUpdate(callbackUpdate(132, 700, retry));
    expect(await database.all("select state from giveaways where id = 'retry-draw'"))
      .toEqual([{ state: 'completed' }]);
  });
});
