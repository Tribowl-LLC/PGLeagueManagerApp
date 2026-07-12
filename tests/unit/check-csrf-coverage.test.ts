/**
 * Tests the CSRF coverage CI guard introduced in task #308 and
 * extended in task #338.
 *
 * The guard (`scripts/check-csrf-coverage.ts`) walks every `.ts` file
 * under `server/` and fails if any state-changing route — whether
 * mounted directly via `app.<method>(...)` or transitively via
 * `app.use('<prefix>', <importedRouter>)` plus `router.<method>(...)`
 * inside the imported router file — has an effective path outside
 * `/api/` without an explicit allowlist entry.
 *
 * These tests run the real script against synthetic fixtures
 * covering both the direct-on-app violation and the sub-router
 * violation.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-csrf-coverage.ts');

// Use the locally-installed tsx binary directly rather than `npx tsx`:
// in CI `npx` may try to resolve/install tsx over the network, and a
// corrupted download pollutes stderr and leaves the script unrun.
function runIn(cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Build a synthetic fixture directory. `files` maps relative paths
 * (inside the fixture) to file contents. The fixture always lives
 * under a fresh tmpdir so each test is isolated.
 */
function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'csrf-check-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function makeIndexFixture(indexContents: string): string {
  return makeFixture({ 'server/index.ts': indexContents });
}

describe('check-csrf-coverage CI guard', () => {
  it('fails when a state-changing route is mounted directly on app outside /api', () => {
    const dir = makeIndexFixture(
      `import express from 'express';
const app = express();
app.post('/foo', (req, res) => res.sendStatus(200));
app.use('/api', csrfProtection);
`,
    );
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/POST \/foo/);
  });

  it('does not flag app.post mounted under /api', () => {
    const dir = makeIndexFixture(
      `import express from 'express';
const app = express();
app.post('/api/teams', (req, res) => res.sendStatus(200));
`,
    );
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('does not flag app.get on non-/api paths (GET is not state-changing)', () => {
    const dir = makeIndexFixture(
      `import express from 'express';
const app = express();
app.get('/.well-known/whatever', (req, res) => res.sendStatus(200));
app.get('/manifest.json', (req, res) => res.sendStatus(200));
`,
    );
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('flags a sub-router file mounted at a non-/api prefix', () => {
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
import sneakyRouter from './routes/sneaky.js';
const app = express();
app.use('/foo', sneakyRouter);
app.use('/api', csrfProtection);
`,
      'server/routes/sneaky.ts': `import { Router } from 'express';
const router = Router();
router.post('/bar', (req, res) => res.sendStatus(200));
router.delete('/baz', (req, res) => res.sendStatus(200));
export default router;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/POST \/foo\/bar/);
    expect(r.stderr).toMatch(/DELETE \/foo\/baz/);
    expect(r.stderr).toMatch(/sneaky\.ts/);
  });

  it('does not flag a sub-router file mounted under /api', () => {
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
import goodRouter from './routes/good.js';
const app = express();
app.use('/api/good', goodRouter);
`,
      'server/routes/good.ts': `import { Router } from 'express';
const router = Router();
router.post('/things', (req, res) => res.sendStatus(200));
router.patch('/things/:id', (req, res) => res.sendStatus(200));
export default router;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('flags a nested sub-router composed inside a parent that has no direct routes (task #397)', () => {
    // The exact regression this task targets: parent router lives at
    // /foo and has NO direct routes of its own — its only role is to
    // compose a child via `router.use('/sub', child)`. Before #397,
    // there was no `parent.<method>` call to trip the guard, so the
    // mistake of mounting the parent at non-/api would slip through.
    // After #397, the child file's effective prefix is computed
    // transitively as /foo + /sub, so its post('/x') is flagged at
    // /foo/sub/x.
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
import parentRouter from './routes/parent.js';
const app = express();
app.use('/foo', parentRouter);
app.use('/api', csrfProtection);
`,
      'server/routes/parent.ts': `import { Router } from 'express';
import childRouter from './child.js';
const router = Router();
router.use('/sub', childRouter);
export default router;
`,
      'server/routes/child.ts': `import { Router } from 'express';
const router = Router();
router.post('/x', (req, res) => res.sendStatus(200));
export default router;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/POST \/foo\/sub\/x/);
    expect(r.stderr).toMatch(/child\.ts/);
  });

  it('does not flag a nested sub-router composed under /api', () => {
    // Same composition shape as the test above, just rooted at /api/...
    // — should pass cleanly now that propagation is transitive.
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
import parentRouter from './routes/parent.js';
const app = express();
app.use('/api/parent', parentRouter);
`,
      'server/routes/parent.ts': `import { Router } from 'express';
import childRouter from './child.js';
const router = Router();
router.use('/sub', childRouter);
export default router;
`,
      'server/routes/child.ts': `import { Router } from 'express';
const router = Router();
router.post('/x', (req, res) => res.sendStatus(200));
export default router;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it("flags a default-exported factory router (e.g. `const r = createRouter()`) mounted at non-/api", () => {
    // The per-(file, var) refactor (#446) tracks routes only on
    // identifiers it recognises as Router vars. The recognition
    // primarily comes from `LOCAL_ROUTER_RE` (literal `Router()`/
    // `express.Router()` calls), but a contributor could create a
    // router via a factory wrapper (`createRouter()`) and just
    // export it as default. The guard must still treat the default-
    // exported identifier as the file's effective Router so that
    // routes registered on it are attributed and a non-/api mount
    // gets flagged. Without this admit-rule, the prior file-as-
    // router model would catch it but the per-var model wouldn't —
    // a strict regression of guard coverage.
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
import factoryRouter from './routes/factory.js';
const app = express();
app.use('/foo', factoryRouter);
app.use('/api', csrfProtection);
`,
      'server/routes/factory.ts': `import { Router } from 'express';
function createRouter() { return Router(); }
const r = createRouter();
r.post('/x', (req, res) => res.sendStatus(200));
export default r;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/POST \/foo\/x/);
    expect(r.stderr).toMatch(/factory\.ts/);
  });

  it('does not flag a router file with no recorded mount (orphan/dead code)', () => {
    // No app.use(..., orphanRouter) anywhere — the guard skips it
    // because there's no live exposure to compute an effective path
    // for. (A separate dead-code check would be the right place to
    // catch this; it's out of scope for the CSRF guard.)
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
const app = express();
app.use('/api', csrfProtection);
`,
      'server/routes/orphan.ts': `import { Router } from 'express';
const router = Router();
router.post('/whatever', (req, res) => res.sendStatus(200));
export default router;
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('skips files under __tests__ directories', () => {
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
const app = express();
app.use('/api', csrfProtection);
`,
      'server/__tests__/fixture.ts': `import express from 'express';
const app = express();
app.post('/test-only', (req, res) => res.sendStatus(200));
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('skips *.test.ts files', () => {
    const dir = makeFixture({
      'server/index.ts': `import express from 'express';
const app = express();
app.use('/api', csrfProtection);
`,
      'server/something.test.ts': `import express from 'express';
const app = express();
app.post('/in-a-test', (req, res) => res.sendStatus(200));
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  // ----------------------------------------------------------------
  // `app.use('<path>', <inlineHandler>)` and
  // `router.use('<path>', <inlineHandler>)` coverage (task #471).
  //
  // Express's `.use(string, handler)` form installs the handler for
  // EVERY HTTP method on the path prefix — structurally identical to
  // `.all()` — so an inline arrow/function literal or an identifier
  // that doesn't resolve to a Router (i.e. a handler/middleware
  // import rather than a sub-router) outside `/api/` silently
  // bypasses the global CSRF mount. The earlier guard only
  // recognised `.use(...)` as a router mount and dropped the call
  // when the rest-args didn't resolve to one, leaving this hole
  // open. These tests pin down the new branch.
  // ----------------------------------------------------------------

  it('flags app.use with an inline arrow handler at a non-/api path (#471)', () => {
    const dir = makeIndexFixture(
      `import express from 'express';
const app = express();
app.use('/foo', (req, res) => res.sendStatus(200));
app.use('/api', csrfProtection);
`,
    );
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/USE \/foo/);
  });

  it('does not flag app.use(<middleware>) when mounted under /api (#471 negative twin)', () => {
    // `app.use('/api', csrfProtection)` is the global CSRF mount
    // itself — `csrfProtection` is a named-imported middleware, not
    // a Router. The new handler-mount branch would classify this
    // call as a handler mount, but the prefix is /api so the
    // violation check skips it (existing behaviour preserved).
    const dir = makeIndexFixture(
      `import express from 'express';
const app = express();
app.use('/api', csrfProtection);
`,
    );
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  });

});
