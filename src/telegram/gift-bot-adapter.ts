import { InlineKeyboard, type Bot, type Context } from 'grammy';

import type { CallbackActionService } from '../application/callback-action-service.js';
import type { ChannelAuthorizationService } from '../application/channel-authorization-service.js';
import type { DraftWizardService } from '../application/draft-wizard-service.js';
import type { GiveawayCancellationService } from '../application/giveaway-cancellation-service.js';
import type { GiveawayManagementService } from '../application/giveaway-management-service.js';
import type {
  ParticipantRegistrationResult,
  ParticipantRegistrationService,
} from '../application/participant-registration-service.js';
import { PublicationFailureError, type GiveawayPublicationService } from '../application/giveaway-publication-service.js';
import type { ActiveWizard } from '../application/ports/giveaway-creation-repository.js';
import type { GiveawayMessageEntity } from '../domain/giveaway-validation.js';
import { renderGiveawayMessage } from '../domain/giveaway-rendering.js';

const ADMIN_CALLBACK_PREFIX = 'admin:';
const EXTERNAL_CALLBACK_PREFIX = 'external:';
const PARTICIPANT_CALLBACK_PREFIX = 'participant:';
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
  participants: ParticipantRegistrationService;
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
      await handleParticipantStart(
        context,
        'join',
        payload.slice(5),
        dependencies,
      );
      return;
    }
    if (payload.startsWith('ref_')) {
      await handleParticipantStart(
        context,
        'referral',
        payload.slice(4),
        dependencies,
      );
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
    if (giveaways.length === 0) {
      await context.reply('Сохранённых розыгрышей пока нет.');
      return;
    }
    for (const giveaway of giveaways) {
      const cancellable = ['draft', 'active', 'failed'].includes(giveaway.state);
      const replyMarkup = cancellable
        ? new InlineKeyboard().text(
            'Отменить',
            await issueCancellationSelection(
              dependencies,
              context.from!.id,
              {
                kind: 'giveaway',
                giveawayId: giveaway.id,
                title: giveaway.title,
                state: giveaway.state as 'draft' | 'active' | 'failed',
              },
            ),
          )
        : undefined;
      await context.reply(formatGiveawayListItem(giveaway), {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  });

  bot.command('cancel', async (context) => {
    if (!(await requireAdministrator(context, dependencies))) return;
    await safelyReply(context, async () => {
      const targets = await dependencies.management.listCancellationTargets(
        context.from!.id,
      );
      if (targets.length === 0) {
        await context.reply('Нет розыгрыша или мастера для отмены.');
        return;
      }
      if (targets.length === 1) {
        await replyCancellationConfirmation(
          context,
          targets[0]!,
          dependencies,
        );
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const target of targets) {
        keyboard
          .text(
            target.kind === 'giveaway' ? target.title : 'Текущий мастер',
            await issueCancellationSelection(
              dependencies,
              context.from!.id,
              target,
            ),
          )
          .row();
      }
      await context.reply('Выберите розыгрыш для отмены.', {
        reply_markup: keyboard,
      });
    });
  });

  bot.on('callback_query:data', async (context) => {
    const data = context.callbackQuery.data;
    const isAdminAction = data.startsWith(ADMIN_CALLBACK_PREFIX);
    const isExternalAction = data.startsWith(EXTERNAL_CALLBACK_PREFIX);
    const isParticipantAction = data.startsWith(PARTICIPANT_CALLBACK_PREFIX);
    if (isAdminAction && !dependencies.teamTelegramIds.has(context.from.id)) {
      await context.answerCallbackQuery({ text: DENIED_MESSAGE });
      return;
    }
    if (!isAdminAction && !isExternalAction && !isParticipantAction) {
      await context.answerCallbackQuery({ text: 'Неизвестное действие.' });
      return;
    }
    const token = data.slice(
      isAdminAction
        ? ADMIN_CALLBACK_PREFIX.length
        : isExternalAction
          ? EXTERNAL_CALLBACK_PREFIX.length
          : PARTICIPANT_CALLBACK_PREFIX.length,
    );
    try {
      const action = await dependencies.callbacks.consume(token, context.from.id);
      if (action.alreadyConsumed && action.action !== 'participant_recheck') {
        const text = action.giveawayId
          ? `Уже обработано. Текущее состояние: ${(await dependencies.management.getGiveawaySummary(action.giveawayId)).state}.`
          : 'Уже обработано.';
        await context.answerCallbackQuery({ text });
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
        ownConnectionAllowed: dependencies.teamTelegramIds.has(update.from.id),
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
        giveawayId: observed.giveawayId,
        action:
          observed.mode === 'own'
            ? 'confirm_own_channel'
            : 'confirm_external_channel',
        payload: { telegramChatId: update.chat.id },
      });
      await context.api.sendMessage(
        update.from.id,
        `Найден канал «${update.chat.title}» (@${update.chat.username}). Подтвердите подключение.`,
        {
          reply_markup: new InlineKeyboard().text(
            'Подтвердить канал',
            `${observed.mode === 'own' ? ADMIN_CALLBACK_PREFIX : EXTERNAL_CALLBACK_PREFIX}${action.token}`,
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
        payload: { inviteId: connection.requested.inviteId },
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
    await replyStartChannelLink(
      context,
      dependencies,
      summary.title,
      connection.inviteExpiresAt,
    );
  });
}

async function handleParticipantStart(
  context: Context,
  kind: 'join' | 'referral',
  token: string,
  dependencies: GiftBotHandlersDependencies,
) {
  if (!context.from) return;
  await safelyReply(context, async () => {
    const result = await dependencies.participants.joinWithToken({
      kind,
      token,
      user: participantIdentity(context),
    });
    await replyParticipantResult(context, result, dependencies);
  });
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
    case 'participant_recheck': {
      const result = await dependencies.participants.recheck({
        giveawayId: stringPayload(action.payload, 'giveawayId'),
        inviterParticipantId: nullableStringPayload(
          action.payload,
          'inviterParticipantId',
        ),
        user: participantIdentity(context),
      });
      await replyParticipantResult(context, result, dependencies);
      return;
    }
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
      const result = await dependencies.channels.switchExternalInvite({
        inviteId: stringPayload(action.payload, 'inviteId'),
        telegramUserId: actorTelegramId,
      });
      if (result.kind === 'ready') {
        const summary = await dependencies.management.getGiveawaySummary(
          result.context.giveawayId,
        );
        await replyStartChannelLink(
          context,
          dependencies,
          summary.title,
          result.inviteExpiresAt,
        );
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
    case 'confirm_own_channel': {
      if (!dependencies.teamTelegramIds.has(actorTelegramId)) {
        throw new Error('Administrator is no longer allowlisted');
      }
      await dependencies.channels.confirmChannel({
        telegramUserId: actorTelegramId,
        telegramChatId: numberPayload(action.payload, 'telegramChatId'),
        mode: 'own',
      });
      await context.reply('Канал подключён только к этому розыгрышу.');
      const wizard = await dependencies.wizard.findActive(actorTelegramId);
      if (wizard) await replyWizardPrompt(context, wizard, dependencies);
      return;
    }
    case 'confirm_external_channel': {
      await dependencies.channels.confirmChannel({
        telegramUserId: actorTelegramId,
        telegramChatId: numberPayload(action.payload, 'telegramChatId'),
        mode: 'external',
      });
      await context.reply('Канал подключён только к этому розыгрышу.');
      return;
    }
    case 'continue_preview': {
      const wizard = await dependencies.wizard.continueToPreview(actorTelegramId);
      await replyWizardPrompt(context, wizard, dependencies);
      return;
    }
    case 'publish_giveaway': {
      const giveawayId = stringPayload(action.payload, 'giveawayId');
      try {
        const result = await dependencies.publication.publish(giveawayId);
        if (result.kind === 'failed') {
          const persisted = (await dependencies.management.listGiveaways(actorTelegramId))
            .find((giveaway) => giveaway.id === giveawayId);
          await context.reply(
            persisted?.failure
              ? formatPublicationDiagnostic({
                  giveawayId,
                  diagnostic: persisted.failure,
                })
              : publicationResultText(result),
          );
        } else {
          await context.reply(publicationResultText(result));
        }
      } catch (error) {
        if (error instanceof PublicationFailureError) {
          await context.reply(formatPublicationDiagnostic({
            giveawayId,
            diagnostic: error.diagnostic,
          }));
          return;
        }
        throw error;
      }
      return;
    }
    case 'request_cancel_giveaway': {
      const giveawayId = stringPayload(action.payload, 'giveawayId');
      const giveaway = await dependencies.management.getGiveawaySummary(
        giveawayId,
      );
      await replyCancellationConfirmation(
        context,
        {
          kind: 'giveaway',
          giveawayId,
          title: giveaway.title,
          state: giveaway.state as 'draft' | 'active' | 'failed',
        },
        dependencies,
      );
      return;
    }
    case 'request_cancel_wizard':
      await replyCancellationConfirmation(
        context,
        { kind: 'wizard' },
        dependencies,
      );
      return;
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

async function replyParticipantResult(
  context: Context,
  result: ParticipantRegistrationResult,
  dependencies: GiftBotHandlersDependencies,
): Promise<void> {
  if (result.kind === 'unavailable') {
    await context.reply('Этот розыгрыш недоступен для участия.');
    return;
  }
  if (result.kind === 'registered') {
    const lines = [
      result.created
        ? `Вы зарегистрированы в розыгрыше «${result.title}».`
        : `Вы уже зарегистрированы в розыгрыше «${result.title}».`,
      `Зарегистрировано участников: ${result.participantCount}.`,
    ];
    let keyboard: InlineKeyboard | undefined;
    if (result.referralUrl) {
      lines.push(
        `Прямых рефералов: ${result.directReferralCount}. Билетов по текущему прогрессу: ${result.ticketCount}.`,
        `Прогресс до следующего билета: ${result.directReferralCount % 3}/3.`,
      );
      keyboard = new InlineKeyboard().url(
        'Моя реферальная ссылка',
        result.referralUrl,
      );
    }
    await context.reply(lines.join('\n'), {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return;
  }

  const retryData = await issueParticipantRecheck(
    dependencies,
    context.from!.id,
    result.giveawayId,
    result.inviterParticipantId,
  );
  if (result.kind === 'missing_memberships') {
    const keyboard = new InlineKeyboard();
    for (const channel of result.channels) {
      keyboard
        .url(`Подписаться @${channel.username}`, `https://t.me/${channel.username}`)
        .row();
    }
    keyboard.text('Проверить подписку', retryData);
    await context.reply(
      'Подпишитесь на все каналы розыгрыша и затем повторите проверку.',
      { reply_markup: keyboard },
    );
    return;
  }

  const wait =
    result.retryAfterMs === null
      ? ''
      : ` Telegram рекомендует подождать ${Math.ceil(result.retryAfterMs / 1000)} сек.`;
  await context.reply(
    `Не удалось подтвердить условия участия.${wait} Попробуйте ещё раз.`,
    {
      reply_markup: new InlineKeyboard().text(
        'Проверить ещё раз',
        retryData,
      ),
    },
  );
}

async function issueParticipantRecheck(
  dependencies: GiftBotHandlersDependencies,
  actorTelegramId: number,
  giveawayId: string,
  inviterParticipantId: string | null,
): Promise<string> {
  const action = await dependencies.callbacks.issue({
    actorTelegramId,
    giveawayId,
    action: 'participant_recheck',
    payload: { giveawayId, inviterParticipantId },
  });
  return `${PARTICIPANT_CALLBACK_PREFIX}${action.token}`;
}

function participantIdentity(context: Context) {
  const from = context.from;
  if (!from) throw new Error('Participant identity is unavailable');
  return {
    telegramUserId: from.id,
    username: from.username ?? null,
    displayName: [from.first_name, from.last_name]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(' '),
  };
}

type CancellationSelection = Awaited<
  ReturnType<GiveawayManagementService['listCancellationTargets']>
>[number];

async function issueCancellationSelection(
  dependencies: GiftBotHandlersDependencies,
  actorTelegramId: number,
  target: CancellationSelection,
) {
  const action = await dependencies.callbacks.issue({
    actorTelegramId,
    giveawayId: target.kind === 'giveaway' ? target.giveawayId : null,
    action:
      target.kind === 'giveaway'
        ? 'request_cancel_giveaway'
        : 'request_cancel_wizard',
    payload:
      target.kind === 'giveaway' ? { giveawayId: target.giveawayId } : {},
  });
  return `${ADMIN_CALLBACK_PREFIX}${action.token}`;
}

async function replyCancellationConfirmation(
  context: Context,
  target: CancellationSelection,
  dependencies: GiftBotHandlersDependencies,
) {
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
  inviteExpiresAt?: number | null,
) {
  await context.reply(
    `${giveawayTitle ? `Розыгрыш «${giveawayTitle}». ` : ''}${inviteExpiresAt !== undefined && inviteExpiresAt !== null ? `Приглашение истекает ${new Date(inviteExpiresAt).toISOString()}. ` : ''}Добавьте бота администратором публичного канала с правами публикации, редактирования и удаления.`,
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
        });
      } else {
        await context.reply(rendered);
      }
      await context.reply(
        `Каналы:\n${channelList}\n\nПосле запуска условия нельзя изменить.`,
        { reply_markup: replyMarkup },
      );
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

function nullableStringPayload(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  if (value === null) return null;
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
  const synchronization = {
    up_to_date: 'актуально',
    pending: 'ожидает синхронизации',
    processing: 'синхронизируется',
  }[item.synchronizationState];
  const warnings = item.warnings
    .map(
      (warning) =>
        `⚠️ Бот не администратор @${warning.username} («${warning.title}»).`,
    )
    .join('\n');
  return [
    `${item.title} — ${item.state}`,
    `Участников: ${item.participantCount}`,
    `Рефералы: ${item.referralsEnabled ? 'включены' : 'выключены'}`,
    `Синхронизация: ${synchronization}`,
    warnings,
    item.failure
      ? formatPublicationDiagnostic({ giveawayId: item.id, diagnostic: item.failure })
      : '',
  ]
    .filter(Boolean)
    .join('\n');
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
