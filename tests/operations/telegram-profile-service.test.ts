import { InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';

import {
  applyProductionBotProfile,
  ProfileStepError,
  type ProductionProfileApi,
  type ProfileStep,
} from '../../src/operations/telegram-profile-service.js';

type RecordedCall = {
  name: string;
  payload?: unknown;
};

function fakeApi(username: string, failAt?: string) {
  const calls: RecordedCall[] = [];
  const call = async (name: string, payload?: unknown): Promise<true> => {
    calls.push({ name, payload });
    if (name === failAt) throw new Error('raw remote detail');
    return true;
  };
  const api: ProductionProfileApi = {
    getMe: async () => {
      calls.push({ name: 'getMe' });
      return { username };
    },
    setMyName: async (name) => call('setMyName', name),
    setMyDescription: async (description) =>
      call('setMyDescription', description),
    setMyShortDescription: async (shortDescription) =>
      call('setMyShortDescription', shortDescription),
    setMyCommands: async (commands, options) =>
      call('setMyCommands', { commands, options }),
    setMyProfilePhoto: async (photo) => call('setMyProfilePhoto', photo),
  };
  return { api, calls };
}

describe('applyProductionBotProfile', () => {
  it('performs no write when getMe returns the smoke username', async () => {
    const { api, calls } = fakeApi('gift_epic1_smoke_20260808_bot');

    await expect(
      applyProductionBotProfile({
        api,
        operatorTelegramIds: [465050746],
        avatar: new InputFile(new Uint8Array([1])),
      }),
    ).rejects.toThrow('Refusing to configure @gift_epic1_smoke_20260808_bot');

    expect(calls).toEqual([{ name: 'getMe' }]);
  });

  it('applies exact profile payloads in deterministic order', async () => {
    const { api, calls } = fakeApi('strelchuk_giveaways_bot');
    const avatar = new InputFile(new Uint8Array([1]));
    const completedSteps: ProfileStep[] = [];

    await applyProductionBotProfile({
      api,
      operatorTelegramIds: [700, 701],
      avatar,
      onStep: (step) => completedSteps.push(step),
    });

    expect(calls.map(({ name }) => name)).toEqual([
      'getMe',
      'setMyName',
      'setMyDescription',
      'setMyShortDescription',
      'setMyCommands',
      'setMyCommands',
      'setMyCommands',
      'setMyProfilePhoto',
    ]);
    expect(calls.slice(1, 4).map(({ payload }) => payload)).toEqual([
      'Розыгрыши Татьяны Стрельчук',
      'Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.',
      'Официальный бот розыгрышей Татьяны Стрельчук',
    ]);
    expect(calls.slice(4, 7).map(({ payload }) => payload)).toEqual([
      {
        commands: [{ command: 'start', description: 'Открыть бот розыгрышей' }],
        options: { scope: { type: 'default' } },
      },
      {
        commands: [
          { command: 'start', description: 'Открыть панель управления' },
          { command: 'new', description: 'Создать розыгрыш' },
          { command: 'giveaways', description: 'Мои розыгрыши' },
          { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
        ],
        options: { scope: { type: 'chat', chat_id: 700 } },
      },
      {
        commands: [
          { command: 'start', description: 'Открыть панель управления' },
          { command: 'new', description: 'Создать розыгрыш' },
          { command: 'giveaways', description: 'Мои розыгрыши' },
          { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
        ],
        options: { scope: { type: 'chat', chat_id: 701 } },
      },
    ]);
    expect(calls[7]!.payload).toEqual({ type: 'static', photo: avatar });
    expect(completedSteps).toEqual([
      'name',
      'description',
      'short_description',
      'default_commands',
      'operator_commands',
      'operator_commands',
      'profile_photo',
    ]);
  });

  it('names the failed remote step and stops later writes', async () => {
    const { api, calls } = fakeApi(
      'strelchuk_giveaways_bot',
      'setMyDescription',
    );

    await expect(
      applyProductionBotProfile({
        api,
        operatorTelegramIds: [700],
        avatar: new InputFile(new Uint8Array([1])),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProfileStepError>>({
        name: 'ProfileStepError',
        step: 'description',
      }),
    );
    expect(calls.map(({ name }) => name)).toEqual([
      'getMe',
      'setMyName',
      'setMyDescription',
    ]);
  });
});
