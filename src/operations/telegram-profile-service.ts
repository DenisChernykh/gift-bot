import type { InputFile } from 'grammy';
import type {
  BotCommand,
  BotCommandScope,
  InputProfilePhoto,
} from 'grammy/types';

import {
  DEFAULT_BOT_COMMANDS,
  OPERATOR_BOT_COMMANDS,
  PRODUCTION_BOT_PROFILE,
  PRODUCTION_BOT_USERNAME,
} from '../telegram/production-bot-profile.js';

export type ProductionProfileApi = {
  getMe(): Promise<{ username: string }>;
  setMyName(name: string): Promise<true>;
  setMyDescription(description: string): Promise<true>;
  setMyShortDescription(shortDescription: string): Promise<true>;
  setMyCommands(
    commands: readonly BotCommand[],
    options: { scope: BotCommandScope },
  ): Promise<true>;
  setMyProfilePhoto(photo: InputProfilePhoto): Promise<true>;
};

export type ProfileStep =
  | 'name'
  | 'description'
  | 'short_description'
  | 'default_commands'
  | 'operator_commands'
  | 'profile_photo';

export class ProfileStepError extends Error {
  constructor(readonly step: ProfileStep, cause: unknown) {
    super(`Production bot profile failed at ${step}`, { cause });
    this.name = 'ProfileStepError';
  }
}

export async function applyProductionBotProfile(input: {
  api: ProductionProfileApi;
  operatorTelegramIds: readonly number[];
  avatar: InputFile;
  onStep?: (step: ProfileStep) => void;
}): Promise<void> {
  const me = await input.api.getMe();
  if (me.username !== PRODUCTION_BOT_USERNAME) {
    throw new Error(`Refusing to configure @${me.username}`);
  }

  const run = async (
    step: ProfileStep,
    operation: () => Promise<true>,
  ): Promise<void> => {
    try {
      await operation();
      input.onStep?.(step);
    } catch (error) {
      throw new ProfileStepError(step, error);
    }
  };

  await run('name', () => input.api.setMyName(PRODUCTION_BOT_PROFILE.name));
  await run('description', () =>
    input.api.setMyDescription(PRODUCTION_BOT_PROFILE.description),
  );
  await run('short_description', () =>
    input.api.setMyShortDescription(PRODUCTION_BOT_PROFILE.shortDescription),
  );
  await run('default_commands', () =>
    input.api.setMyCommands(DEFAULT_BOT_COMMANDS, {
      scope: { type: 'default' },
    }),
  );
  for (const telegramId of input.operatorTelegramIds) {
    await run('operator_commands', () =>
      input.api.setMyCommands(OPERATOR_BOT_COMMANDS, {
        scope: { type: 'chat', chat_id: telegramId },
      }),
    );
  }
  await run('profile_photo', () =>
    input.api.setMyProfilePhoto({ type: 'static', photo: input.avatar }),
  );
}
