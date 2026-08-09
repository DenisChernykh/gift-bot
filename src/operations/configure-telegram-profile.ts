import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import 'dotenv/config';
import { Api, InputFile } from 'grammy';

import { parseTeamTelegramIds } from '../config/team-telegram-ids.js';
import { PRODUCTION_AVATAR_JPG_PATH } from '../telegram/production-bot-profile.js';
import {
  applyProductionBotProfile,
  ProfileStepError,
  type ProductionProfileApi,
  type ProfileStep,
} from './telegram-profile-service.js';

type ApplyProfileInput = Parameters<typeof applyProductionBotProfile>[0];

export type ProfileConfigurationDependencies = {
  readAvatar(path: string): Promise<Uint8Array>;
  createApi(token: string): ProductionProfileApi;
  createAvatar(path: string): InputFile;
  applyProfile(input: ApplyProfileInput): Promise<void>;
};

const defaultDependencies: ProfileConfigurationDependencies = {
  readAvatar: readFile,
  createApi: (token) => new Api(token),
  createAvatar: (path) => new InputFile(path),
  applyProfile: applyProductionBotProfile,
};

export function assertStaticJpeg(bytes: Uint8Array): void {
  const valid =
    bytes.length >= 5 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9;
  if (!valid) throw new Error('Production avatar must be a JPG');
}

export function toSafeProfileFailure(error: unknown): {
  event: string;
  errorName: string;
  step?: ProfileStep;
} {
  return {
    event: 'bot_profile_apply_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(error instanceof ProfileStepError ? { step: error.step } : {}),
  };
}

export async function configureTelegramProfile(
  input: {
    botToken: string;
    operatorTelegramIds: readonly number[];
    onStep?: (step: ProfileStep) => void;
  },
  dependencies: ProfileConfigurationDependencies = defaultDependencies,
): Promise<void> {
  const avatarBytes = await dependencies.readAvatar(PRODUCTION_AVATAR_JPG_PATH);
  assertStaticJpeg(avatarBytes);

  await dependencies.applyProfile({
    api: dependencies.createApi(input.botToken),
    operatorTelegramIds: input.operatorTelegramIds,
    avatar: dependencies.createAvatar(PRODUCTION_AVATAR_JPG_PATH),
    ...(input.onStep ? { onStep: input.onStep } : {}),
  });
}

async function main(): Promise<void> {
  const botToken = requiredEnvironment('BOT_TOKEN');
  const operatorTelegramIds = parseTeamTelegramIds(
    requiredEnvironment('TEAM_TELEGRAM_IDS'),
  );

  await configureTelegramProfile({
    botToken,
    operatorTelegramIds,
    onStep: (step) =>
      console.log(JSON.stringify({ event: 'bot_profile_step_applied', step })),
  });
  console.log(JSON.stringify({ event: 'bot_profile_applied' }));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(JSON.stringify(toSafeProfileFailure(error)));
    process.exitCode = 1;
  });
}
