import { fileURLToPath } from 'node:url';

import type { BotCommand } from 'grammy/types';

export const PRODUCTION_BOT_USERNAME = 'strelchuk_giveaways_bot';

export const PRODUCTION_BOT_PROFILE = {
  name: 'Розыгрыши Татьяны Стрельчук',
  shortDescription: 'Официальный бот розыгрышей Татьяны Стрельчук',
  description:
    'Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.',
} as const;

export const DEFAULT_BOT_COMMANDS = [
  { command: 'start', description: 'Открыть бот розыгрышей' },
] as const satisfies readonly BotCommand[];

export const OPERATOR_BOT_COMMANDS = [
  { command: 'start', description: 'Открыть панель управления' },
  { command: 'new', description: 'Создать розыгрыш' },
  { command: 'giveaways', description: 'Мои розыгрыши' },
  { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
] as const satisfies readonly BotCommand[];

export const PRODUCTION_AVATAR_JPG_PATH = fileURLToPath(
  new URL('../../assets/telegram/strelchuk-giveaways-avatar.jpg', import.meta.url),
);
