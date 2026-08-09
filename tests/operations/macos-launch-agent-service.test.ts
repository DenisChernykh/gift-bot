import { describe, expect, it } from 'vitest';

import {
  MacosLaunchAgentService,
  type LaunchAgentHost,
} from '../../src/operations/macos-launch-agent-service.js';
import { resolveLaunchAgentPaths } from '../../src/operations/macos-launch-agent-plist.js';

const paths = resolveLaunchAgentPaths({
  homeDirectory: '/Users/tatiana',
  repoRoot: '/Users/tatiana/projects/gift-bot',
  nodePath: '/opt/node/bin/node',
});

const validEnvironment = Buffer.from(
  [
    'BOT_TOKEN=1234567890:secret_test_value',
    'TEAM_TELEGRAM_IDS=465050746',
    `DATABASE_PATH="${paths.databasePath}"`,
    'LOG_LEVEL=info',
    'DRAW_MEMBERSHIP_CONCURRENCY=10',
  ].join('\n'),
);

const packageJson = Buffer.from(
  JSON.stringify({
    engines: { node: '>=24.18.0 <25', pnpm: '>=11.15.1 <12' },
    packageManager: 'pnpm@11.15.1',
  }),
);

function fixture(options: {
  environmentMode?: number;
  username?: string;
  lintExitCode?: number;
  bootstrapExitCode?: number;
  installed?: boolean;
  loaded?: boolean;
  linkErrorCode?: string;
} = {}) {
  const events: string[] = [];
  const files = new Map<string, Buffer | string>([
    [paths.environmentPath, validEnvironment],
    [`${paths.repoRoot}/package.json`, packageJson],
  ]);
  if (options.installed) files.set(paths.plistPath, 'existing plist');

  let nextHandleId = 0;
  const host: LaunchAgentHost = {
    openRead: async (path) => {
      events.push(`open:${path}`);
      const value = files.get(path);
      if (!Buffer.isBuffer(value)) throw new Error('missing fixture file');
      const handle = `env#${++nextHandleId}`;
      return {
        stat: async () => {
          events.push(`fstat:${handle}`);
          return { mode: options.environmentMode ?? 0o100600, uid: 501 };
        },
        readFile: async () => {
          events.push(`read:${handle}`);
          return value;
        },
        close: async () => {
          events.push(`close:${handle}`);
        },
      };
    },
    readFile: async (path) => {
      events.push(`readFile:${path}`);
      const value = files.get(path);
      if (!Buffer.isBuffer(value)) throw new Error('missing fixture file');
      return value;
    },
    exists: async (path) => {
      events.push(`exists:${path}`);
      return files.has(path);
    },
    mkdir: async (path) => {
      events.push(`mkdir:${path}`);
    },
    writeFileExclusive: async (path, contents, mode) => {
      events.push(`writeExclusive:${path}:${mode.toString(8)}`);
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, contents);
    },
    link: async (from, to) => {
      events.push(`link:${from}:${to}`);
      if (options.linkErrorCode) {
        throw Object.assign(new Error('link failed'), {
          code: options.linkErrorCode,
        });
      }
      if (files.has(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const value = files.get(from);
      if (value === undefined) throw new Error('missing link source');
      files.set(to, value);
    },
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      files.delete(path);
    },
    run: async (command, args) => {
      events.push(`run:${command}:${args.join(' ')}`);
      if (command === 'pnpm' && args[0] === '--version') {
        return { exitCode: 0, stdout: '11.15.1\n', stderr: '' };
      }
      if (command === 'plutil') {
        return {
          exitCode: options.lintExitCode ?? 0,
          stdout: '',
          stderr: 'raw lint detail',
        };
      }
      if (command === 'launchctl' && args[0] === 'print') {
        return {
          exitCode: options.loaded ? 0 : 113,
          stdout: '',
          stderr: '',
        };
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        return {
          exitCode: options.bootstrapExitCode ?? 0,
          stdout: '',
          stderr: 'raw bootstrap detail',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    verifyBotUsername: async () => {
      events.push('verifyBotUsername');
      return options.username ?? 'strelchuk_giveaways_bot';
    },
    readText: async () => '',
  };

  return {
    service: new MacosLaunchAgentService({
      host,
      paths,
      uid: 501,
      nodeVersion: '24.18.1',
    }),
    events,
    files,
  };
}

function firstMutation(events: readonly string[]): number {
  return events.findIndex((event) =>
    /^(mkdir|writeExclusive|link|unlink):/.test(event),
  );
}

describe('MacosLaunchAgentService install', () => {
  it('binds permissions and contents to one env handle before the first mutation', async () => {
    const { service, events, files } = fixture();

    await service.install();

    expect(events.slice(0, 5)).toEqual([
      `exists:${paths.plistPath}`,
      `open:${paths.environmentPath}`,
      'fstat:env#1',
      'read:env#1',
      'close:env#1',
    ]);
    expect(events.indexOf('verifyBotUsername')).toBeLessThan(firstMutation(events));
    expect(events).toContain(
      `link:${paths.temporaryPlistPath}:${paths.plistPath}`,
    );
    expect(events).toContain(`unlink:${paths.temporaryPlistPath}`);
    expect(String(files.get(paths.plistPath))).not.toContain('secret_test_value');
    expect(files.has(paths.temporaryPlistPath)).toBe(false);
  });

  it('rejects an existing plist before opening the environment', async () => {
    const { service, events } = fixture({ installed: true });

    await expect(service.install()).rejects.toThrow('already installed');

    expect(events).toEqual([`exists:${paths.plistPath}`]);
  });

  it('closes an unsafe environment handle before any later preflight or mutation', async () => {
    const { service, events } = fixture({ environmentMode: 0o100644 });

    await expect(service.install()).rejects.toThrow('mode 0600');

    expect(events).toEqual([
      `exists:${paths.plistPath}`,
      `open:${paths.environmentPath}`,
      'fstat:env#1',
      'read:env#1',
      'close:env#1',
    ]);
  });

  it('rejects a wrong production bot before filesystem mutation', async () => {
    const { service, events } = fixture({ username: 'different_bot' });

    await expect(service.install()).rejects.toThrow(
      'Expected @strelchuk_giveaways_bot',
    );

    expect(firstMutation(events)).toBe(-1);
    expect(events.join('\n')).not.toContain('secret_test_value');
  });

  it('cleans the exclusive temporary file after failed plist validation', async () => {
    const { service, events, files } = fixture({ lintExitCode: 1 });

    await expect(service.install()).rejects.toThrow('plutil validation failed');

    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(files.has(paths.plistPath)).toBe(false);
    expect(events.some((event) => event.startsWith('link:'))).toBe(false);
    expect(events.join('\n')).not.toContain('raw lint detail');
  });

  it('does not overwrite a plist created concurrently during publication', async () => {
    const { service, events, files } = fixture({ linkErrorCode: 'EEXIST' });

    await expect(service.install()).rejects.toThrow('already installed');

    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(files.has(paths.plistPath)).toBe(false);
    expect(
      events.some(
        (event) => event === `run:launchctl:bootstrap gui/501 ${paths.plistPath}`,
      ),
    ).toBe(false);
  });

  it('keeps the validated final plist when bootstrap fails', async () => {
    const { service, events, files } = fixture({ bootstrapExitCode: 5 });

    await expect(service.install()).rejects.toThrow('launchctl bootstrap failed');

    expect(files.has(paths.plistPath)).toBe(true);
    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(events.join('\n')).not.toContain('raw bootstrap detail');
  });
});

function lifecycleFixture(options: { installed?: boolean; loaded?: boolean } = {}) {
  let loaded = options.loaded ?? false;
  const files = new Set<string>();
  if (options.installed ?? true) files.add(paths.plistPath);
  const events: string[] = [];
  const logs = new Map<string, string>();
  const host: LaunchAgentHost = {
    openRead: async () => {
      throw new Error('not used');
    },
    readFile: async () => {
      throw new Error('not used');
    },
    exists: async (path) => files.has(path),
    mkdir: async () => undefined,
    writeFileExclusive: async () => undefined,
    link: async () => undefined,
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      files.delete(path);
    },
    run: async (command, args) => {
      events.push(`run:${command}:${args.join(' ')}`);
      if (command === 'launchctl' && args[0] === 'print') {
        return { exitCode: loaded ? 0 : 113, stdout: '', stderr: '' };
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') loaded = true;
      if (command === 'launchctl' && args[0] === 'bootout') loaded = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    verifyBotUsername: async () => 'strelchuk_giveaways_bot',
    readText: async (path) => {
      const value = logs.get(path);
      if (value === undefined) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return value;
    },
  };

  return {
    service: new MacosLaunchAgentService({
      host,
      paths,
      uid: 501,
      nodeVersion: '24.18.1',
    }),
    events,
    files,
    logs,
    isLoaded: () => loaded,
  };
}

describe('MacosLaunchAgentService lifecycle', () => {
  it('uses bootout for maintenance stop and bootstrap for start', async () => {
    const { service, events, isLoaded } = lifecycleFixture({ loaded: true });

    await service.stop();
    expect(isLoaded()).toBe(false);
    expect(events.at(-1)).toBe(
      'run:launchctl:bootout gui/501/ru.strelchuk.giveaways-bot',
    );

    await service.start();
    expect(isLoaded()).toBe(true);
    expect(events.at(-1)).toBe(
      `run:launchctl:bootstrap gui/501 ${paths.plistPath}`,
    );
  });

  it('keeps repeated start and stop idempotent', async () => {
    const { service, events } = lifecycleFixture();

    await service.start();
    await service.start();
    await service.stop();
    await service.stop();

    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(1);
    expect(events.filter((event) => event.includes(':bootout '))).toHaveLength(1);
  });

  it('restarts through an explicit bootout and bootstrap pair', async () => {
    const { service, events, isLoaded } = lifecycleFixture({ loaded: true });

    await service.restart();

    expect(isLoaded()).toBe(true);
    expect(events.filter((event) => event.includes(':bootout '))).toHaveLength(1);
    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(1);
  });

  it('uninstalls only the service registration and plist', async () => {
    const { service, events, files } = lifecycleFixture({ loaded: true });

    await service.uninstall();

    expect(events).toContain(
      'run:launchctl:bootout gui/501/ru.strelchuk.giveaways-bot',
    );
    expect(events.filter((event) => event.startsWith('unlink:'))).toEqual([
      `unlink:${paths.plistPath}`,
    ]);
    expect(files.has(paths.plistPath)).toBe(false);
    expect(events.join('\n')).not.toContain('production.env');
    expect(events.join('\n')).not.toContain('gift-bot.sqlite');
  });

  it('returns status and bounded log tails without parsing launchctl output', async () => {
    const { service, logs } = lifecycleFixture({ loaded: true });
    logs.set(
      paths.stdoutPath,
      Array.from({ length: 120 }, (_, index) => `stdout:${index + 1}`).join('\n'),
    );

    await expect(service.status()).resolves.toEqual({
      loaded: true,
      label: 'ru.strelchuk.giveaways-bot',
      plistPath: paths.plistPath,
      environmentPath: paths.environmentPath,
      databasePath: paths.databasePath,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
    });
    const result = await service.logs();
    expect(result.stdout.split('\n')).toHaveLength(100);
    expect(result.stdout).toContain('stdout:21');
    expect(result.stdout).toContain('stdout:120');
    expect(result.stderr).toBe('');
  });

  it('refuses to start without an installed plist', async () => {
    const { service, events } = lifecycleFixture({ installed: false });

    await expect(service.start()).rejects.toThrow('plist is not installed');

    expect(events).toEqual([]);
  });
});
