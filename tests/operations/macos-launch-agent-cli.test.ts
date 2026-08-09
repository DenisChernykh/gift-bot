import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLaunchAgentHost,
  parseLaunchAgentCommand,
  toSafeOperationsFailure,
} from '../../src/operations/macos-launch-agent-cli.js';

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
});
