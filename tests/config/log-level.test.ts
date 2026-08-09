import { describe, expect, it } from 'vitest';

import { parseLogLevel } from '../../src/config/log-level.js';
import { createJsonLogger } from '../../src/runtime/logger.js';

describe('log level configuration', () => {
  it.each([
    { input: undefined, expected: 'info' },
    { input: 'info', expected: 'info' },
    { input: ' error ', expected: 'error' },
  ] as const)('normalizes $input to $expected', ({ input, expected }) => {
    expect(parseLogLevel(input)).toBe(expected);
  });

  it('rejects unsupported values', () => {
    expect(() => parseLogLevel('debug')).toThrow('LOG_LEVEL');
  });

  it('keeps a whitespace-wrapped error level authoritative at runtime', () => {
    const lines: string[] = [];
    const logger = createJsonLogger(parseLogLevel(' error '), (line) =>
      lines.push(line),
    );

    logger.info('must_be_suppressed');
    logger.error('must_be_emitted');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'error',
      event: 'must_be_emitted',
    });
  });
});
