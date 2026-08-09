# Epic 5 macOS LaunchAgent Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the compiled production bot as a safe per-user macOS LaunchAgent with guarded installation, explicit lifecycle commands, separated state/logs, and no secrets in the plist or process arguments.

**Architecture:** A pure plist/path module and pure production-config/runtime validators feed an operations service with injected filesystem, command-runner and bot-identity ports. The CLI supplies real Node/macOS adapters, while tests use an isolated fake host and never mutate `~/Library/LaunchAgents`. The LaunchAgent starts only the existing `dist/index.js`; Epic 3 remains the sole owner of missed-deadline and synchronization recovery.

**Tech Stack:** TypeScript 5.9, Node.js `>=24.18.0 <25`, pnpm `>=11.15.1 <12`, grammY 1.45, dotenv 17, Vitest 4, macOS `launchd`, `launchctl`, `plutil`, SQLite.

## Global Constraints

- Implement only [Epic 5](../../epics/05-macos-launch-agent-operations.md); Telegram profile and copy belong to Epic 4.
- Epic 4 must already export `PRODUCTION_BOT_USERNAME = 'strelchuk_giveaways_bot'` before this plan executes.
- LaunchAgent label is exactly `ru.strelchuk.giveaways-bot` in `gui/<uid>`; do not create a LaunchDaemon or use `sudo`.
- Production env is `~/Library/Application Support/StrelchukGiveawaysBot/production.env` with owner-only permissions.
- Production SQLite is `~/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite` and must be outside the checkout.
- Logs are `~/Library/Logs/StrelchukGiveawaysBot/stdout.log` and `stderr.log`.
- The plist may contain `DOTENV_CONFIG_PATH`, but never `BOT_TOKEN`, `TEAM_TELEGRAM_IDS`, or other secret values.
- Use modern `launchctl bootstrap`, `bootout`, and `print`; never use legacy `load` or `unload`.
- `stop` and `uninstall` must preserve production env, SQLite and logs; do not add a purge command.
- Do not discover, kill or rewrite arbitrary user processes. Report the one-process prerequisite instead.
- Do not run a real install/start/stop/uninstall until the user explicitly authorizes mutation of the Mac LaunchAgent state.
- Preserve inherited `PATH`; invoke package-manager operations as plain `pnpm`.

## File Map

- Create `src/operations/macos-launch-agent-plist.ts` — label, resolved paths, XML escaping and deterministic plist rendering.
- Create `src/operations/macos-production-config.ts` — dotenv parsing, file ownership/mode checks and database-path boundary.
- Create `src/operations/runtime-contract.ts` — Node/pnpm bounded-version validation against `package.json` declarations.
- Create `src/operations/macos-launch-agent-service.ts` — side-effect ordering and lifecycle operations over injected ports.
- Create `src/operations/macos-launch-agent-cli.ts` — argument parsing and real filesystem/launchctl/grammY adapters.
- Create `tests/operations/macos-launch-agent-plist.test.ts` — exact plist and secret-exclusion contract.
- Create `tests/operations/macos-production-config.test.ts` — env, mode, owner and database-path failures.
- Create `tests/operations/runtime-contract.test.ts` — version floors/ceilings and malformed declaration failures.
- Create `tests/operations/macos-launch-agent-service.test.ts` — preflight-before-write and lifecycle behavior.
- Create `tests/operations/macos-launch-agent-cli.test.ts` — command parsing and safe output projection.
- Modify `package.json` — add `ops:launch-agent` without adding dependencies.
- Modify `README.md` — production config, install/update/status/stop/uninstall runbook and operating limits.
- Create `docs/verification/2026-08-09-epic-05.md` — separate automated, local plist and real LaunchAgent evidence.

---

### Task 1: Resolve paths and render a secret-free plist

**Files:**
- Create: `src/operations/macos-launch-agent-plist.ts`
- Create: `tests/operations/macos-launch-agent-plist.test.ts`

**Interfaces:**
- Produces: `LAUNCH_AGENT_LABEL`, `LaunchAgentPaths`, `resolveLaunchAgentPaths(input)`, `renderLaunchAgentPlist(paths)`.
- Consumes: absolute `homeDirectory`, `repoRoot` and `nodePath` supplied by the CLI.

- [ ] **Step 1: Write the failing path and plist tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  resolveLaunchAgentPaths,
} from '../../src/operations/macos-launch-agent-plist.js';

describe('macOS LaunchAgent plist', () => {
  const paths = resolveLaunchAgentPaths({
    homeDirectory: '/Users/tatiana',
    repoRoot: '/Applications/Gift & Bot',
    nodePath: '/opt/node/bin/node',
  });

  it('resolves production state outside the checkout', () => {
    expect(LAUNCH_AGENT_LABEL).toBe('ru.strelchuk.giveaways-bot');
    expect(paths.environmentPath).toBe(
      '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/production.env',
    );
    expect(paths.databasePath).toBe(
      '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
    );
    expect(paths.plistPath).toBe(
      '/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
    );
  });

  it('renders escaped absolute paths and no secret keys', () => {
    const plist = renderLaunchAgentPlist(paths);
    expect(plist).toContain('<string>/Applications/Gift &amp; Bot</string>');
    expect(plist).toContain('<key>DOTENV_CONFIG_PATH</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).not.toContain('BOT_TOKEN');
    expect(plist).not.toContain('TEAM_TELEGRAM_IDS');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/operations/macos-launch-agent-plist.test.ts`

Expected: FAIL because the plist module does not exist.

- [ ] **Step 3: Implement the path contract**

```ts
import { dirname, join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'ru.strelchuk.giveaways-bot';

export type LaunchAgentPaths = {
  homeDirectory: string;
  repoRoot: string;
  nodePath: string;
  entrypointPath: string;
  environmentPath: string;
  databasePath: string;
  applicationSupportDirectory: string;
  dataDirectory: string;
  logsDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  launchAgentsDirectory: string;
  plistPath: string;
  temporaryPlistPath: string;
};

export function resolveLaunchAgentPaths(input: {
  homeDirectory: string;
  repoRoot: string;
  nodePath: string;
}): LaunchAgentPaths {
  const applicationSupportDirectory = join(
    input.homeDirectory,
    'Library/Application Support/StrelchukGiveawaysBot',
  );
  const dataDirectory = join(applicationSupportDirectory, 'data');
  const logsDirectory = join(
    input.homeDirectory,
    'Library/Logs/StrelchukGiveawaysBot',
  );
  const plistPath = join(
    input.homeDirectory,
    `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`,
  );
  return {
    ...input,
    entrypointPath: join(input.repoRoot, 'dist/index.js'),
    environmentPath: join(applicationSupportDirectory, 'production.env'),
    databasePath: join(dataDirectory, 'gift-bot.sqlite'),
    applicationSupportDirectory,
    dataDirectory,
    logsDirectory,
    stdoutPath: join(logsDirectory, 'stdout.log'),
    stderrPath: join(logsDirectory, 'stderr.log'),
    launchAgentsDirectory: dirname(plistPath),
    plistPath,
    temporaryPlistPath: `${plistPath}.tmp`,
  };
}
```

- [ ] **Step 4: Implement deterministic XML rendering**

```ts
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderLaunchAgentPlist(paths: LaunchAgentPaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.nodePath)}</string>
    <string>${xml(paths.entrypointPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOTENV_CONFIG_PATH</key>
    <string>${xml(paths.environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 5: Run the focused test and validate a rendered fixture with plutil**

Run:

```bash
pnpm exec vitest run tests/operations/macos-launch-agent-plist.test.ts
pnpm build
node -e "import('./dist/operations/macos-launch-agent-plist.js').then(({resolveLaunchAgentPaths,renderLaunchAgentPlist})=>process.stdout.write(renderLaunchAgentPlist(resolveLaunchAgentPaths({homeDirectory:'/Users/tatiana',repoRoot:'/Applications/Gift & Bot',nodePath:'/opt/node/bin/node'}))))" > /private/tmp/ru.strelchuk.giveaways-bot.plist
plutil -lint /private/tmp/ru.strelchuk.giveaways-bot.plist
```

Expected: focused test PASS and `plutil` reports `OK`.

- [ ] **Step 6: Commit the plist boundary**

```bash
git add src/operations/macos-launch-agent-plist.ts tests/operations/macos-launch-agent-plist.test.ts
git commit -m "feat: render macos launch agent plist"
```

---

### Task 2: Validate production configuration and runtime contracts

**Files:**
- Create: `src/operations/macos-production-config.ts`
- Create: `src/operations/runtime-contract.ts`
- Create: `tests/operations/macos-production-config.test.ts`
- Create: `tests/operations/runtime-contract.test.ts`

**Interfaces:**
- Produces: `ProductionEnvironment`, `parseProductionEnvironment(input)`, `assertRuntimeContract(input)`.
- Consumes: production env bytes, file mode/uid, checkout path, `package.json` ranges, running Node version and `pnpm --version` output.

- [ ] **Step 1: Write failing production-env tests**

```ts
import { describe, expect, it } from 'vitest';

import { parseProductionEnvironment } from '../../src/operations/macos-production-config.js';

const valid = [
  'BOT_TOKEN=1234567890:local_test_value',
  'TEAM_TELEGRAM_IDS=465050746',
  'DATABASE_PATH="/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite"',
  'LOG_LEVEL=info',
  'DRAW_MEMBERSHIP_CONCURRENCY=10',
].join('\n');

describe('production environment preflight', () => {
  it('returns the validated runtime values', () => {
    expect(
      parseProductionEnvironment({
        contents: Buffer.from(valid),
        mode: 0o100600,
        ownerUid: 501,
        expectedUid: 501,
        repoRoot: '/Users/tatiana/projects/gift-bot',
        expectedDatabasePath:
          '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
      }),
    ).toMatchObject({
      teamTelegramIds: [465050746],
      databasePath:
        '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
      logLevel: 'info',
    });
  });

  it.each([
    { mode: 0o100644, ownerUid: 501, message: 'mode 0600' },
    { mode: 0o100600, ownerUid: 502, message: 'current user' },
  ])('rejects unsafe ownership before returning secrets', (input) => {
    expect(() =>
      parseProductionEnvironment({
        contents: Buffer.from(valid),
        mode: input.mode,
        ownerUid: input.ownerUid,
        expectedUid: 501,
        repoRoot: '/Users/tatiana/projects/gift-bot',
        expectedDatabasePath:
          '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
      }),
    ).toThrow(input.message);
  });

  it('rejects relative and checkout-owned database paths', () => {
    for (const databasePath of [
      '.data/gift-bot.sqlite',
      '/Users/tatiana/projects/gift-bot/.data/gift-bot.sqlite',
    ]) {
      expect(() =>
        parseProductionEnvironment({
          contents: Buffer.from(valid.replace(
            '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
            databasePath,
          )),
          mode: 0o100600,
          ownerUid: 501,
          expectedUid: 501,
          repoRoot: '/Users/tatiana/projects/gift-bot',
          expectedDatabasePath:
            '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
        }),
      ).toThrow('DATABASE_PATH');
    }
  });
});
```

- [ ] **Step 2: Write failing runtime-version tests**

```ts
import { describe, expect, it } from 'vitest';

import { assertRuntimeContract } from '../../src/operations/runtime-contract.js';

describe('LaunchAgent runtime contract', () => {
  const declared = {
    engines: { node: '>=24.18.0 <25', pnpm: '>=11.15.1 <12' },
    packageManager: 'pnpm@11.15.1',
  };

  it('accepts the current project range', () => {
    expect(() =>
      assertRuntimeContract({
        packageJson: declared,
        nodeVersion: '24.18.1',
        pnpmVersion: '11.15.1',
      }),
    ).not.toThrow();
  });

  it.each([
    ['24.17.9', '11.15.1'],
    ['25.0.0', '11.15.1'],
    ['24.18.1', '11.15.0'],
    ['24.18.1', '12.0.0'],
  ])('rejects incompatible node=%s pnpm=%s', (nodeVersion, pnpmVersion) => {
    expect(() =>
      assertRuntimeContract({ packageJson: declared, nodeVersion, pnpmVersion }),
    ).toThrow('runtime contract');
  });
});
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/operations/macos-production-config.test.ts tests/operations/runtime-contract.test.ts
```

Expected: FAIL because both validation modules are missing.

- [ ] **Step 4: Implement pure dotenv parsing without mutating process.env**

```ts
import { isAbsolute, relative } from 'node:path';

import { parse } from 'dotenv';

import { parseTeamTelegramIds } from '../config/team-telegram-ids.js';
import { parseDrawMembershipConcurrency } from '../config/draw.js';

export type ProductionEnvironment = {
  botToken: string;
  teamTelegramIds: number[];
  databasePath: string;
  logLevel: 'info' | 'error';
  drawMembershipConcurrency: number;
};

export function parseProductionEnvironment(input: {
  contents: Buffer;
  mode: number;
  ownerUid: number;
  expectedUid: number;
  repoRoot: string;
  expectedDatabasePath: string;
}): ProductionEnvironment {
  if ((input.mode & 0o777) !== 0o600) {
    throw new Error('Production env must use mode 0600');
  }
  if (input.ownerUid !== input.expectedUid) {
    throw new Error('Production env must belong to the current user');
  }
  const values = parse(input.contents);
  const required = (name: string) => {
    const value = values[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const databasePath = required('DATABASE_PATH');
  const relativeDatabasePath = relative(input.repoRoot, databasePath);
  if (
    !isAbsolute(databasePath) ||
    (!relativeDatabasePath.startsWith('..') && relativeDatabasePath !== '..') ||
    databasePath !== input.expectedDatabasePath
  ) {
    throw new Error('DATABASE_PATH must equal the production data path outside the checkout');
  }
  const logLevel = required('LOG_LEVEL');
  if (logLevel !== 'info' && logLevel !== 'error') {
    throw new Error('LOG_LEVEL must be info or error');
  }
  return {
    botToken: required('BOT_TOKEN'),
    teamTelegramIds: parseTeamTelegramIds(required('TEAM_TELEGRAM_IDS')),
    databasePath,
    logLevel,
    drawMembershipConcurrency: parseDrawMembershipConcurrency(
      values.DRAW_MEMBERSHIP_CONCURRENCY,
    ),
  };
}
```

- [ ] **Step 5: Implement bounded semantic-version validation**

```ts
export type PackageContract = {
  engines?: { node?: string; pnpm?: string };
  packageManager?: string;
};

function tuple(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim().replace(/^v/, ''));
  if (!match) throw new Error('Invalid runtime version');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: [number, number, number], right: [number, number, number]) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function satisfies(value: string, range: string): boolean {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+)(?:\.0\.0)?$/.exec(range);
  if (!match) throw new Error(`Unsupported runtime range: ${range}`);
  const current = tuple(value);
  return compare(current, tuple(match[1]!)) >= 0 && current[0] < Number(match[2]);
}

export function assertRuntimeContract(input: {
  packageJson: PackageContract;
  nodeVersion: string;
  pnpmVersion: string;
}): void {
  const nodeRange = input.packageJson.engines?.node;
  const pnpmRange = input.packageJson.engines?.pnpm;
  const packageManager = input.packageJson.packageManager;
  if (!nodeRange || !pnpmRange || packageManager !== 'pnpm@11.15.1') {
    throw new Error('Unsupported package runtime contract');
  }
  if (
    !satisfies(input.nodeVersion, nodeRange) ||
    !satisfies(input.pnpmVersion, pnpmRange)
  ) {
    throw new Error('Current Node or pnpm violates the runtime contract');
  }
}
```

- [ ] **Step 6: Run both tests and compile**

Run:

```bash
pnpm exec vitest run tests/operations/macos-production-config.test.ts tests/operations/runtime-contract.test.ts
pnpm build
```

Expected: PASS. Confirm thrown messages never include the parsed token value.

- [ ] **Step 7: Commit the pure preflight validators**

```bash
git add src/operations/macos-production-config.ts src/operations/runtime-contract.ts tests/operations/macos-production-config.test.ts tests/operations/runtime-contract.test.ts
git commit -m "feat: validate macos production preflight"
```

---

### Task 3: Implement install ordering and atomic plist publication

**Files:**
- Create: `src/operations/macos-launch-agent-service.ts`
- Create: `tests/operations/macos-launch-agent-service.test.ts`

**Interfaces:**
- Consumes: `LaunchAgentPaths`, `renderLaunchAgentPlist`, `parseProductionEnvironment`, `assertRuntimeContract`, and `PRODUCTION_BOT_USERNAME` from Epic 4.
- Produces: `LaunchAgentHost`, `CommandResult`, `MacosLaunchAgentService.install(): Promise<void>`.

- [ ] **Step 1: Build a fake host and write the no-mutation-on-wrong-bot test**

```ts
import { describe, expect, it } from 'vitest';

import {
  MacosLaunchAgentService,
  type LaunchAgentHost,
} from '../../src/operations/macos-launch-agent-service.js';
import { resolveLaunchAgentPaths } from '../../src/operations/macos-launch-agent-plist.js';

function fakeHost(
  username = 'strelchuk_giveaways_bot',
  failAt?: 'plutil' | 'bootstrap',
) {
  const events: string[] = [];
  const env = Buffer.from([
    'BOT_TOKEN=1234567890:local_test_value',
    'TEAM_TELEGRAM_IDS=465050746',
    'DATABASE_PATH="/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite"',
    'LOG_LEVEL=info',
  ].join('\n'));
  const host: LaunchAgentHost = {
    readFile: async (path) => {
      events.push(`read:${path}`);
      return path.endsWith('package.json')
        ? Buffer.from(JSON.stringify({
            engines: { node: '>=24.18.0 <25', pnpm: '>=11.15.1 <12' },
            packageManager: 'pnpm@11.15.1',
          }))
        : env;
    },
    stat: async () => ({ mode: 0o100600, uid: 501 }),
    exists: async () => false,
    mkdir: async (path) => events.push(`mkdir:${path}`),
    writeFile: async (path) => events.push(`write:${path}`),
    rename: async (from, to) => events.push(`rename:${from}:${to}`),
    unlink: async (path) => events.push(`unlink:${path}`),
    run: async (command, args) => {
      events.push(`run:${command}:${args.join(' ')}`);
      if (command === failAt || (failAt === 'bootstrap' && args[0] === 'bootstrap')) {
        return { exitCode: 1, stdout: '', stderr: 'raw command detail' };
      }
      if (command === 'pnpm' && args[0] === '--version') {
        return { exitCode: 0, stdout: '11.15.1\n', stderr: '' };
      }
      if (command === 'launchctl' && args[0] === 'print') {
        return { exitCode: 113, stdout: '', stderr: 'not found' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    verifyBotUsername: async () => {
      events.push('getMe');
      return username;
    },
    readText: async () => '',
  };
  return { host, events };
}

it('finishes validation before creating directories or writing plist', async () => {
  const { host, events } = fakeHost('gift_epic1_smoke_20260808_bot');
  const service = new MacosLaunchAgentService({
    host,
    paths: resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Users/tatiana/projects/gift-bot',
      nodePath: '/opt/node/bin/node',
    }),
    uid: 501,
    nodeVersion: '24.18.1',
  });
  await expect(service.install()).rejects.toThrow('strelchuk_giveaways_bot');
  expect(events.some((event) => event.startsWith('mkdir:'))).toBe(false);
  expect(events.some((event) => event.startsWith('write:'))).toBe(false);
});
```

- [ ] **Step 2: Add the successful install-order test**

```ts
it('validates, atomically publishes, lints and bootstraps the plist', async () => {
  const { host, events } = fakeHost();
  const service = new MacosLaunchAgentService({
    host,
    paths: resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Users/tatiana/projects/gift-bot',
      nodePath: '/opt/node/bin/node',
    }),
    uid: 501,
    nodeVersion: '24.18.1',
  });
  await service.install();
  expect(events).toContain('run:pnpm:build');
  expect(events).toContain('getMe');
  expect(events).toContain(
    'run:plutil:-lint /Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist.tmp',
  );
  expect(events.at(-1)).toBe(
    'run:launchctl:bootstrap gui/501 /Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
  );
  expect(events.findIndex((event) => event === 'getMe')).toBeLessThan(
    events.findIndex((event) => event.startsWith('mkdir:')),
  );
});

it('removes only the temporary plist when plutil rejects it', async () => {
  const { host, events } = fakeHost('strelchuk_giveaways_bot', 'plutil');
  const service = new MacosLaunchAgentService({
    host,
    paths: resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Users/tatiana/projects/gift-bot',
      nodePath: '/opt/node/bin/node',
    }),
    uid: 501,
    nodeVersion: '24.18.1',
  });
  await expect(service.install()).rejects.toThrow('plutil validation failed');
  expect(events).toContain(
    'unlink:/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist.tmp',
  );
  expect(events.some((event) => event.startsWith('rename:'))).toBe(false);
});

it('keeps the validated final plist when bootstrap fails', async () => {
  const { host, events } = fakeHost('strelchuk_giveaways_bot', 'bootstrap');
  const service = new MacosLaunchAgentService({
    host,
    paths: resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Users/tatiana/projects/gift-bot',
      nodePath: '/opt/node/bin/node',
    }),
    uid: 501,
    nodeVersion: '24.18.1',
  });
  await expect(service.install()).rejects.toThrow('launchctl bootstrap failed');
  expect(events).toContain(
    'rename:/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist.tmp:/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
  );
  expect(events.filter((event) => event.startsWith('unlink:'))).toEqual([]);
});
```

- [ ] **Step 3: Run the service test and verify RED**

Run: `pnpm exec vitest run tests/operations/macos-launch-agent-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Define the injected host and service constructor**

```ts
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type LaunchAgentHost = {
  readFile(path: string): Promise<Buffer>;
  stat(path: string): Promise<{ mode: number; uid: number }>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  verifyBotUsername(token: string): Promise<string>;
  readText(path: string): Promise<string>;
};

export class MacosLaunchAgentService {
  constructor(
    private readonly input: {
      host: LaunchAgentHost;
      paths: LaunchAgentPaths;
      uid: number;
      nodeVersion: string;
    },
  ) {}

  private get domainTarget() {
    return `gui/${this.input.uid}`;
  }

  private get serviceTarget() {
    return `${this.domainTarget}/${LAUNCH_AGENT_LABEL}`;
  }
}
```

- [ ] **Step 5: Implement preflight and atomic install in the tested order**

Use a helper that rejects any nonzero required command without copying `stderr` into the public error message:

```ts
function requireSuccess(
  result: CommandResult,
  operation: string,
): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed`);
}
```

Then implement the ordered operation:

```ts
async install(): Promise<void> {
  const { host, paths } = this.input;
  if (await host.exists(paths.plistPath)) {
    throw new Error('LaunchAgent plist is already installed');
  }
  const environmentStat = await host.stat(paths.environmentPath);
  const environment = parseProductionEnvironment({
    contents: await host.readFile(paths.environmentPath),
    mode: environmentStat.mode,
    ownerUid: environmentStat.uid,
    expectedUid: this.input.uid,
    repoRoot: paths.repoRoot,
    expectedDatabasePath: paths.databasePath,
  });
  const packageJson = JSON.parse(
    (await host.readFile(join(paths.repoRoot, 'package.json'))).toString('utf8'),
  ) as PackageContract;
  const pnpmVersion = await host.run('pnpm', ['--version']);
  requireSuccess(pnpmVersion, 'pnpm --version');
  assertRuntimeContract({
    packageJson,
    nodeVersion: this.input.nodeVersion,
    pnpmVersion: pnpmVersion.stdout.trim(),
  });
  requireSuccess(await host.run('pnpm', ['build']), 'pnpm build');
  const username = await host.verifyBotUsername(environment.botToken);
  if (username !== PRODUCTION_BOT_USERNAME) {
    throw new Error(`Expected @${PRODUCTION_BOT_USERNAME}`);
  }
  if ((await host.run('launchctl', ['print', this.serviceTarget])).exitCode === 0) {
    throw new Error('LaunchAgent is already loaded');
  }
  await host.mkdir(paths.dataDirectory);
  await host.mkdir(paths.logsDirectory);
  await host.mkdir(paths.launchAgentsDirectory);
  await host.writeFile(
    paths.temporaryPlistPath,
    renderLaunchAgentPlist(paths),
    0o600,
  );
  const lint = await host.run('plutil', ['-lint', paths.temporaryPlistPath]);
  if (lint.exitCode !== 0) {
    await host.unlink(paths.temporaryPlistPath);
    throw new Error('plutil validation failed');
  }
  await host.rename(paths.temporaryPlistPath, paths.plistPath);
  requireSuccess(
    await host.run('launchctl', [
      'bootstrap',
      this.domainTarget,
      paths.plistPath,
    ]),
    'launchctl bootstrap',
  );
}
```

Import `join` from `node:path`, `PRODUCTION_BOT_USERNAME`, `PackageContract`, both validator functions, and the plist renderer. Keep bootstrap after the atomic rename so a bootstrap failure leaves the validated final plist for diagnosis.

- [ ] **Step 6: Run the focused service tests**

Run: `pnpm exec vitest run tests/operations/macos-launch-agent-service.test.ts`

Expected: PASS; fake events prove no mkdir/write/launchctl mutation precedes the username guard.

- [ ] **Step 7: Commit guarded installation**

```bash
git add src/operations/macos-launch-agent-service.ts tests/operations/macos-launch-agent-service.test.ts
git commit -m "feat: guard launch agent installation"
```

---

### Task 4: Implement lifecycle, status and preserved-data behavior

**Files:**
- Modify: `src/operations/macos-launch-agent-service.ts`
- Modify: `tests/operations/macos-launch-agent-service.test.ts`

**Interfaces:**
- Produces: `start()`, `stop()`, `restart()`, `status()`, `logs()`, `uninstall()` and `LaunchAgentStatus`.
- Preserves: production env, database and logs under every lifecycle command.

- [ ] **Step 1: Write the lifecycle command tests**

```ts
function lifecycleFixture() {
  let loaded = false;
  const existing = new Set([
    '/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
  ]);
  const events: string[] = [];
  const host: LaunchAgentHost = {
    readFile: async () => Buffer.alloc(0),
    stat: async () => ({ mode: 0o100600, uid: 501 }),
    exists: async (path) => existing.has(path),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    rename: async () => undefined,
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      existing.delete(path);
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
    readText: async () => '',
  };
  const service = new MacosLaunchAgentService({
    host,
    paths: resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Users/tatiana/projects/gift-bot',
      nodePath: '/opt/node/bin/node',
    }),
    uid: 501,
    nodeVersion: '24.18.1',
  });
  return { service, host, events, setLoaded: (value: boolean) => (loaded = value) };
}

it('uses bootout for maintenance stop and bootstrap for start', async () => {
  const { service, events, setLoaded } = lifecycleFixture();
  setLoaded(true);
  await service.stop();
  expect(events.at(-1)).toBe(
    'run:launchctl:bootout gui/501/ru.strelchuk.giveaways-bot',
  );
  setLoaded(false);
  await service.start();
  expect(events.at(-1)).toBe(
    'run:launchctl:bootstrap gui/501 /Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
  );
});

it('uninstalls only the service registration and plist', async () => {
  const { service, events, setLoaded } = lifecycleFixture();
  setLoaded(true);
  await service.uninstall();
  expect(events).toContain(
    'run:launchctl:bootout gui/501/ru.strelchuk.giveaways-bot',
  );
  expect(events.filter((event) => event.startsWith('unlink:'))).toEqual([
    'unlink:/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
  ]);
  expect(events.join('\n')).not.toContain('production.env');
  expect(events.join('\n')).not.toContain('gift-bot.sqlite');
});

it('returns bounded log tails without parsing launchctl output', async () => {
  const { service, host } = lifecycleFixture();
  host.readText = async (path) =>
    Array.from({ length: 120 }, (_, index) => `${path}:${index + 1}`).join('\n');
  const logs = await service.logs();
  expect(logs.stdout.split('\n')).toHaveLength(100);
  expect(logs.stderr.split('\n')).toHaveLength(100);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm exec vitest run tests/operations/macos-launch-agent-service.test.ts`

Expected: FAIL because lifecycle methods are absent.

- [ ] **Step 3: Implement loaded-state checks and explicit lifecycle semantics**

```ts
export type LaunchAgentStatus = {
  loaded: boolean;
  label: string;
  plistPath: string;
  environmentPath: string;
  databasePath: string;
  stdoutPath: string;
  stderrPath: string;
};

private async isLoaded(): Promise<boolean> {
  return (
    await this.input.host.run('launchctl', ['print', this.serviceTarget])
  ).exitCode === 0;
}

async start(): Promise<void> {
  if (!(await this.input.host.exists(this.input.paths.plistPath))) {
    throw new Error('LaunchAgent plist is not installed');
  }
  if (await this.isLoaded()) return;
  await requireSuccess(
    await this.input.host.run('launchctl', [
      'bootstrap',
      this.domainTarget,
      this.input.paths.plistPath,
    ]),
    'launchctl bootstrap',
  );
}

async stop(): Promise<void> {
  if (!(await this.isLoaded())) return;
  await requireSuccess(
    await this.input.host.run('launchctl', ['bootout', this.serviceTarget]),
    'launchctl bootout',
  );
}

async restart(): Promise<void> {
  await this.stop();
  await this.start();
}
```

Implement `status()`, bounded log reads and uninstall exactly:

```ts
async status(): Promise<LaunchAgentStatus> {
  const paths = this.input.paths;
  return {
    loaded: await this.isLoaded(),
    label: LAUNCH_AGENT_LABEL,
    plistPath: paths.plistPath,
    environmentPath: paths.environmentPath,
    databasePath: paths.databasePath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
}

private async tail(path: string): Promise<string> {
  try {
    return (await this.input.host.readText(path)).split('\n').slice(-100).join('\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

async logs(): Promise<{ stdout: string; stderr: string }> {
  return {
    stdout: await this.tail(this.input.paths.stdoutPath),
    stderr: await this.tail(this.input.paths.stderrPath),
  };
}

async uninstall(): Promise<void> {
  await this.stop();
  if (await this.input.host.exists(this.input.paths.plistPath)) {
    await this.input.host.unlink(this.input.paths.plistPath);
  }
}
```

- [ ] **Step 4: Add idempotent absent-state tests**

```ts
it('keeps repeated stop and uninstall idempotent when already absent', async () => {
  const { service, events, setLoaded } = lifecycleFixture();
  setLoaded(false);
  await service.uninstall();
  events.length = 0;
  await service.stop();
  await service.uninstall();
  expect((await service.status()).loaded).toBe(false);
  expect(events.some((event) => event.includes('production.env'))).toBe(false);
  expect(events.some((event) => event.includes('gift-bot.sqlite'))).toBe(false);
});
```

- [ ] **Step 5: Run lifecycle tests and compile**

Run:

```bash
pnpm exec vitest run tests/operations/macos-launch-agent-service.test.ts
pnpm build
```

Expected: PASS.

- [ ] **Step 6: Commit lifecycle operations**

```bash
git add src/operations/macos-launch-agent-service.ts tests/operations/macos-launch-agent-service.test.ts
git commit -m "feat: manage launch agent lifecycle"
```

---

### Task 5: Compose the real macOS CLI without shell interpolation

**Files:**
- Create: `src/operations/macos-launch-agent-cli.ts`
- Create: `tests/operations/macos-launch-agent-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `MacosLaunchAgentService`, `resolveLaunchAgentPaths`, Node filesystem/process APIs, `new Api(token).getMe()` and the inherited `PATH`.
- Produces: `parseLaunchAgentCommand(argv)`, `toSafeOperationsFailure(error)`, and package script `pnpm ops:launch-agent -- <command>`.

- [ ] **Step 1: Write failing CLI parsing and safe-error tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  parseLaunchAgentCommand,
  toSafeOperationsFailure,
} from '../../src/operations/macos-launch-agent-cli.js';

describe('macOS LaunchAgent CLI', () => {
  it.each(['install', 'start', 'stop', 'restart', 'status', 'logs', 'uninstall'] as const)(
    'accepts %s',
    (command) => expect(parseLaunchAgentCommand([command])).toBe(command),
  );

  it('rejects extra or unknown arguments', () => {
    expect(() => parseLaunchAgentCommand([])).toThrow('Usage:');
    expect(() => parseLaunchAgentCommand(['install', '--force'])).toThrow('Usage:');
    expect(() => parseLaunchAgentCommand(['purge'])).toThrow('Usage:');
  });

  it('does not expose an underlying command or token detail', () => {
    const projected = toSafeOperationsFailure(
      new Error('BOT_TOKEN=secret launchctl raw output'),
    );
    expect(projected).toEqual({
      event: 'launch_agent_command_failed',
      errorName: 'Error',
    });
    expect(JSON.stringify(projected)).not.toContain('secret');
  });
});
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run: `pnpm exec vitest run tests/operations/macos-launch-agent-cli.test.ts`

Expected: FAIL because the CLI module is missing.

- [ ] **Step 3: Implement exact command parsing and a spawn-based command runner**

```ts
const COMMANDS = [
  'install',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'uninstall',
] as const;

type LaunchAgentCommand = (typeof COMMANDS)[number];

export function parseLaunchAgentCommand(argv: readonly string[]): LaunchAgentCommand {
  if (argv.length !== 1 || !COMMANDS.includes(argv[0] as LaunchAgentCommand)) {
    throw new Error(
      'Usage: pnpm ops:launch-agent -- install|start|stop|restart|status|logs|uninstall',
    );
  }
  return argv[0] as LaunchAgentCommand;
}

function runCommand(
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: process.env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}
```

Import `spawn` from `node:child_process`. Never construct a shell command string and never replace `PATH`.

- [ ] **Step 4: Implement the real host adapter**

Use `node:fs/promises` for all file operations and keep the bot verifier read-only:

```ts
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const host: LaunchAgentHost = {
  readFile,
  stat: async (path) => {
    const value = await stat(path);
    return { mode: value.mode, uid: value.uid };
  },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  writeFile: async (path, contents, mode) =>
    void (await writeFile(path, contents, { mode })),
  rename,
  unlink,
  run: runCommand,
  verifyBotUsername: async (token) => (await new Api(token).getMe()).username,
  readText: async (path) => readFile(path, 'utf8'),
};
```

Import `access`, `mkdir`, `readFile`, `rename`, `stat`, `unlink`, `writeFile` from `node:fs/promises` and `Api` from `grammy`. Before composition, require `process.platform === 'darwin'` and a numeric `process.getuid()` result. Do not call `launchctl` on another platform.

- [ ] **Step 5: Dispatch one service method and print only safe structured output**

Compose and dispatch exactly one command:

```ts
async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.getuid === undefined) {
    throw new Error('macOS GUI user is required');
  }
  const command = parseLaunchAgentCommand(process.argv.slice(2));
  const paths = resolveLaunchAgentPaths({
    homeDirectory: homedir(),
    repoRoot: process.cwd(),
    nodePath: process.execPath,
  });
  const service = new MacosLaunchAgentService({
    host,
    paths,
    uid: process.getuid(),
    nodeVersion: process.versions.node,
  });
  if (command === 'status') {
    console.log(JSON.stringify(await service.status()));
    return;
  }
  if (command === 'logs') {
    const logs = await service.logs();
    console.log(`stdout:\n${logs.stdout}\n\nstderr:\n${logs.stderr}`);
    return;
  }
  await service[command]();
  console.log(JSON.stringify({
    event: 'launch_agent_command_completed',
    command,
    label: LAUNCH_AGENT_LABEL,
  }));
}
```

The indexed call is type-safe because the remaining command union is `install | start | stop | restart | uninstall`, all with the same `() => Promise<void>` signature. On failure, set exit code `1` and print only:

```ts
export function toSafeOperationsFailure(error: unknown) {
  return {
    event: 'launch_agent_command_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError',
  };
}

if (process.env.NODE_ENV !== 'test') {
  void main().catch((error) => {
    console.error(JSON.stringify(toSafeOperationsFailure(error)));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Add the package script**

Add to `package.json` scripts:

```json
"ops:launch-agent": "tsx src/operations/macos-launch-agent-cli.ts"
```

- [ ] **Step 7: Run CLI tests, service tests and build**

Run:

```bash
pnpm exec vitest run tests/operations/macos-launch-agent-cli.test.ts tests/operations/macos-launch-agent-service.test.ts
pnpm build
```

Expected: PASS; tests use fake adapters and do not access the real LaunchAgent domain.

- [ ] **Step 8: Commit the CLI composition root**

```bash
git add package.json src/operations/macos-launch-agent-cli.ts tests/operations/macos-launch-agent-cli.test.ts
git commit -m "feat: add macos launch agent commands"
```

---

### Task 6: Add the Mac operations runbook and layered evidence

**Files:**
- Modify: `README.md`
- Create: `docs/verification/2026-08-09-epic-05.md`

**Interfaces:**
- Documents: production env creation, permissions, lifecycle commands, update sequence, sleep/login limits and retained-data behavior.
- Produces: an evidence record that keeps pure tests, local plist validation and real GUI-domain state separate.

- [ ] **Step 1: Document the exact production env location and contents**

The README example must use the current user's absolute path and no real secrets:

```dotenv
BOT_TOKEN=
TEAM_TELEGRAM_IDS=465050746
DATABASE_PATH="/Users/denischernykh/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite"
LOG_LEVEL=info
DRAW_MEMBERSHIP_CONCURRENCY=10
```

Document that the file lives at `/Users/denischernykh/Library/Application Support/StrelchukGiveawaysBot/production.env` and must have mode `0600`.

- [ ] **Step 2: Document lifecycle and update commands**

```bash
pnpm check
pnpm ops:launch-agent -- install
pnpm ops:launch-agent -- status
pnpm ops:launch-agent -- logs
pnpm ops:launch-agent -- stop
pnpm ops:launch-agent -- start
pnpm ops:launch-agent -- restart
pnpm ops:launch-agent -- uninstall
```

State explicitly that the Mac must be logged in and awake; Epic 3 catches overdue work after the next successful start. State that `uninstall` preserves env, database and logs.

- [ ] **Step 3: Create the verification record before external mutation**

```markdown
# Epic 5 verification — macOS LaunchAgent operations

## Automated checks

| Check | Result | Evidence |
|---|---|---|
| Focused operations tests | NOT RUN | Execution intentionally waits for Step 4 |
| `pnpm check` | NOT RUN | Execution intentionally waits for Step 4 |

## Local plist validation

| Check | Result | Evidence |
|---|---|---|
| Temporary plist `plutil -lint` | NOT RUN | Does not touch the real LaunchAgents directory |

## Real GUI-domain smoke

Status: NOT RUN. Requires explicit user authorization because it changes LaunchAgent state and starts the production bot.
```

- [ ] **Step 4: Run automated and non-mutating Mac checks**

Run:

```bash
node --version
pnpm --version
pnpm exec vitest run tests/operations/macos-launch-agent-plist.test.ts tests/operations/macos-production-config.test.ts tests/operations/runtime-contract.test.ts tests/operations/macos-launch-agent-service.test.ts tests/operations/macos-launch-agent-cli.test.ts
pnpm check
git diff --check
```

Render a plist against a temporary HOME fixture and run `plutil -lint` on that temporary file. Record exact exit codes and the current commit SHA. Do not call `launchctl bootstrap`, `bootout`, `kickstart` or mutate `~/Library/LaunchAgents` in this step.

- [ ] **Step 5: Run the real LaunchAgent smoke only after explicit authorization**

Preconditions: Epic 4 production token/config exists, no manual process uses the token, `pnpm check` passes, and the user approved LaunchAgent mutation.

Execute and record separately:

1. `pnpm ops:launch-agent -- install`;
2. `pnpm ops:launch-agent -- status` and `launchctl print gui/$(id -u)/ru.strelchuk.giveaways-bot`;
3. confirm `bot_started` in logs and a read-only `getMe` for the production username;
4. `restart` and confirm one process plus graceful `bot_stopped`/new `bot_started` events;
5. run `launchctl kill SIGKILL gui/$(id -u)/ru.strelchuk.giveaways-bot` once and confirm launchd restarts it no sooner than the 30-second throttle;
6. `stop`, confirm unloaded and production data intact;
7. `start`, confirm recovery and polling;
8. stop the job across a short giveaway deadline, start it, and confirm Epic 3 completes the overdue draw;
9. `uninstall`, confirm plist removal and env/database/log preservation.

If authorization is absent, leave this section `NOT RUN`; do not claim the Mac service is installed or running.

- [ ] **Step 6: Commit documentation and recorded evidence**

```bash
git add README.md docs/verification/2026-08-09-epic-05.md
git commit -m "docs: add macos launch agent runbook"
```

---

## Final Epic 5 Gate

- [ ] Run `git status --short --branch` and identify every remaining change.
- [ ] Run the five focused operations test files, then `pnpm check`.
- [ ] Run `git diff --check` and `git diff --cached --check` when staged changes exist.
- [ ] Inspect the rendered plist and confirm it contains `DOTENV_CONFIG_PATH` but no token or allowlist value.
- [ ] Confirm lifecycle code can unlink only `paths.plistPath`; no data/log deletion API is exposed.
- [ ] Confirm `src/index.ts` remains the LaunchAgent entrypoint and Epic 3 recovery code is unchanged.
- [ ] Report automated, temporary-plist and real GUI-domain evidence separately.
- [ ] Do not claim installation, automatic restart or recovery smoke without corresponding real `launchctl` and Telegram evidence.
