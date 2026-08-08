export function parseTeamTelegramIds(value: string): number[] {
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!/^\d+$/.test(item)) {
        throw new Error('TEAM_TELEGRAM_IDS must contain only numeric Telegram IDs');
      }

      const id = Number(item);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error('TEAM_TELEGRAM_IDS must contain safe positive Telegram IDs');
      }

      return id;
    });

  return [...new Set(ids)];
}
