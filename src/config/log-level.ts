export type LogLevel = 'info' | 'error';

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim() || 'info';
  if (normalized !== 'info' && normalized !== 'error') {
    throw new Error('LOG_LEVEL must be info or error');
  }
  return normalized;
}
