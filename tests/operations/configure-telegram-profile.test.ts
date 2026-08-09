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
  it('accepts only complete JPG framing', () => {
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])),
    ).not.toThrow();
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
    ).toThrow('Production avatar must be a JPG');
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])),
    ).toThrow('Production avatar must be a JPG');
  });

  it('blocks profile application when the local avatar is invalid', async () => {
    let apiCreated = false;
    let profileApplied = false;
    const dependencies: ProfileConfigurationDependencies = {
      readAvatar: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      createApi: () => {
        apiCreated = true;
        return fakeApi();
      },
      createAvatar: () => new InputFile(new Uint8Array([1])),
      applyProfile: async () => {
        profileApplied = true;
      },
    };

    await expect(
      configureTelegramProfile(
        { botToken: 'local-test-token', operatorTelegramIds: [700] },
        dependencies,
      ),
    ).rejects.toThrow('Production avatar must be a JPG');

    expect(apiCreated).toBe(false);
    expect(profileApplied).toBe(false);
  });

  it('passes validated local inputs to the guarded profile service', async () => {
    const api = fakeApi();
    const avatar = new InputFile(new Uint8Array([1]));
    let received:
      | {
          api: ProductionProfileApi;
          operatorTelegramIds: readonly number[];
          avatar: InputFile;
        }
      | undefined;
    const dependencies: ProfileConfigurationDependencies = {
      readAvatar: async () =>
        Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]),
      createApi: (token) => {
        expect(token).toBe('local-test-token');
        return api;
      },
      createAvatar: () => avatar,
      applyProfile: async (input) => {
        received = input;
      },
    };

    await configureTelegramProfile(
      { botToken: 'local-test-token', operatorTelegramIds: [700, 701] },
      dependencies,
    );

    expect(received).toEqual({
      api,
      operatorTelegramIds: [700, 701],
      avatar,
    });
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
