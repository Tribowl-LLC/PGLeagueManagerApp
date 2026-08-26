/**
 * Tests the cross-org isolation coverage guard introduced in task #345.
 *
 * The guard (`scripts/check-org-isolation-coverage.ts`) walks every
 * router file under `server/routes/`, finds id-bearing GET endpoints
 * (handlers that read `req.query.<entity>Id` or whose path includes
 * `:id` / `:<entity>Id`), and verifies each effective path is named
 * in `tests/api/organization-isolation.test.ts`. Default mode prints
 * a report and exits 0; `--strict` exits 1 when uncovered endpoints
 * are found.
 *
 * These tests drive the script against synthetic fixtures via a
 * `--strict` run to pin down its detection logic for: filtered
 * lists with and without coverage, fetch-by-id endpoints with and
 * without coverage, multi-param paths, plain GETs that don't
 * qualify, and id-shape filtering for path params.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-org-isolation-coverage.ts');

function runIn(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    // The fixture `cwd` (a tmpdir) has no local `node_modules`, so a bare
    // `npx tsx` there tries to *install* tsx and fails in clean CI. Putting
    // the repo's `node_modules/.bin` on PATH makes npx run the already-
    // installed tsx binary directly instead of reaching for the network.
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PATH: `${join(process.cwd(), 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-iso-check-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

/**
 * Convenience: a minimal `routes/index.ts` that mounts the named
 * router file at the given prefix. The fixture script doesn't need
 * to actually run — only the source text is parsed.
 */
function indexMounting(prefix: string, routerImport: string): string {
  return `import express from 'express';
import myRouter from './${routerImport}.js';
const app = express();
app.use('${prefix}', myRouter);
`;
}

describe('check-org-isolation-coverage CI guard', () => {
  it('passes (--strict) when every id-bearing GET endpoint is referenced in the test', () => {
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting('/api/widgets', 'widgets'),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
  const teamId = req.query.teamId ? Number(req.query.teamId) : null;
  res.json({ teamId });
});
router.get('/:id', async (req, res) => {
  res.json({ id: req.params.id });
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// fixture isolation test
import { apiGet } from '../helpers';
await apiGet(\`/api/widgets?teamId=\${otherOrgTeamId}\`, sessionA);
await apiGet(\`/api/widgets/\${otherOrgWidgetId}\`, sessionA);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/OK/);
  });

  it('fails (--strict) when a filtered-list endpoint is not referenced in the test', () => {
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting('/api/widgets', 'widgets'),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
  const teamId = req.query.teamId ? Number(req.query.teamId) : null;
  res.json({ teamId });
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// fixture: no /api/widgets references
import { apiGet } from '../helpers';
await apiGet('/api/something-else', sessionA);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/GET \/api\/widgets/);
    expect(r.stderr).toMatch(/teamId/);
  });

  it('fails (--strict) when a fetch-by-id endpoint is not referenced in the test', () => {
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting('/api/widgets', 'widgets'),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/:id', async (req, res) => {
  res.json({ id: req.params.id });
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// fixture: no /api/widgets/:id references
import { apiGet } from '../helpers';
await apiGet('/api/something-else', sessionA);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/GET \/api\/widgets\/:id/);
  });

  it('matches multi-param paths against template-literal references', () => {
    // Parameterized paths are referenced as template literals in the live
    // isolation tests. The previous substring approach (replacing each
    // `:param` with `${`) produced `/${/${` and false-flagged multi-param
    // paths as uncovered. This test pins the regex fix.
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting(
        '/api/widgets',
        'widgets',
      ),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/:widgetId/:ownerId', async (req, res) => {
  res.json({});
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `import { apiGet } from '../helpers';
await apiGet(\`/api/widgets/\${otherWidgetId}/\${otherOwnerId}\`, sessionA);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  it('does not flag GETs that have no id-shaped path or query param', () => {
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting('/api/widgets', 'widgets'),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
  // plain list with no id-shaped query param — out of scope
  res.json([]);
});
router.get('/health', async (req, res) => {
  res.json({ ok: true });
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// no /api/widgets references — should still pass
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/scanned 0 id-bearing GET endpoint/);
  });

  it('does not flag non-id-shaped path params like :slug, :type, :weekNumber', () => {
    // Task #345 explicitly scopes the lint to req.params.<entity>Id
    // (and `:id`) — public slug-based lookups and non-id segments
    // have different cross-org semantics and are out of scope.
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting(
        '/api/organizations',
        'organizations',
      ),
      'server/routes/organizations.ts': `import { Router } from 'express';
const router = Router();
router.get('/check-slug/:slug', async (req, res) => res.json({}));
router.get('/orphaned/:type', async (req, res) => res.json({}));
router.get('/scores/:weekNumber', async (req, res) => res.json({}));
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// no references — these endpoints are out of scope
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/scanned 0 id-bearing GET endpoint/);
  });

  it('resolves nested router.use(...) composition (e.g. payments sub-routers)', () => {
    // Real codebase pattern: server/routes/payments/index.ts mounts
    // multiple sub-routers via `router.use('/', subRouter)`. The
    // guard must propagate the parent prefix so a sub-router GET
    // ends up at the right effective path.
    const dir = makeFixture({
      'server/routes/index.ts': `import express from 'express';
import paymentsRouter from './payments/index.js';
const app = express();
app.use('/api/payments', paymentsRouter);
`,
      'server/routes/payments/index.ts': `import { Router } from 'express';
import reportsRouter from './reports.js';
const router = Router();
router.use('/', reportsRouter);
export default router;
`,
      'server/routes/payments/reports.ts': `import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : null;
  res.json({ leagueId });
});
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// missing reference — should fail
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/GET \/api\/payments/);
    expect(r.stderr).toMatch(/leagueId/);
  });

  it('exits 0 in advisory mode even with uncovered endpoints (warn-only by default)', () => {
    const dir = makeFixture({
      'server/routes/index.ts': indexMounting('/api/widgets', 'widgets'),
      'server/routes/widgets.ts': `import { Router } from 'express';
const router = Router();
router.get('/:id', async (req, res) => res.json({ id: req.params.id }));
export default router;
`,
      'tests/api/organization-isolation.test.ts': `// no references
`,
    });
    const r = runIn(dir);
    // Advisory: prints WARN but exit 0.
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN/);
    expect(r.stderr).toMatch(/GET \/api\/widgets\/:id/);
  });

  it('respects EXPLICIT_ALLOWLIST entries (no false positives for documented exceptions)', () => {
    // We can't easily mutate the allowlist from a test, but we can
    // assert the script doesn't flag effective paths that ARE in the
    // shipped allowlist. The default allowlist is empty, so this
    // test instead asserts the list-comment shape: any allowlist
    // entry must come with a justification (the comment line).
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const allowlistBlock = src.match(
      /EXPLICIT_ALLOWLIST: Record<string, string> = \{([\s\S]*?)\};/,
    );
    expect(allowlistBlock, 'allowlist block must exist').toBeTruthy();
    if (allowlistBlock) {
      const body = allowlistBlock[1];
      // Every non-empty, non-comment line must have a string-literal
      // value (the rationale) — the type already enforces a string,
      // but this asserts the convention that values aren't empty.
      const entryLines = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'));
      for (const line of entryLines) {
        expect(line, `allowlist entry must have a value: ${line}`).toMatch(
          /:\s*['"`].+['"`]/,
        );
      }
    }
  });
});
