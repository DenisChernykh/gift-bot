import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Api } from 'grammy';

import {
  MacosLaunchAgentService,
  type CommandResult,
  type LaunchAgentHost,
  type LaunchAgentLogs,
  type LaunchAgentOperationState,
} from './macos-launch-agent-service.js';
import {
  LAUNCH_AGENT_LABEL,
  resolveLaunchAgentPaths,
} from './macos-launch-agent-plist.js';

const COMMANDS = [
  'install',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'uninstall',
] as const;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export type LaunchAgentCommand = (typeof COMMANDS)[number];

export function parseLaunchAgentCommand(
  argv: readonly string[],
): LaunchAgentCommand {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    normalized.length !== 1 ||
    !COMMANDS.includes(normalized[0] as LaunchAgentCommand)
  ) {
    throw new Error(
      'Usage: pnpm ops:launch-agent -- install|start|stop|restart|status|logs|uninstall',
    );
  }
  return normalized[0] as LaunchAgentCommand;
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
}

function runCommand(
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      env: process.env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

type ExclusiveWriteHandle = {
  writeFile(contents: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type ExclusiveWriteDependencies = {
  openFile(
    path: string,
    flags: 'wx',
    mode: number,
  ): Promise<ExclusiveWriteHandle>;
  unlinkFile(path: string): Promise<void>;
};

export async function writeFileExclusiveAndSync(
  path: string,
  contents: string,
  mode: number,
  dependencies: ExclusiveWriteDependencies = {
    openFile: open,
    unlinkFile: unlink,
  },
): Promise<void> {
  const handle = await dependencies.openFile(path, 'wx', mode);
  let closed = false;
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
  } catch (error) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // The original write/sync/close failure remains authoritative.
      }
    }
    try {
      await dependencies.unlinkFile(path);
    } catch (unlinkError) {
      if (!isMissing(unlinkError)) {
        throw new AggregateError(
          [error, unlinkError],
          'Exclusive temporary file cleanup failed',
        );
      }
    }
    throw error;
  }
}

async function readTail(path: string, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Log tail byte limit must be a positive safe integer');
  }
  const handle = await open(path, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    const length = Math.min(fileSize, maximumBytes);
    const buffer = Buffer.alloc(length);
    const start = Math.max(0, fileSize - length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function createLaunchAgentHost(): LaunchAgentHost {
  return {
    openRead: async (path) => {
      const handle = await open(path, 'r');
      return {
        stat: async () => {
          const value = await handle.stat();
          return { mode: value.mode, uid: value.uid };
        },
        readFile: async () => handle.readFile(),
        close: async () => handle.close(),
      };
    },
    readFile,
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFileExclusive: async (path, contents, mode) => {
      await writeFileExclusiveAndSync(path, contents, mode);
    },
    link,
    unlink,
    run: runCommand,
    verifyBotUsername: async (token) => (await new Api(token).getMe()).username,
    readTail,
  };
}

export function formatLaunchAgentLogs(logs: LaunchAgentLogs): string {
  return `stdout (${logs.stdoutPath}):\n${logs.stdout}\n\nstderr (${logs.stderrPath}):\n${logs.stderr}`;
}

export function toLaunchAgentCompletion(
  command: Exclude<LaunchAgentCommand, 'status' | 'logs'>,
  state: LaunchAgentOperationState,
): {
  event: 'launch_agent_command_completed';
  command: Exclude<LaunchAgentCommand, 'status' | 'logs'>;
  label: string;
  state: LaunchAgentOperationState;
} {
  return {
    event: 'launch_agent_command_completed',
    command,
    label: LAUNCH_AGENT_LABEL,
    state,
  };
}

export function toSafeOperationsFailure(error: unknown): {
  event: 'launch_agent_command_failed';
  errorName: string;
} {
  return {
    event: 'launch_agent_command_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError',
  };
}

export async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.getuid === undefined) {
    throw new Error('macOS GUI user is required');
  }
  const command = parseLaunchAgentCommand(process.argv.slice(2));
  const paths = resolveLaunchAgentPaths({
    homeDirectory: homedir(),
    repoRoot: process.cwd(),
    nodePath: process.execPath,
    temporaryFileSuffix: `${process.pid}-${randomUUID()}`,
  });
  const service = new MacosLaunchAgentService({
    host: createLaunchAgentHost(),
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
    console.log(formatLaunchAgentLogs(logs));
    return;
  }
  const state = await service[command]();
  console.log(JSON.stringify(toLaunchAgentCompletion(command, state)));
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(JSON.stringify(toSafeOperationsFailure(error)));
    process.exitCode = 1;
  });
}
