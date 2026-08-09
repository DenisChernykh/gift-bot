import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_COMMANDS,
  OPERATOR_BOT_COMMANDS,
  PRODUCTION_AVATAR_JPG_PATH,
  PRODUCTION_BOT_PROFILE,
  PRODUCTION_BOT_USERNAME,
} from '../../src/telegram/production-bot-profile.js';

describe('production bot profile', () => {
  it('keeps the approved identity and role-specific command menus exact', () => {
    expect(PRODUCTION_BOT_USERNAME).toBe('strelchuk_giveaways_bot');
    expect(PRODUCTION_BOT_PROFILE).toEqual({
      name: 'Розыгрыши Татьяны Стрельчук',
      shortDescription: 'Официальный бот розыгрышей Татьяны Стрельчук',
      description:
        'Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.',
    });
    expect(DEFAULT_BOT_COMMANDS).toEqual([
      { command: 'start', description: 'Открыть бот розыгрышей' },
    ]);
    expect(OPERATOR_BOT_COMMANDS).toEqual([
      { command: 'start', description: 'Открыть панель управления' },
      { command: 'new', description: 'Создать розыгрыш' },
      { command: 'giveaways', description: 'Мои розыгрыши' },
      { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
    ]);
  });

  it('ships a real JPG upload asset instead of a runtime substitute', async () => {
    const bytes = await readFile(PRODUCTION_AVATAR_JPG_PATH);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });
});
