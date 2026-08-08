export type SafeLogger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export function createJsonLogger(
  configuredLevel: string,
  write: (line: string) => void = console.log,
): SafeLogger {
  const minimum = configuredLevel === 'error' ? 1 : 0;
  const log = (
    level: 'info' | 'error',
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    if (level === 'info' && minimum > 0) return;
    write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...redact(fields),
      }),
    );
  };
  return {
    info: (event, fields) => log('info', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      /token|authorization|payload/i.test(key) ? '[REDACTED]' : value,
    ]),
  );
}
