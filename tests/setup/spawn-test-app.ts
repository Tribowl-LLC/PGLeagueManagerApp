/**
 * Spawn a per-worker test Express instance (Task #700 / Phase 2 of #697).
 *
 * Forks `server/test-entry.ts` as a child process with the worker's
 * isolated DB URL injected. The child prints `[ready] port=NNNNN` on
 * stdout once `app.listen(0)` has resolved; we read until we see that
 * sentinel and resolve with the port.
 *
 * The child is spawned (not in-process) because `server/db.ts` builds
 * its singleton pg pool at module load against `env.DATABASE_URL`, and
 * we cannot rebind that pool to a different URL once it is constructed.
 * Spawning gives each worker its own Node process whose singleton pool
 * is bound to its own per-worker DB on first import.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

export interface SpawnedTestApp {
  pid: number;
  port: number;
  kill: () => void;
}

export interface SpawnTestAppOptions {
  /** Per-worker DB URL injected as `DATABASE_URL` for the child. */
  databaseUrl: string;
  /** Inherit & override env entries; merged on top of `process.env`. */
  envOverrides?: Record<string, string>;
  /** Milliseconds to wait for `[ready] port=…` before giving up. */
  readyTimeoutMs?: number;
}

export async function spawnTestApp(opts: SpawnTestAppOptions): Promise<SpawnedTestApp> {
  // 60s (was 30s). Under the `parallel` vitest project (isolate:false,
  // 4 forks) the spawned per-worker app occasionally takes >30s to
  // reach `[ready] port=…` because the 4 forks all hammer Neon-branch
  // creation + schema install at once. Bumping to 60s eliminates the
  // spawnTestApp-timeout flake (5 files affected: email-change,
  // setup-admin-header, check-log-debug-pii, check-provider-not-configured,
  // check-wire-sanitization) without slowing healthy spawns (they still
  // resolve in ~3s — the timeout only fires on the contention tail).
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;

  // Quieter-by-opt-in: setting LV_TEST_QUIET_APP=1 lowers the spawned
  // app's LOG_LEVEL to `warn` and stops mirroring its stdout to the
  // parent. Default-off because an earlier always-on attempt produced
  // sporadic 30s spawn timeouts in the `parallel` project with empty
  // stdout/stderr — root cause not yet pinned down. The reporter-side
  // truncation fix (JSON reporter + summary-reporter.ts) handles the
  // user-visible problem on its own; this flag is here for the day
  // someone wants to wring more bytes out of the workflow log buffer.
  const quietApp = process.env.LV_TEST_QUIET_APP === '1';
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: opts.databaseUrl,
    TEST_APP_PORT: '0',
    SUPPRESS_BACKGROUND_WORKERS: '1',
    // Keep the spawned app on the local/test defaults that make the suite
    // deterministic. We deliberately leave APP_ENV unset so config resolves
    // it to 'dev' (the schema does not accept 'test').
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    // Quiet-mode contract is "be quiet regardless of parent env".
    // Using `process.env.LOG_LEVEL ?? 'warn'` would let an inherited
    // `LOG_LEVEL=info` defeat the quiet flag. Hard-set to `warn` here;
    // explicit `opts.envOverrides.LOG_LEVEL` (merged below) still wins.
    ...(quietApp ? { LOG_LEVEL: 'warn' } : {}),
    ...(opts.envOverrides ?? {}),
  };

  // We invoke the current Node binary directly with `--import tsx` so
  // the rule against literal `'npx'`/`'tsx'` first arguments doesn't
  // need an opt-out. tsx is registered as a loader rather than spawned
  // as a CLI, which also shaves cold-start time.
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/test-entry.ts'],
    {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdout === null || childStderr === null) {
    throw new Error('spawnTestApp: child stdout/stderr unavailable');
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  childStderr.setEncoding('utf8');
  childStderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-32_000);
  });

  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(
        `spawnTestApp: timed out after ${readyTimeoutMs}ms waiting for [ready] port=… line.\n` +
        `--- stdout (tail) ---\n${stdoutBuf.slice(-4_000)}\n--- stderr (tail) ---\n${stderrBuf.slice(-4_000)}`,
      ));
    }, readyTimeoutMs);

    childStdout.setEncoding('utf8');
    childStdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      // Cap pre-ready buffer; we only need the [ready] sentinel + a
      // tail for failure diagnostics if we time out.
      if (stdoutBuf.length > 64_000) stdoutBuf = stdoutBuf.slice(-32_000);
      // Mirror child stdout to parent unless the user opts into the
      // quieter mode via LV_TEST_QUIET_APP=1 (paired with the
      // LOG_LEVEL=warn override above). Default-on preserves the
      // original behaviour and avoids the spawn-timeout regression
      // we observed when both knobs were flipped at once.
      if (!quietApp) {
        process.stdout.write(chunk);
      }
      const m = stdoutBuf.match(/\[ready\] port=(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(
        `spawnTestApp: child exited prematurely (code=${code}, signal=${signal}) before [ready] line.\n` +
        `--- stdout (tail) ---\n${stdoutBuf.slice(-4_000)}\n--- stderr (tail) ---\n${stderrBuf.slice(-4_000)}`,
      ));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  return {
    pid: child.pid ?? -1,
    port,
    kill: () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      // Hard-kill backstop in case SIGTERM is swallowed.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, 2_000).unref();
    },
  };
}

// Allow `await once(child, 'exit')` ergonomics elsewhere if needed.
export { once };
