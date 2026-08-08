import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import 'dotenv/config';
import { Bot, GrammyError, HttpError } from 'grammy';

import { CallbackActionService } from './application/callback-action-service.js';
import { ChannelHealthAlertService } from './application/channel-health-alert-service.js';
import { ChannelAuthorizationService } from './application/channel-authorization-service.js';
import { DraftWizardService } from './application/draft-wizard-service.js';
import { GiftBotMaintenanceService } from './application/gift-bot-maintenance-service.js';
import { GiveawayCancellationService } from './application/giveaway-cancellation-service.js';
import { GiveawayManagementService } from './application/giveaway-management-service.js';
import { GiveawayPostSynchronizationService } from './application/giveaway-post-synchronization-service.js';
import { GiveawayPublicationService } from './application/giveaway-publication-service.js';
import { GiveawayRecoveryService } from './application/giveaway-recovery-service.js';
import { ParticipantRegistrationService } from './application/participant-registration-service.js';
import { parseTeamTelegramIds } from './config/team-telegram-ids.js';
import { openDatabase } from './database/client.js';
import { SqliteGiveawayCreationRepository } from './database/giveaway-creation-repository.js';
import { migrateDatabase } from './database/migrate.js';
import { SqliteParticipantRepository } from './database/participant-repository.js';
import { SqlitePostSynchronizationRepository } from './database/post-synchronization-repository.js';
import { GrammyTelegramGateway } from './infrastructure/grammy-telegram-gateway.js';
import {
  GiftBotRuntime,
  InFlightUpdateTracker,
} from './runtime/gift-bot-runtime.js';
import { createJsonLogger } from './runtime/logger.js';
import { registerGiftBotHandlers } from './telegram/gift-bot-adapter.js';

const botToken = requiredEnvironment('BOT_TOKEN');
const databasePath = requiredEnvironment('DATABASE_PATH');
const teamTelegramIds = new Set(
  parseTeamTelegramIds(requiredEnvironment('TEAM_TELEGRAM_IDS')),
);
const logger = createJsonLogger(process.env.LOG_LEVEL ?? 'info');

mkdirSync(dirname(databasePath), { recursive: true });
const opened = openDatabase(databasePath);
await migrateDatabase(opened.database);
const repository = new SqliteGiveawayCreationRepository(opened.database);
const bot = new Bot(botToken);
await bot.init();
const inFlightUpdates = new InFlightUpdateTracker();
bot.use(inFlightUpdates.middleware());
const gateway = new GrammyTelegramGateway(bot.api, bot.botInfo.id);
const participantRepository = new SqliteParticipantRepository(opened.database);
const postSynchronization = new GiveawayPostSynchronizationService(
  new SqlitePostSynchronizationRepository(opened.database),
  gateway,
);
const alerts = new ChannelHealthAlertService(participantRepository, gateway);
const maintenance = new GiftBotMaintenanceService(postSynchronization, alerts);
const wizard = new DraftWizardService(repository);
const channels = new ChannelAuthorizationService(repository);
const callbacks = new CallbackActionService(repository);
const publication = new GiveawayPublicationService(repository, gateway, {
  botUsername: bot.botInfo.username,
  logger,
});
const cancellation = new GiveawayCancellationService(
  repository,
  postSynchronization,
);
const management = new GiveawayManagementService(repository);
const recovery = new GiveawayRecoveryService(repository, gateway, { logger });
const participants = new ParticipantRegistrationService(
  participantRepository,
  gateway,
  { botUsername: bot.botInfo.username },
);

registerGiftBotHandlers(bot, {
  teamTelegramIds,
  botUsername: bot.botInfo.username,
  wizard,
  channels,
  callbacks,
  publication,
  cancellation,
  management,
  participants,
});
bot.catch((failure) => {
  const error = failure.error;
  logger.error('telegram_update_failed', {
    updateId: failure.ctx.update.update_id,
    errorType:
      error instanceof GrammyError
        ? 'telegram_api'
        : error instanceof HttpError
          ? 'telegram_transport'
          : error instanceof Error
            ? error.name
            : 'unknown',
  });
});

const runtime = new GiftBotRuntime(
  {
    start: () =>
      bot.start({
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        onStart: () => logger.info('bot_started'),
      }),
    stop: () => bot.stop(),
  },
  recovery,
  maintenance,
  opened.close,
  { logger, updateDrain: inFlightUpdates },
);

process.once('SIGINT', () => void runtime.stop('SIGINT'));
process.once('SIGTERM', () => void runtime.stop('SIGTERM'));
await runtime.start();

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
