import { fromZonedTime } from 'date-fns-tz';
import type { MessageEntity } from 'grammy/types';

const MAX_TITLE_LENGTH = 128;
const MAX_TEXT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
const PRODUCT_TIME_ZONE = 'Asia/Yekaterinburg';

export type GiveawayContent =
  | { kind: 'text'; text: string; entities?: GiveawayMessageEntity[] }
  | {
      kind: 'photo';
      caption: string;
      fileId?: string;
      entities?: GiveawayMessageEntity[];
    };

export type GiveawayMessageEntity = MessageEntity;

export function validateGiveawayTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new Error('Giveaway title must be from 1 to 128 characters');
  }

  return title;
}

export function validateWinnerCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('Winner count must be an integer from 1 to 50');
  }

  return value;
}

export function parseGiveawayDeadline(value: string, now: number): number {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Deadline must use DD.MM.YYYY HH:mm format');
  }

  const [, dayValue, monthValue, yearValue, hourValue, minuteValue] = match;
  const day = Number(dayValue);
  const month = Number(monthValue);
  const year = Number(yearValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const localDate = new Date(year, month - 1, day, hour, minute);

  if (
    localDate.getFullYear() !== year ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day ||
    localDate.getHours() !== hour ||
    localDate.getMinutes() !== minute
  ) {
    throw new Error('Deadline must be a real date and time');
  }

  const utcMilliseconds = fromZonedTime(
    `${yearValue}-${monthValue}-${dayValue}T${hourValue}:${minuteValue}:00`,
    PRODUCT_TIME_ZONE,
  ).getTime();
  if (utcMilliseconds <= now) {
    throw new Error('Deadline must be in the future');
  }

  return utcMilliseconds;
}

export function validateGiveawayContent(content: GiveawayContent): GiveawayContent {
  const value = content.kind === 'text' ? content.text.trim() : content.caption.trim();
  const maximumLength = content.kind === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH;

  if (value.length === 0 || value.length > maximumLength) {
    throw new Error('Giveaway content is empty or exceeds Telegram limits');
  }

  return content.kind === 'text'
    ? {
        kind: 'text',
        text: value,
        ...(content.entities ? { entities: content.entities } : {}),
      }
    : {
        kind: 'photo',
        caption: value,
        ...(content.fileId ? { fileId: content.fileId } : {}),
        ...(content.entities ? { entities: content.entities } : {}),
      };
}
