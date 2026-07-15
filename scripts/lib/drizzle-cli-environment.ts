import { devNull } from 'node:os';
import { resolve } from 'node:path';

export const REVIEWED_DRIZZLE_CONFIG_PATH = resolve('drizzle.config.ts');

const SAFE_OPERATING_SYSTEM_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'FORCE_COLOR',
] as const;

/**
 * Give Drizzle only the operating-system values needed to start Node plus the
 * reviewed target. In particular, do not inherit Node preload, dotenv, test
 * config-prefix, PostgreSQL, or Drizzle override variables from the caller.
 */
export function isolatedDrizzleEnvironment(
  source: NodeJS.ProcessEnv,
  databaseUrl?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_OPERATING_SYSTEM_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }

  // drizzle-kit loads dotenv before resolving its config. Point that loader at
  // the platform null device, and pin the otherwise test-only config prefix to
  // empty, so an ignored local .env cannot redirect either target or config.
  environment.DOTENV_CONFIG_PATH = devNull;
  environment.DOTENV_CONFIG_OVERRIDE = '';
  environment.TEST_CONFIG_PATH_PREFIX = '';
  if (databaseUrl !== undefined) environment.DATABASE_URL = databaseUrl;
  return environment;
}
