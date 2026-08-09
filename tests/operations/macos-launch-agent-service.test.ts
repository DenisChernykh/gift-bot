import { describe, expect, it } from 'vitest';

import {
  MAX_LOG_TAIL_BYTES,
  MacosLaunchAgentService,
  type LaunchAgentHost,
} from '../../src/operations/macos-launch-agent-service.js';
import { resolveLaunchAgentPaths } from '../../src/operations/macos-launch-agent-plist.js';

const paths = resolveLaunchAgentPaths({
  homeDirectory: '/Users/tatiana',
  repoRoot: '/Users/tatiana/projects/gift-bot',
  nodePath: '/opt/node/bin/node',
  temporaryFileSuffix: 'service-fixture',
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
  lintReject?: boolean;
  writeErrorCode?: string;
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
      if (options.writeErrorCode) {
        throw Object.assign(new Error('partial write failed'), {
          code: options.writeErrorCode,
        });
      }
    },
    link: async (from, to) => {
      events.push(`link:${from}:${to}`);
      if (options.linkErrorCode) {
        if (options.linkErrorCode === 'EEXIST') {
          files.set(to, 'concurrent plist bytes');
        }
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
        if (options.lintReject) throw new Error('plutil spawn rejected');
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
    readTail: async () => '',
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
    /^(mkdir|writeExclusive|link|unlink):|^run:launchctl:(bootstrap|bootout)(?: |:)/.test(
      event,
    ),
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
    expect(events.some((event) => event.includes('launchctl:bootstrap'))).toBe(
      false,
    );
    expect(events.some((event) => event.includes('launchctl:bootout'))).toBe(
      false,
    );
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

  it('cleans its unique temporary file when plutil spawning rejects', async () => {
    const { service, files } = fixture({ lintReject: true });

    await expect(service.install()).rejects.toThrow();

    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(files.has(paths.plistPath)).toBe(false);
  });

  it('cleans a partially created unique temporary file after a write failure', async () => {
    const { service, files } = fixture({ writeErrorCode: 'EIO' });

    await expect(service.install()).rejects.toThrow();

    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(files.has(paths.plistPath)).toBe(false);
  });

  it('does not overwrite a plist created concurrently during publication', async () => {
    const { service, events, files } = fixture({ linkErrorCode: 'EEXIST' });

    await expect(service.install()).rejects.toThrow('already installed');

    expect(files.has(paths.temporaryPlistPath)).toBe(false);
    expect(files.get(paths.plistPath)).toBe('concurrent plist bytes');
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

function lifecycleFixture(options: {
  installed?: boolean;
  loaded?: boolean;
  bootoutCompletion?: Promise<void>;
  bootoutExitCode?: number;
} = {}) {
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
      if (command === 'launchctl' && args[0] === 'bootout') {
        if (args.includes('--wait')) await options.bootoutCompletion;
        if ((options.bootoutExitCode ?? 0) === 0) loaded = false;
        return {
          exitCode: options.bootoutExitCode ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    verifyBotUsername: async () => 'strelchuk_giveaways_bot',
    readTail: async (path, maximumBytes) => {
      events.push(`readTail:${path}:${maximumBytes}`);
      const value = logs.get(path);
      if (value === undefined) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return Buffer.from(value).subarray(-maximumBytes).toString('utf8');
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

    await expect(service.stop()).resolves.toBe('stopped');
    expect(isLoaded()).toBe(false);
    expect(events.at(-1)).toBe(
      'run:launchctl:bootout --wait gui/501/ru.strelchuk.giveaways-bot',
    );

    await expect(service.start()).resolves.toBe('started');
    expect(isLoaded()).toBe(true);
    expect(events.at(-1)).toBe(
      `run:launchctl:bootstrap gui/501 ${paths.plistPath}`,
    );
  });

  it('keeps repeated start and stop idempotent', async () => {
    const { service, events } = lifecycleFixture();

    await expect(service.start()).resolves.toBe('started');
    await expect(service.start()).resolves.toBe('already_loaded');
    await expect(service.stop()).resolves.toBe('stopped');
    await expect(service.stop()).resolves.toBe('already_absent');

    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(1);
    expect(events.filter((event) => event.includes(':bootout '))).toHaveLength(1);
  });

  it('waits for delayed bootout completion before restart bootstraps again', async () => {
    let completeBootout!: () => void;
    const bootoutCompletion = new Promise<void>((resolve) => {
      completeBootout = resolve;
    });
    const { service, events, isLoaded } = lifecycleFixture({
      loaded: true,
      bootoutCompletion,
    });
    let settled = false;
    const restart = service.restart().then((state) => {
      settled = true;
      return state;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(events).toContain(
      'run:launchctl:bootout --wait gui/501/ru.strelchuk.giveaways-bot',
    );
    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(0);

    completeBootout();
    await expect(restart).resolves.toBe('restarted');

    expect(isLoaded()).toBe(true);
    expect(events.filter((event) => event.includes(':bootout '))).toHaveLength(1);
    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(1);
  });

  it('does not bootstrap when waiting for bootout fails', async () => {
    const { service, events, isLoaded } = lifecycleFixture({
      loaded: true,
      bootoutExitCode: 5,
    });

    await expect(service.restart()).rejects.toThrow('launchctl bootout failed');

    expect(isLoaded()).toBe(true);
    expect(events).toContain(
      'run:launchctl:bootout --wait gui/501/ru.strelchuk.giveaways-bot',
    );
    expect(events.filter((event) => event.includes(':bootstrap '))).toHaveLength(0);
  });

  it('uninstalls only the service registration and plist', async () => {
    const { service, events, files } = lifecycleFixture({ loaded: true });

    await expect(service.uninstall()).resolves.toBe('uninstalled');

    expect(events).toContain(
      'run:launchctl:bootout --wait gui/501/ru.strelchuk.giveaways-bot',
    );
    expect(events.filter((event) => event.startsWith('unlink:'))).toEqual([
      `unlink:${paths.plistPath}`,
    ]);
    expect(files.has(paths.plistPath)).toBe(false);
    expect(events.join('\n')).not.toContain('production.env');
    expect(events.join('\n')).not.toContain('gift-bot.sqlite');
  });

  it('keeps the plist when waiting for bootout fails during uninstall', async () => {
    const { service, events, files } = lifecycleFixture({
      loaded: true,
      bootoutExitCode: 5,
    });

    await expect(service.uninstall()).rejects.toThrow('launchctl bootout failed');

    expect(files.has(paths.plistPath)).toBe(true);
    expect(events.filter((event) => event.startsWith('unlink:'))).toHaveLength(0);
  });

  it('returns status, paths and byte-bounded log tails without parsing launchctl output', async () => {
    const { service, events, logs } = lifecycleFixture({ loaded: true });
    logs.set(
      paths.stdoutPath,
      `${'x'.repeat(MAX_LOG_TAIL_BYTES * 2)}\n${Array.from(
        { length: 120 },
        (_, index) => `stdout:${index + 1}`,
      ).join('\n')}`,
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
    expect(result.stdoutPath).toBe(paths.stdoutPath);
    expect(result.stderrPath).toBe(paths.stderrPath);
    expect(result.stdout.split('\n')).toHaveLength(100);
    expect(result.stdout).toContain('stdout:21');
    expect(result.stdout).toContain('stdout:120');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      MAX_LOG_TAIL_BYTES,
    );
    expect(result.stderr).toBe('');
    expect(events).toContain(
      `readTail:${paths.stdoutPath}:${MAX_LOG_TAIL_BYTES}`,
    );
  });

  it('reports already_absent when repeated uninstall has nothing to remove', async () => {
    const { service } = lifecycleFixture({ installed: false, loaded: false });

    await expect(service.uninstall()).resolves.toBe('already_absent');
    await expect(service.uninstall()).resolves.toBe('already_absent');
  });

  it('refuses to start without an installed plist', async () => {
    const { service, events } = lifecycleFixture({ installed: false });

    await expect(service.start()).rejects.toThrow('plist is not installed');

    expect(events).toEqual([]);
  });
});
