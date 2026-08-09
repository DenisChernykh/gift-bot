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
