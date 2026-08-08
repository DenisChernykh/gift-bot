const CANCELLED_SUFFIX = '\n\nРозыгрыш отменён.';

export function renderCancelledGiveawayMessage(
  publishedText: string,
  messageKind: 'text' | 'photo',
): string {
  const maximumLength = messageKind === 'text' ? 4096 : 1024;
  const availableOriginalLength = maximumLength - CANCELLED_SUFFIX.length;
  let original = publishedText.slice(0, availableOriginalLength);
  const finalCodeUnit = original.charCodeAt(original.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    original = original.slice(0, -1);
  }
  return `${original}${CANCELLED_SUFFIX}`;
}
