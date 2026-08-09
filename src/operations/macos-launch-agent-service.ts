import { join } from 'node:path';

import { parseProductionEnvironment } from './macos-production-config.js';
import {
  LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  type LaunchAgentPaths,
} from './macos-launch-agent-plist.js';
import {
  assertRuntimeContract,
  type PackageContract,
} from './runtime-contract.js';
import { PRODUCTION_BOT_USERNAME } from '../telegram/production-bot-profile.js';

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type LaunchAgentReadHandle = {
  stat(): Promise<{ mode: number; uid: number }>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
};

export type LaunchAgentHost = {
  openRead(path: string): Promise<LaunchAgentReadHandle>;
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeFileExclusive(path: string, contents: string, mode: number): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  verifyBotUsername(token: string): Promise<string>;
  readText(path: string): Promise<string>;
};

export type LaunchAgentStatus = {
  loaded: boolean;
  label: string;
  plistPath: string;
  environmentPath: string;
  databasePath: string;
  stdoutPath: string;
  stderrPath: string;
};

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class MacosLaunchAgentService {
  constructor(
    private readonly input: {
      host: LaunchAgentHost;
      paths: LaunchAgentPaths;
      uid: number;
      nodeVersion: string;
    },
  ) {}

  private get domainTarget(): string {
    return `gui/${this.input.uid}`;
  }

  private get serviceTarget(): string {
    return `${this.domainTarget}/${LAUNCH_AGENT_LABEL}`;
  }

  async install(): Promise<void> {
    const { host, paths } = this.input;
    if (await host.exists(paths.plistPath)) {
      throw new Error('LaunchAgent plist is already installed');
    }

    const environmentHandle = await host.openRead(paths.environmentPath);
    let environmentStat: { mode: number; uid: number };
    let environmentContents: Buffer;
    try {
      environmentStat = await environmentHandle.stat();
      environmentContents = await environmentHandle.readFile();
    } finally {
      await environmentHandle.close();
    }
    const environment = parseProductionEnvironment({
      contents: environmentContents,
      mode: environmentStat.mode,
      ownerUid: environmentStat.uid,
      expectedUid: this.input.uid,
      repoRoot: paths.repoRoot,
      expectedDatabasePath: paths.databasePath,
    });
    const packageJson = JSON.parse(
      (
        await host.readFile(join(paths.repoRoot, 'package.json'))
      ).toString('utf8'),
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
    await host.writeFileExclusive(
      paths.temporaryPlistPath,
      renderLaunchAgentPlist(paths),
      0o600,
    );
    const lint = await host.run('plutil', ['-lint', paths.temporaryPlistPath]);
    if (lint.exitCode !== 0) {
      await host.unlink(paths.temporaryPlistPath);
      throw new Error('plutil validation failed');
    }

    try {
      await host.link(paths.temporaryPlistPath, paths.plistPath);
    } catch (error) {
      await host.unlink(paths.temporaryPlistPath);
      if (hasCode(error, 'EEXIST')) {
        throw new Error('LaunchAgent plist is already installed');
      }
      throw new Error('LaunchAgent plist publication failed');
    }
    await host.unlink(paths.temporaryPlistPath);
    requireSuccess(
      await host.run('launchctl', [
        'bootstrap',
        this.domainTarget,
        paths.plistPath,
      ]),
      'launchctl bootstrap',
    );
  }

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
    requireSuccess(
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
    requireSuccess(
      await this.input.host.run('launchctl', ['bootout', this.serviceTarget]),
      'launchctl bootout',
    );
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<LaunchAgentStatus> {
    const { paths } = this.input;
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
      return (await this.input.host.readText(path))
        .split('\n')
        .slice(-100)
        .join('\n');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return '';
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
}
