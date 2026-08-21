
import { Writable } from 'stream';

class ConsoleBuffer extends Writable {
  private buffer: string[] = [];
  
  constructor() {
    super();
    this.buffer = [];
  }

  _write(chunk: Buffer | string, encoding: string, callback: (error?: Error) => void) {
    const timestamp = new Date().toISOString();
    const formattedLog = `[${timestamp}] ${chunk.toString()}`;
    this.buffer.push(formattedLog);
    process.stdout.write(formattedLog + '\n');
    callback();
  }

  toString() {
    return this.buffer.slice(-100).join('\n');
  }

  clear() {
    this.buffer = [];
  }
}

export const consoleBuffer = new ConsoleBuffer();

export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function isProductionLikeRuntime(): boolean {
  // Production's explicit NODE_ENV selector is the only production signal;
  // deployment providers must not be inferred from ambient variables.
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolves the minimum log level for the current process.
 *
 * Precedence:
 *   1. An explicit `LOG_LEVEL` env var, if it names a known level.
 *   2. `info` when `NODE_ENV=production` (see {@link isProductionLikeRuntime}).
 *   3. `debug` in development.
 *
 * `server/config.ts` validates `LOG_LEVEL` at boot and warns if a
 * production deploy explicitly opts back into `debug`, so a typo or a
 * developer-only setting can't silently sneak `debug` lines (often
 * containing user IDs paired with resource IDs) into prod log sinks.
 */
function getMinLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LOG_LEVELS) return raw as LogLevel;
  return isProductionLikeRuntime() ? 'info' : 'debug';
}

export { getMinLevel as _getMinLevelForTests, isProductionLikeRuntime as _isProductionLikeRuntimeForTests };

function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { message: arg.message, stack: arg.stack };
  }
  return arg;
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const serialized = args.map(serializeArg);
  if (serialized.length === 1 && typeof serialized[0] === 'object') {
    return ' ' + JSON.stringify(serialized[0]);
  }
  return ' ' + JSON.stringify(serialized);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getMinLevel()];
}

function makeLogger(prefix?: string): Logger {
  const tag = prefix ? `[${prefix}] ` : '';
  return {
    info: (message: string, ...args: unknown[]) => {
      if (!shouldLog('info')) return;
      const log = `[INFO] ${tag}${message}${formatArgs(args)}`;
      consoleBuffer.write(Buffer.from(`${log}\n`));
    },
    error: (message: string, ...args: unknown[]) => {
      if (!shouldLog('error')) return;
      const log = `[ERROR] ${tag}${message}${formatArgs(args)}`;
      consoleBuffer.write(Buffer.from(`${log}\n`));
    },
    warn: (message: string, ...args: unknown[]) => {
      if (!shouldLog('warn')) return;
      const log = `[WARN] ${tag}${message}${formatArgs(args)}`;
      consoleBuffer.write(Buffer.from(`${log}\n`));
    },
    debug: (message: string, ...args: unknown[]) => {
      if (!shouldLog('debug')) return;
      const log = `[DEBUG] ${tag}${message}${formatArgs(args)}`;
      consoleBuffer.write(Buffer.from(`${log}\n`));
    },
  };
}

export const logger = makeLogger();

export function createLogger(prefix: string): Logger {
  return makeLogger(prefix);
}
