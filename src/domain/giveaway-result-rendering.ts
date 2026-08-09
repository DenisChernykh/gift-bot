import type { GiveawayMessageEntity } from './giveaway-validation.js';

type ResultParticipant = {
  telegramUserId: number;
  username: string | null;
  displayName: string;
};

type ResultLine = {
  text: string;
  link?: {
    offset: number;
    length: number;
    telegramUserId: number;
  };
};

export class GiveawayResultRenderingError extends Error {
  constructor() {
    super('Giveaway result exceeds the Telegram length limit');
    this.name = 'GiveawayResultRenderingError';
  }
}

export function renderGiveawayResult(input: {
  title: string;
  kind: 'text' | 'photo';
  eligibleParticipantCount: number;
  places: Array<{
    placeNumber: number;
    participant: ResultParticipant | null;
  }>;
}): { text: string; entities: GiveawayMessageEntity[] } {
  const maximumLength = input.kind === 'text' ? 4_096 : 1_024;
  let lines = resultLines(input, false);
  let text = lines.map((line) => line.text).join('\n');
  if (text.length > maximumLength) {
    lines = resultLines(input, true);
    text = lines.map((line) => line.text).join('\n');
  }
  if (text.length > maximumLength) {
    throw new GiveawayResultRenderingError();
  }

  const entities: GiveawayMessageEntity[] = [];
  let lineOffset = 0;
  for (const line of lines) {
    if (line.link) {
      entities.push({
        type: 'text_link',
        offset: lineOffset + line.link.offset,
        length: line.link.length,
        url: `tg://user?id=${line.link.telegramUserId}`,
      });
    }
    lineOffset += line.text.length + 1;
  }
  return { text, entities };
}

function resultLines(
  input: Parameters<typeof renderGiveawayResult>[0],
  compact: boolean,
): ResultLine[] {
  const lines: ResultLine[] = [
    { text: input.title },
    { text: '' },
    { text: 'Итоги:' },
  ];
  if (input.eligibleParticipantCount === 0) {
    lines.push({ text: 'Подходящих участников нет.' });
  }
  for (const place of input.places) {
    if (!place.participant) {
      lines.push({ text: `${place.placeNumber}. Место не заполнено` });
      continue;
    }
    const prefix = `${place.placeNumber}. `;
    const preferredLabel = place.participant.username
      ? `@${place.participant.username}`
      : place.participant.displayName;
    const label = compact ? 'Участник' : preferredLabel;
    const shouldLink = compact || !place.participant.username;
    lines.push({
      text: `${prefix}${label}`,
      ...(shouldLink
        ? {
            link: {
              offset: prefix.length,
              length: label.length,
              telegramUserId: place.participant.telegramUserId,
            },
          }
        : {}),
    });
  }
  return lines;
}
