import { InlineKeyboard, type Bot, type Context } from 'grammy';

import type { CallbackActionService } from '../application/callback-action-service.js';
import type { ChannelAuthorizationService } from '../application/channel-authorization-service.js';
import type { DraftWizardService } from '../application/draft-wizard-service.js';
import type { GiveawayCancellationService } from '../application/giveaway-cancellation-service.js';
import type { GiveawayManagementService } from '../application/giveaway-management-service.js';
import { PublicationFailureError, type GiveawayPublicationService } from '../application/giveaway-publication-service.js';
import type { ActiveWizard } from '../application/ports/giveaway-creation-repository.js';
import type { GiveawayMessageEntity } from '../domain/giveaway-validation.js';
import { renderGiveawayMessage } from '../domain/giveaway-rendering.js';

const ADMIN_CALLBACK_PREFIX = 'admin:';
const EXTERNAL_CALLBACK_PREFIX = 'external:';
const DENIED_MESSAGE = 'Эта команда недоступна.';
const START_CHANNEL_URL_SUFFIX =
  '?startchannel&admin=post_messages+edit_messages+delete_messages';

export type GiftBotHandlersDependencies = {
  teamTelegramIds: ReadonlySet<number>;
  botUsername: string;
  wizard: DraftWizardService;
  channels: ChannelAuthorizationService;
  callbacks: CallbackActionService;
  publication: GiveawayPublicationService;
  cancellation: GiveawayCancellationService;
  management: GiveawayManagementService;
};

export function registerGiftBotHandlers(
  bot: Bot<Context>,
  dependencies: GiftBotHandlersDependencies,
): void {
  bot.command('start', async (context) => {
    const payload = context.match.trim();
    if (payload.startsWith('ci_')) {
      await handleExternalInviteStart(context, payload.slice(3), dependencies);
      return;
    }
    if (payload.startsWith('join_')) {
      await handleJoinStart(context, payload.slice(5), dependencies);
      return;
    }
    if (!(await requireAdministrator(context, dependencies))) return;
    await context.reply(
      'Gift Bot готов. /new — новый розыгрыш, /giveaways — список, /cancel — отмена.',
    );
  });

  bot.command('new', async (context) => {
    if (!(await requireAdministrator(context, dependencies))) return;
    await safelyReply(context, async () => {
      const result = await dependencies.wizard.startOrResume(context.from!.id);
      await replyWizardPrompt(context, result.wizard, dependencies);
    });
  });

  bot.command('giveaways', async (context) => {
    if (!(await requireAdministrator(context, dependencies))) return;
    const giveaways = await dependencies.management.listGiveaways(context.from!.id);
    await context.reply(
      giveaways.length === 0
        ? 'Сохранённых розыгрышей пока нет.'
        : giveaways.map(formatGiveawayListItem).join('\n\n'),
    );
  });

  bot.command('cancel', async (context) => {
    if (!(await requireAdministrator(context, dependencies))) return;
    await safelyReply(context, async () => {
      const target = await dependencies.management.findCancellationTarget(
        context.from!.id,
      );
      if (target.kind === 'none') {
        await context.reply('Нет розыгрыша или мастера для отмены.');
        return;
      }
      const action = await dependencies.callbacks.issue({
        actorTelegramId: context.from!.id,
        giveawayId: target.kind === 'giveaway' ? target.giveawayId : null,
        action: target.kind === 'giveaway' ? 'cancel_giveaway' : 'cancel_wizard',
        payload:
          target.kind === 'giveaway' ? { giveawayId: target.giveawayId } : {},
      });
      await context.reply(
        target.kind === 'giveaway'
          ? `Отменить розыгрыш «${target.title}»?`
          : 'Отменить текущий мастер?',
        {
          reply_markup: new InlineKeyboard().text(
            'Подтвердить отмену',
            `${ADMIN_CALLBACK_PREFIX}${action.token}`,
          ),
        },
      );
    });
  });

  bot.on('callback_query:data', async (context) => {
    const data = context.callbackQuery.data;
    const isAdminAction = data.startsWith(ADMIN_CALLBACK_PREFIX);
    const isExternalAction = data.startsWith(EXTERNAL_CALLBACK_PREFIX);
    if (isAdminAction && !dependencies.teamTelegramIds.has(context.from.id)) {
      await context.answerCallbackQuery({ text: DENIED_MESSAGE });
      return;
    }
    if (!isAdminAction && !isExternalAction) {
      await context.answerCallbackQuery({ text: 'Неизвестное действие.' });
      return;
    }
    const token = data.slice(
      isAdminAction ? ADMIN_CALLBACK_PREFIX.length : EXTERNAL_CALLBACK_PREFIX.length,
    );
    try {
      const action = await dependencies.callbacks.consume(token, context.from.id);
      if (action.alreadyConsumed) {
        await context.answerCallbackQuery({ text: 'Уже обработано.' });
        return;
      }
      await handleCallbackAction(context, action, dependencies);
      await context.answerCallbackQuery();
    } catch {
      await context.answerCallbackQuery({ text: 'Действие недоступно.' });
    }
  });

  bot.on('my_chat_member', async (context) => {
    const update = context.myChatMember;
    if (update.chat.type !== 'channel') return;
    const member = update.new_chat_member;
    try {
      const observed = await dependencies.channels.observeChannel({
        telegramUserId: update.from.id,
        telegramChatId: update.chat.id,
        username: update.chat.username ?? null,
        title: update.chat.title,
        membership: {
          status: member.status,
          canPostMessages:
            member.status === 'administrator' &&
            (member.can_post_messages ?? false),
          canEditMessages:
            member.status === 'administrator' &&
            (member.can_edit_messages ?? false),
          canDeleteMessages:
            member.status === 'administrator' &&
            (member.can_delete_messages ?? false),
        },
      });
      if (observed.kind === 'already_connected') {
        await context.api.sendMessage(update.from.id, 'Этот канал уже подключён.');
        return;
      }
      const action = await dependencies.callbacks.issue({
        actorTelegramId: update.from.id,
        giveawayId: null,
        action: 'confirm_channel',
        payload: { telegramChatId: update.chat.id },
      });
      await context.api.sendMessage(
        update.from.id,
        `Найден канал «${update.chat.title}» (@${update.chat.username}). Подтвердите подключение.`,
        {
          reply_markup: new InlineKeyboard().text(
            'Подтвердить канал',
            `${EXTERNAL_CALLBACK_PREFIX}${action.token}`,
          ),
        },
      );
    } catch {
      // An unrelated channel update must not expose pending connection state.
    }
  });

  bot.on('message:photo', async (context) => {
    if (!dependencies.teamTelegramIds.has(context.from.id)) return;
    const wizard = await dependencies.wizard.findActive(context.from.id);
    if (!wizard || wizard.step !== 'content') return;
    await safelyReply(context, async () => {
      const largestPhoto = context.message.photo.at(-1)!;
      const updated = await dependencies.wizard.submitContent(context.from.id, {
        kind: 'photo',
        fileId: largestPhoto.file_id,
        caption: context.message.caption ?? '',
        entities: copyEntities(context.message.caption_entities),
      });
      await replyWizardPrompt(context, updated, dependencies);
    });
  });

  bot.on('message:text', async (context) => {
    if (!dependencies.teamTelegramIds.has(context.from.id)) return;
    const wizard = await dependencies.wizard.findActive(context.from.id);
    if (!wizard) return;
    await safelyReply(context, async () => {
      const value = context.message.text;
      let updated: ActiveWizard;
      switch (wizard.step) {
        case 'title':
          updated = await dependencies.wizard.submitTitle(context.from.id, value);
          break;
        case 'winner_count':
          updated = await dependencies.wizard.submitWinnerCount(
            context.from.id,
            Number(value),
          );
          break;
        case 'deadline':
          updated = await dependencies.wizard.submitDeadline(context.from.id, value);
          break;
        case 'content':
          updated = await dependencies.wizard.submitContent(context.from.id, {
            kind: 'text',
            text: value,
            entities: copyEntities(context.message.entities),
          });
          break;
        default:
          await replyWizardPrompt(context, wizard, dependencies);
          return;
      }
      await replyWizardPrompt(context, updated, dependencies);
    });
  });

  bot.on('message', async (context) => {
    if (!dependencies.teamTelegramIds.has(context.from?.id ?? 0)) return;
    const wizard = await dependencies.wizard.findActive(context.from!.id);
    if (wizard?.step === 'content') {
      await context.reply('Отправьте текст или одно фото с обязательной подписью.');
    }
  });
}

async function handleExternalInviteStart(
  context: Context,
  token: string,
  dependencies: GiftBotHandlersDependencies,
) {
  if (!context.from) return;
  await safelyReply(context, async () => {
    const connection = await dependencies.channels.openExternalInvite({
      token,
      telegramUserId: context.from!.id,
    });
    if (connection.kind === 'switch_confirmation_required') {
      const action = await dependencies.callbacks.issue({
        actorTelegramId: context.from!.id,
        giveawayId: connection.requested.giveawayId,
        action: 'switch_external_invite',
        payload: { token },
      });
      await context.reply('У вас уже есть другое подключение. Переключиться?', {
        reply_markup: new InlineKeyboard().text(
          'Переключиться',
          `${EXTERNAL_CALLBACK_PREFIX}${action.token}`,
        ),
      });
      return;
    }
    const summary = await dependencies.management.getGiveawaySummary(
      connection.context.giveawayId,
    );
    await replyStartChannelLink(context, dependencies, summary.title);
  });
}

async function handleJoinStart(
  context: Context,
  token: string,
  dependencies: GiftBotHandlersDependencies,
) {
  const result = await dependencies.management.resolveJoinLink(token);
  await context.reply(
    result.kind === 'epic_2_boundary'
      ? `Розыгрыш «${result.giveaway.title}» активен. Регистрация участников появится в Epic 2; сейчас заявка не создана.`
      : 'Этот розыгрыш недоступен для участия.',
  );
}

async function handleCallbackAction(
  context: Context,
  action: {
    action: string;
    giveawayId: string | null;
    payload: Record<string, unknown>;
  },
  dependencies: GiftBotHandlersDependencies,
) {
  const actorTelegramId = context.from!.id;
  switch (action.action) {
    case 'set_referrals': {
      const updated = await dependencies.wizard.submitReferrals(
        actorTelegramId,
        action.payload.enabled === true,
      );
      await replyWizardPrompt(context, updated, dependencies);
      return;
    }
    case 'add_own_channel': {
      await beginOwnChannelConnection(
        context,
        stringPayload(action.payload, 'giveawayId'),
        false,
        dependencies,
      );
      return;
    }
    case 'switch_own_channel': {
      await beginOwnChannelConnection(
        context,
        stringPayload(action.payload, 'giveawayId'),
        true,
        dependencies,
      );
      return;
    }
    case 'switch_external_invite': {
      const result = await dependencies.channels.openExternalInvite({
        token: stringPayload(action.payload, 'token'),
        telegramUserId: actorTelegramId,
        confirmSwitch: true,
      });
      if (result.kind === 'ready') {
        const summary = await dependencies.management.getGiveawaySummary(
          result.context.giveawayId,
        );
        await replyStartChannelLink(context, dependencies, summary.title);
      }
      return;
    }
    case 'create_external_invite': {
      const giveawayId = stringPayload(action.payload, 'giveawayId');
      const invite = await dependencies.channels.createExternalInvite(giveawayId);
      await context.reply(
        `Ссылка для внешнего владельца (действует 24 часа):\nhttps://t.me/${dependencies.botUsername}?start=ci_${invite.token}`,
      );
      return;
    }
    case 'confirm_channel': {
      await dependencies.channels.confirmChannel({
        telegramUserId: actorTelegramId,
        telegramChatId: numberPayload(action.payload, 'telegramChatId'),
      });
      await context.reply('Канал подключён только к этому розыгрышу.');
      if (dependencies.teamTelegramIds.has(actorTelegramId)) {
        const wizard = await dependencies.wizard.findActive(actorTelegramId);
        if (wizard) await replyWizardPrompt(context, wizard, dependencies);
      }
      return;
    }
    case 'continue_preview': {
      const wizard = await dependencies.wizard.continueToPreview(actorTelegramId);
      await replyWizardPrompt(context, wizard, dependencies);
      return;
    }
    case 'publish_giveaway': {
      try {
        const result = await dependencies.publication.publish(
          stringPayload(action.payload, 'giveawayId'),
        );
        await context.reply(publicationResultText(result));
      } catch (error) {
        if (error instanceof PublicationFailureError) {
          await context.reply(formatPublicationDiagnostic({
            giveawayId: stringPayload(action.payload, 'giveawayId'),
            diagnostic: error.diagnostic,
          }));
          return;
        }
        throw error;
      }
      return;
    }
    case 'cancel_giveaway': {
      const result = await dependencies.cancellation.cancel(
        stringPayload(action.payload, 'giveawayId'),
      );
      await context.reply(
        result.pendingSyncTasks === 0
          ? 'Розыгрыш отменён, публикации синхронизированы.'
          : `Розыгрыш отменён. Ожидают синхронизации: ${result.pendingSyncTasks}.`,
      );
      return;
    }
    case 'cancel_wizard':
      await dependencies.management.cancelUnmaterializedWizard(actorTelegramId);
      await context.reply('Текущий мастер отменён.');
  }
}

async function beginOwnChannelConnection(
  context: Context,
  giveawayId: string,
  confirmSwitch: boolean,
  dependencies: GiftBotHandlersDependencies,
) {
  const result = await dependencies.channels.createOwnConnection({
    giveawayId,
    telegramUserId: context.from!.id,
    confirmSwitch,
  });
  if (result.kind === 'switch_confirmation_required') {
    const action = await dependencies.callbacks.issue({
      actorTelegramId: context.from!.id,
      giveawayId,
      action: 'switch_own_channel',
      payload: { giveawayId },
    });
    await context.reply('У вас уже есть другое подключение. Переключиться?', {
      reply_markup: new InlineKeyboard().text(
        'Переключиться',
        `${ADMIN_CALLBACK_PREFIX}${action.token}`,
      ),
    });
    return;
  }
  await replyStartChannelLink(context, dependencies);
}

async function replyStartChannelLink(
  context: Context,
  dependencies: GiftBotHandlersDependencies,
  giveawayTitle?: string,
) {
  await context.reply(
    `${giveawayTitle ? `Розыгрыш «${giveawayTitle}». ` : ''}Добавьте бота администратором публичного канала с правами публикации, редактирования и удаления.`,
    {
      reply_markup: new InlineKeyboard().url(
        'Выбрать канал',
        `https://t.me/${dependencies.botUsername}${START_CHANNEL_URL_SUFFIX}`,
      ),
    },
  );
}

async function replyWizardPrompt(
  context: Context,
  wizard: ActiveWizard,
  dependencies: GiftBotHandlersDependencies,
) {
  switch (wizard.step) {
    case 'title':
      await context.reply('Введите внутреннее название розыгрыша (от 1 до 100 символов).');
      return;
    case 'winner_count':
      await context.reply('Введите число победителей от 1 до 50.');
      return;
    case 'deadline':
      await context.reply('Введите дедлайн в формате ДД.ММ.ГГГГ ЧЧ:ММ (Екатеринбург).');
      return;
    case 'referrals': {
      const [enabled, disabled] = await Promise.all([
        issueAdminAction(dependencies, wizard, 'set_referrals', { enabled: true }),
        issueAdminAction(dependencies, wizard, 'set_referrals', { enabled: false }),
      ]);
      await context.reply('Включить рефералы по правилу 3 = +1 билет?', {
        reply_markup: new InlineKeyboard()
          .text('Включить рефералы', enabled)
          .text('Без рефералов', disabled),
      });
      return;
    }
    case 'content':
      await context.reply('Отправьте текст или одно фото с обязательной подписью.');
      return;
    case 'channels': {
      if (!wizard.giveawayId) throw new Error('Wizard has no giveaway');
      const [own, external, preview] = await Promise.all([
        issueAdminAction(dependencies, wizard, 'add_own_channel', {
          giveawayId: wizard.giveawayId,
        }),
        issueAdminAction(dependencies, wizard, 'create_external_invite', {
          giveawayId: wizard.giveawayId,
        }),
        issueAdminAction(dependencies, wizard, 'continue_preview', {
          giveawayId: wizard.giveawayId,
        }),
      ]);
      await context.reply('Подключите минимум один публичный канал.', {
        reply_markup: new InlineKeyboard()
          .text('Добавить свой канал', own)
          .row()
          .text('Пригласить владельца', external)
          .row()
          .text('К предпросмотру', preview),
      });
      return;
    }
    case 'preview': {
      if (!wizard.giveawayId) throw new Error('Wizard has no giveaway');
      const giveaway = await dependencies.management.getGiveawaySummary(
        wizard.giveawayId,
      );
      const publish = await issueAdminAction(
        dependencies,
        wizard,
        'publish_giveaway',
        { giveawayId: wizard.giveawayId },
      );
      const rendered = renderGiveawayMessage(giveaway).text;
      const channelList = giveaway.channels
        .map((channel) => `@${channel.username} — подтверждён`)
        .join('\n');
      const replyMarkup = new InlineKeyboard().text('Опубликовать', publish);
      if (giveaway.content.kind === 'photo' && giveaway.content.fileId) {
        await context.replyWithPhoto(giveaway.content.fileId, {
          caption: rendered,
          reply_markup: replyMarkup,
        });
        await context.reply(`Каналы:\n${channelList}\n\nПосле запуска условия нельзя изменить.`);
        return;
      }
      await context.reply(`${rendered}\n\nКаналы:\n${channelList}\n\nПосле запуска условия нельзя изменить.`, { reply_markup: replyMarkup });
    }
  }
}

async function issueAdminAction(
  dependencies: GiftBotHandlersDependencies,
  wizard: ActiveWizard,
  action: string,
  payload: Record<string, unknown>,
) {
  const issued = await dependencies.callbacks.issue({
    actorTelegramId: wizard.administratorTelegramId,
    giveawayId: wizard.giveawayId ?? null,
    action,
    payload,
  });
  return `${ADMIN_CALLBACK_PREFIX}${issued.token}`;
}

async function requireAdministrator(
  context: Context,
  dependencies: GiftBotHandlersDependencies,
) {
  const allowed = context.from && dependencies.teamTelegramIds.has(context.from.id);
  if (!allowed) await context.reply(DENIED_MESSAGE);
  return Boolean(allowed);
}

async function safelyReply(context: Context, operation: () => Promise<void>) {
  try {
    await operation();
  } catch {
    await context.reply('Не удалось выполнить действие. Проверьте данные и попробуйте снова.');
  }
}

function copyEntities(
  entities: readonly GiveawayMessageEntity[] | undefined,
): GiveawayMessageEntity[] | undefined {
  return entities?.map((entity) => ({ ...entity }));
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`Missing ${key}`);
  return value;
}

function numberPayload(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number') throw new Error(`Missing ${key}`);
  return value;
}

function publicationResultText(result: Awaited<ReturnType<GiveawayPublicationService['publish']>>) {
  switch (result.kind) {
    case 'active':
      return 'Розыгрыш опубликован во всех каналах.';
    case 'already_active':
      return 'Розыгрыш уже опубликован.';
    case 'publishing':
      return 'Публикация уже выполняется.';
    case 'failed':
      return formatPublicationDiagnostic({ giveawayId: result.giveawayId, diagnostic: result.diagnostic });
    case 'rolled_back':
      return 'Публикация не удалась; созданные посты удалены, черновик сохранён.';
    default:
      return 'Публикация остановлена в состоянии failed; повторная отправка не выполнялась.';
  }
}

function formatGiveawayListItem(item: Awaited<ReturnType<GiveawayManagementService['listGiveaways']>>[number]) {
  return `${item.title} — ${item.state}${item.failure ? `\n${formatPublicationDiagnostic({ giveawayId: item.id, diagnostic: item.failure })}` : ''}`;
}

function formatPublicationDiagnostic(input: {
  giveawayId: string;
  diagnostic: { stage: string; errorKind: string; channel?: { id: string; username: string; telegramChatId: number }; channels?: Array<{ id: string; username: string; telegramChatId: number; messageId?: number | null }> };
}) {
  const diagnosticChannels: Array<{ id: string; username: string; telegramChatId: number; messageId?: number | null }> =
    input.diagnostic.channels ?? (input.diagnostic.channel ? [input.diagnostic.channel] : []);
  const channels = diagnosticChannels.map((channel) => {
    const link = channel.messageId ? ` https://t.me/${channel.username}/${channel.messageId}` : '';
    return `@${channel.username} (ID ${channel.id}, chat ${channel.telegramChatId})${link}`;
  }).join('\n');
  return `Публикация ${input.giveawayId} остановлена. Этап: ${input.diagnostic.stage}; ошибка: ${input.diagnostic.errorKind}.${channels ? `\nКаналы:\n${channels}` : ''}`;
}
