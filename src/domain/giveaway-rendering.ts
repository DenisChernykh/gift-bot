import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

import type { GiveawayContent } from './giveaway-validation.js';

const PRODUCT_TIME_ZONE = 'Asia/Yekaterinburg';

type GiveawayRenderInput = {
  title: string;
  winnerCount: number;
  deadlineUtc: number;
  referralsEnabled: boolean;
  content: GiveawayContent;
};

type RenderedGiveawayMessage = {
  kind: GiveawayContent['kind'];
  text: string;
};

export function formatGiveawayDeadline(utcMilliseconds: number): string {
  return format(toZonedTime(utcMilliseconds, PRODUCT_TIME_ZONE), 'dd.MM.yyyy HH:mm');
}

export function renderGiveawayMessage(
  input: GiveawayRenderInput,
): RenderedGiveawayMessage {
  const content = input.content.kind === 'text' ? input.content.text : input.content.caption;
  const text = [
    input.title,
    '',
    content,
    '',
    `Победителей: ${input.winnerCount}`,
    `Дедлайн: ${formatGiveawayDeadline(input.deadlineUtc)} (Екатеринбург, UTC+5)`,
    `Рефералы: ${input.referralsEnabled ? 'включены (3 = +1 билет)' : 'выключены'}`,
  ].join('\n');
  const maximumLength = input.content.kind === 'text' ? 4096 : 1024;

  if (text.length > maximumLength) {
    throw new Error('Final giveaway message exceeds the Telegram length limit');
  }

  return { kind: input.content.kind, text };
}
