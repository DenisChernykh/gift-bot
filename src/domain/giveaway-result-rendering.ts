import type { GiveawayMessageEntity } from './giveaway-validation.js';

type ResultParticipant = {
  telegramUserId: number;
  username: string | null;
  displayName: string;
};

export function renderGiveawayResult(input: {
  title: string;
  kind: 'text' | 'photo';
  eligibleParticipantCount: number;
  places: Array<{
    placeNumber: number;
    participant: ResultParticipant | null;
  }>;
}): { text: string; entities: GiveawayMessageEntity[] } {
  const lines = [input.title, '', 'Итоги:'];
  if (input.eligibleParticipantCount === 0) {
    lines.push('Подходящих участников нет.');
  }
  const linkedNames: Array<{ marker: string; participant: ResultParticipant }> = [];
  for (const place of input.places) {
    if (!place.participant) {
      lines.push(`${place.placeNumber}. Место не заполнено`);
      continue;
    }
    if (place.participant.username) {
      lines.push(`${place.placeNumber}. @${place.participant.username}`);
      continue;
    }
    const marker = `${place.placeNumber}. ${place.participant.displayName}`;
    lines.push(marker);
    linkedNames.push({ marker, participant: place.participant });
  }
  const text = lines.join('\n');
  const maximumLength = input.kind === 'text' ? 4096 : 1024;
  if (text.length > maximumLength) {
    throw new Error('Giveaway result exceeds the Telegram length limit');
  }
  const entities: GiveawayMessageEntity[] = linkedNames.map(
    ({ marker, participant }) => ({
      type: 'text_link',
      offset: text.indexOf(marker) + marker.length - participant.displayName.length,
      length: participant.displayName.length,
      url: `tg://user?id=${participant.telegramUserId}`,
    }),
  );
  return { text, entities };
}
