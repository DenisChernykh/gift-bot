import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { CallbackActionService } from '../../src/application/callback-action-service.js';
import { ChannelAuthorizationService } from '../../src/application/channel-authorization-service.js';
import { DraftWizardService } from '../../src/application/draft-wizard-service.js';
import { GiveawayCancellationService } from '../../src/application/giveaway-cancellation-service.js';
import { GiveawayManagementService } from '../../src/application/giveaway-management-service.js';
import { GiveawayPublicationService } from '../../src/application/giveaway-publication-service.js';
import type {
  TelegramCancelledMessage,
  TelegramGateway,
  TelegramGiveawayMessage,
} from '../../src/application/ports/telegram-gateway.js';
import { openDatabase } from '../../src/database/client.js';
import { SqliteGiveawayCreationRepository } from '../../src/database/giveaway-creation-repository.js';
import { migrateDatabase } from '../../src/database/migrate.js';
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
  #messageId = 500;

  async getChannelMembership() {
    return {
      status: 'administrator',
      canPostMessages: true,
      canEditMessages: true,
      canDeleteMessages: true,
    };
  }

  async sendGiveawayMessage(input: TelegramGiveawayMessage) {
    this.operations.push(`send:${input.chatId}`);
    return { messageId: ++this.#messageId };
  }

  async deleteMessage(chatId: number, messageId: number) {
    this.operations.push(`delete:${chatId}:${messageId}`);
  }

  async editCancelledMessage(input: TelegramCancelledMessage) {
    this.operations.push(`edit:${input.chatId}:${input.messageId}`);
  }
}

async function openTestBot() {
  const directory = mkdtempSync(join(tmpdir(), 'gift-bot-adapter-'));
  const opened = openDatabase(join(directory, 'gift-bot.sqlite'));
  await migrateDatabase(opened.database);
  const repository = new SqliteGiveawayCreationRepository(opened.database);
  let sequence = 0;
  const createId = (kind: string) => `${kind}-${++sequence}`;
  const now = () => NOW;
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
  const cancellation = new GiveawayCancellationService(
    repository,
    telegramGateway,
    { createId, now },
  );
  const management = new GiveawayManagementService(repository, { now });
  const fakeApi = new FakeTelegramApi();
  const bot = new Bot<Context>('test-token', {
    botInfo: BOT_INFO,
    client: { fetch: fakeApi.fetch },
  });
  registerGiftBotHandlers(bot, {
    teamTelegramIds: new Set([700]),
    botUsername: BOT_INFO.username,
    wizard,
    channels,
    callbacks,
    publication,
    cancellation,
    management,
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
    channels,
    callbacks,
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
    await database.execute(
      `insert into giveaways (
         id, title, state, winner_count, deadline_utc, referrals_enabled,
         content_kind, content_text, created_by_telegram_id, created_at, updated_at
       ) values ('external-giveaway', 'External gift', 'draft', 1, ?, 0,
                 'text', 'Conditions', 700, ?, ?)`,
      [NOW + 86_400_000, NOW, NOW],
    );
    const invite = await channels.createExternalInvite('external-giveaway');

    await bot.handleUpdate(
      privateMessageUpdate(10, 800, `/start ci_${invite.token}`),
    );
    await bot.handleUpdate(privateMessageUpdate(11, 800, '/new'));

    expect(fakeApi.sentMessages()[0]!.payload).toMatchObject({
      chat_id: 800,
      text: expect.stringContaining('External gift'),
    });
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

  it('returns an explicit Epic 2 boundary for an active join_ link and creates no participant', async () => {
    const { bot, database, fakeApi } = await openTestBot();
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

    await bot.handleUpdate(
      privateMessageUpdate(20, 900, '/start join_active-join'),
    );

    expect(fakeApi.sentMessages().at(-1)!.payload.text).toContain(
      'Регистрация участников появится в Epic 2',
    );
    expect(
      await database.all<{ count: number }>(
        "select count(*) as count from sqlite_master where type = 'table' and name = 'participants'",
      ),
    ).toEqual([{ count: 0 }]);
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
    const preview = fakeApi.sentMessages().at(-1)!;
    expect(preview.payload.text).toContain('Екатеринбург, UTC+5');
    expect(preview.payload.text).toContain('условия нельзя изменить');
    const publishData = callbackData(preview, 'Опубликовать');
    await bot.handleUpdate(callbackUpdate(updateId++, 700, publishData));
    await bot.handleUpdate(callbackUpdate(updateId++, 700, publishData));

    expect(telegramGateway.operations.filter((item) => item.startsWith('send:'))).toEqual([
      'send:-4001',
    ]);
    expect(await database.all('select state from giveaways')).toEqual([
      { state: 'active' },
    ]);
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
});
