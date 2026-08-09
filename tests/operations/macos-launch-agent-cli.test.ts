import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLaunchAgentHost,
  formatLaunchAgentLogs,
  parseLaunchAgentCommand,
  toLaunchAgentCompletion,
  toSafeOperationsFailure,
  writeFileExclusiveAndSync,
} from '../../src/operations/macos-launch-agent-cli.js';
import { MAX_LOG_TAIL_BYTES } from '../../src/operations/macos-launch-agent-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('macOS LaunchAgent CLI', () => {
  it.each([
    'install',
    'start',
    'stop',
    'restart',
    'status',
    'logs',
    'uninstall',
  ] as const)('accepts %s', (command) => {
    expect(parseLaunchAgentCommand([command])).toBe(command);
  });

  it('accepts the separator forwarded by the documented pnpm command', () => {
    expect(parseLaunchAgentCommand(['--', 'status'])).toBe('status');
  });

  it.each([
    { argv: [] },
    { argv: ['install', '--force'] },
    { argv: ['purge'] },
  ])('rejects unsupported arguments $argv', ({ argv }) => {
      expect(() => parseLaunchAgentCommand(argv)).toThrow('Usage:');
  });

  it('does not expose underlying command or token detail', () => {
    const projected = toSafeOperationsFailure(
      new Error('BOT_TOKEN=secret launchctl raw output'),
    );

    expect(projected).toEqual({
      event: 'launch_agent_command_failed',
      errorName: 'Error',
    });
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('formats log contents together with their exact diagnostic paths', () => {
    const output = formatLaunchAgentLogs({
      stdoutPath: '/logs/stdout.log',
      stdout: 'started',
      stderrPath: '/logs/stderr.log',
      stderr: 'failed',
    });

    expect(output).toContain('stdout (/logs/stdout.log):\nstarted');
    expect(output).toContain('stderr (/logs/stderr.log):\nfailed');
  });

  it('projects an idempotent lifecycle outcome into safe structured output', () => {
    expect(toLaunchAgentCompletion('stop', 'already_absent')).toEqual({
      event: 'launch_agent_command_completed',
      command: 'stop',
      label: 'ru.strelchuk.giveaways-bot',
      state: 'already_absent',
    });
  });

  it('binds stat and contents to the originally opened file descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gift-bot-env-handle-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'production.env');
    const originalPath = join(directory, 'original.env');
    await writeFile(path, 'original', { mode: 0o600 });
    const handle = await createLaunchAgentHost().openRead(path);
    await rename(path, originalPath);
    await writeFile(path, 'replacement', { mode: 0o644 });

    const stat = await handle.stat();
    const contents = await handle.readFile();
    await handle.close();

    expect(stat.mode & 0o777).toBe(0o600);
    expect(contents.toString('utf8')).toBe('original');
    await expect(readFile(path, 'utf8')).resolves.toBe('replacement');
  });

  it('creates temporary files exclusively without overwriting existing bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gift-bot-exclusive-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'agent.plist.tmp');
    const host = createLaunchAgentHost();

    await host.writeFileExclusive(path, 'first', 0o600);
    await expect(host.writeFileExclusive(path, 'second', 0o600)).rejects.toMatchObject({
      code: 'EEXIST',
    });

    await expect(readFile(path, 'utf8')).resolves.toBe('first');
  });

  it('reads only the bounded suffix of a large log file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gift-bot-log-tail-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'stdout.log');
    await writeFile(
      path,
      `${'old'.repeat(MAX_LOG_TAIL_BYTES)}${'z'.repeat(MAX_LOG_TAIL_BYTES)}`,
    );

    const result = await createLaunchAgentHost().readTail(
      path,
      MAX_LOG_TAIL_BYTES,
    );

    expect(Buffer.byteLength(result)).toBe(MAX_LOG_TAIL_BYTES);
    expect(result).toBe('z'.repeat(MAX_LOG_TAIL_BYTES));
  });

  it('removes an exclusively created temp file when writing fails', async () => {
    const events: string[] = [];
    const failure = new Error('disk write failed');

    await expect(
      writeFileExclusiveAndSync('/tmp/owned.plist', 'contents', 0o600, {
        openFile: async () => ({
          writeFile: async () => {
            throw failure;
          },
          sync: async () => undefined,
          close: async () => {
            events.push('close');
          },
        }),
        unlinkFile: async (path) => {
          events.push(`unlink:${path}`);
        },
      }),
    ).rejects.toBe(failure);

    expect(events).toEqual(['close', 'unlink:/tmp/owned.plist']);
  });
});
