import { configDotenv } from 'dotenv';

const APPLICATION_ENVIRONMENT_KEYS = [
  'BOT_TOKEN',
  'TEAM_TELEGRAM_IDS',
  'DATABASE_PATH',
  'LOG_LEVEL',
  'DRAW_MEMBERSHIP_CONCURRENCY',
] as const;

function configuredPath(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.DOTENV_CONFIG_PATH?.trim();
  return value ? value : undefined;
}

function loadConfiguredFile(
  path: string,
  target: NodeJS.ProcessEnv,
): void {
  const result = configDotenv({
    path,
    encoding: 'utf8',
    quiet: true,
    processEnv: target,
  });
  if (result.error) {
    throw new Error('Configured environment file could not be loaded', {
      cause: result.error,
    });
  }
}

export function loadRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const path = configuredPath(environment);
  const authoritative = environment.DOTENV_CONFIG_OVERRIDE === 'true';

  if (authoritative) {
    if (path === undefined) {
      throw new Error(
        'DOTENV_CONFIG_PATH is required for authoritative environment loading',
      );
    }
    const loaded: NodeJS.ProcessEnv = {};
    loadConfiguredFile(path, loaded);
    for (const key of APPLICATION_ENVIRONMENT_KEYS) {
      const value = loaded[key];
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
    return;
  }

  const result = configDotenv({
    ...(path === undefined ? {} : { path }),
    encoding: 'utf8',
    quiet: true,
    processEnv: environment,
  });
  if (path !== undefined && result.error) {
    throw new Error('Configured environment file could not be loaded', {
      cause: result.error,
    });
  }
}
