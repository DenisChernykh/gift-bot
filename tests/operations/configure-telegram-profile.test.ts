import { readFile } from 'node:fs/promises';

import { InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';

import {
  assertStaticJpeg,
  configureTelegramProfile,
  toSafeProfileFailure,
  type ProfileConfigurationDependencies,
} from '../../src/operations/configure-telegram-profile.js';
import {
  ProfileStepError,
  type ProductionProfileApi,
} from '../../src/operations/telegram-profile-service.js';
import { PRODUCTION_AVATAR_JPG_PATH } from '../../src/telegram/production-bot-profile.js';

function fakeApi(): ProductionProfileApi {
  return {
    getMe: async () => ({ username: 'strelchuk_giveaways_bot' }),
    setMyName: async () => true,
    setMyDescription: async () => true,
    setMyShortDescription: async () => true,
    setMyCommands: async () => true,
    setMyProfilePhoto: async () => true,
  };
}

describe('configure telegram profile', () => {
  it('accepts the exact checked-in production JPG', async () => {
    const approvedAvatar = await readFile(PRODUCTION_AVATAR_JPG_PATH);

    expect(() => assertStaticJpeg(approvedAvatar)).not.toThrow();
  });

  it('rejects non-JPG and incomplete JPG framing', () => {
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
    ).toThrow('Production avatar must be a JPG');
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])),
    ).toThrow('Production avatar must be a JPG');
  });

  it('blocks profile application when marker-valid JPG bytes are substituted', async () => {
    let apiCreated = false;
    let profileApplied = false;
    const dependencies: ProfileConfigurationDependencies = {
      readAvatar: async () =>
        Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]),
      createApi: () => {
        apiCreated = true;
        return fakeApi();
      },
      applyProfile: async () => {
        profileApplied = true;
      },
    };

    await expect(
      configureTelegramProfile(
        { botToken: 'local-test-token', operatorTelegramIds: [700] },
        dependencies,
      ),
    ).rejects.toThrow('Production avatar must match the approved JPG');

    expect(apiCreated).toBe(false);
    expect(profileApplied).toBe(false);
  });

  it('passes validated local inputs to the guarded profile service', async () => {
    const api = fakeApi();
    const approvedAvatar = await readFile(PRODUCTION_AVATAR_JPG_PATH);
    let received:
      | {
          api: ProductionProfileApi;
          operatorTelegramIds: readonly number[];
          avatar: InputFile;
        }
      | undefined;
    const dependencies: ProfileConfigurationDependencies = {
      readAvatar: async () => approvedAvatar,
      createApi: (token) => {
        expect(token).toBe('local-test-token');
        return api;
      },
      applyProfile: async (input) => {
        received = input;
      },
    };

    await configureTelegramProfile(
      { botToken: 'local-test-token', operatorTelegramIds: [700, 701] },
      dependencies,
    );

    expect(received?.api).toBe(api);
    expect(received?.operatorTelegramIds).toEqual([700, 701]);
    expect(received?.avatar.filename).toBe('strelchuk-giveaways-avatar.jpg');
    expect(await received?.avatar.toRaw()).toBe(approvedAvatar);
  });

  it('projects a remote failure without the raw Telegram detail', () => {
    const error = new ProfileStepError(
      'profile_photo',
      new Error('BOT_TOKEN=secret raw Telegram description'),
    );

    expect(toSafeProfileFailure(error)).toEqual({
      event: 'bot_profile_apply_failed',
      errorName: 'ProfileStepError',
      step: 'profile_photo',
    });
    expect(JSON.stringify(toSafeProfileFailure(error))).not.toContain('secret');
  });
});
