/**
 * Tests the nested-link/button CI guard introduced in task
 * #617 (`scripts/check-no-nested-link-button.ts`).
 *
 * The guard walks every `.tsx` file under `client/src/` and
 * fails when a wouter `<Link>` directly contains a `<button>`
 * / `<Button>` (or vice versa). It skips the canonical
 * `<Button asChild><Link/></Button>` pattern adopted in
 * tasks #596 / #601.
 *
 * These tests drive the script against synthetic fixtures via
 * spawnSync to pin its detection logic for: clean files,
 * `<Link><Button/></Link>`, `<Link><button/></Link>`,
 * `<Button><Link/></Button>`, the canonical
 * `<Button asChild><Link/></Button>` pass, files where `Link`
 * doesn't come from wouter, fragment / conditional child shapes,
 * `--report` mode, multiple sites, and `.test.tsx` skipping.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-no-nested-link-button.ts');

function runIn(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  // Resolve `tsx` against the real project's node_modules so
  // the synthetic fixtures (which have no node_modules of their
  // own) can still spawn the script.
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-no-nested-link-button-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

describe('check-no-nested-link-button (synthetic fixtures)', () => {
  it('passes when no <Link>/<Button> nesting exists', () => {
    const dir = makeFixture({
      'client/src/clean.tsx': `import { Link } from 'wouter';
export function Clean() {
  return <div><Link href="/x">Go</Link></div>;
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('fails when a wouter <Link> directly contains a shadcn <Button>', () => {
    const dir = makeFixture({
      'client/src/bad.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Bad() {
  return (
    <Link href="/x">
      <Button>Go</Button>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/client\/src\/bad\.tsx:5/);
    expect(r.stderr).toMatch(/<Link>.*directly contains <Button>/);
  });

  it('passes the canonical <Button asChild><Link/></Button> fix', () => {
    const dir = makeFixture({
      'client/src/good.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Good() {
  return (
    <Button asChild>
      <Link href="/x">Go</Link>
    </Button>
  );
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('still flags asChild={false} (the slot pattern is opted out)', () => {
    const dir = makeFixture({
      'client/src/asfalse.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Bad() {
  return (
    <Button asChild={false}>
      <Link href="/x">Go</Link>
    </Button>
  );
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/<Button> directly contains a wouter <Link>/);
  });

  it('ignores files that import Link from somewhere other than wouter', () => {
    const dir = makeFixture({
      'client/src/other-link.tsx': `import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
export function Other() {
  // Not a wouter Link — out of scope for this guard.
  return (
    <Link to="/x">
      <Button>Go</Button>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('flags <Link>{cond && <Button/>}</Link> (JSX expression child)', () => {
    const dir = makeFixture({
      'client/src/cond.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Cond({ show }: { show: boolean }) {
  return (
    <Link href="/x">
      {show && <Button>Go</Button>}
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/directly contains <Button>/);
  });

  it('fails when a <Button> is wrapped in a styling <div> inside a <Link> (task #645)', () => {
    const dir = makeFixture({
      'client/src/wrapped-div.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Wrapped() {
  return (
    <Link href="/x">
      <div className="rounded p-4 hover:bg-muted">
        <Button>Go</Button>
      </div>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/<Link>.*directly contains <Button>/);
    expect(r.stderr).toMatch(/client\/src\/wrapped-div\.tsx:5/);
  });

  it('does NOT descend into custom components — <Link><MyCard><Button/></MyCard></Link> stays untouched (task #645)', () => {
    const dir = makeFixture({
      'client/src/custom-wrapper.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
function MyCard({ children }: { children: React.ReactNode }) { return <div>{children}</div>; }
export function Custom() {
  return (
    <Link href="/x">
      <MyCard>
        <Button>Go</Button>
      </MyCard>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    // Custom components can render anything (including <a>'s
    // own slot via Radix), so the guard deliberately stops at
    // the first non-host wrapper. The MyCard subtree is out of
    // scope.
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('does NOT false-positive on <Link><Button asChild>…</Button></Link> intentional opt-outs (task #645)', () => {
    // <Button asChild> doesn't render its own <button> — Radix's
    // Slot merges Button styling onto the child element (here
    // the inner <span>), so the resulting DOM is just
    // <a><span class="…btn styles…">Go</span></a> — a single
    // interactive element, no nested <button> in <a>. The
    // guard must let this pass.
    const dir = makeFixture({
      'client/src/optout.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function OptOut() {
  return (
    <Link href="/x">
      <Button asChild>
        <span>Go</span>
      </Button>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('fails when a wouter <Link> directly contains another wouter <Link> (task #656)', () => {
    const dir = makeFixture({
      'client/src/nested-link.tsx': `import { Link } from 'wouter';
export function Nested() {
  return (
    <Link href="/outer">
      <Link href="/inner">Inner</Link>
    </Link>
  );
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/<Link>.*directly contains <Link>/);
    expect(r.stderr).toMatch(/client\/src\/nested-link\.tsx:4/);
    expect(r.stderr).toMatch(/<a><a><\/a><\/a>/);
    expect(r.stderr).toMatch(/Collapse to a single <Link>/);
  });

  it('does NOT flag an outer <a> wrapping a wouter <Link> (out of scope — only outer <Link> is checked)', () => {
    // Only the outer-<Link>-containing-anchor shape is in
    // scope for task #656; an outer plain <a> is left to other
    // guards / human review.
    const dir = makeFixture({
      'client/src/anchor-outer.tsx': `import { Link } from 'wouter';
export function Outer() {
  return (
    <a href="/outer">
      <Link href="/inner">Inner</Link>
    </a>
  );
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('reports multiple violations across the same file', () => {
    const dir = makeFixture({
      'client/src/many.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function A() {
  return <Link href="/a"><Button>A</Button></Link>;
}
export function B() {
  return <Button><Link href="/b">B</Link></Button>;
}
export function C() {
  return <Link href="/c"><button type="button">C</button></Link>;
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/3 nested <Link>\/<Button> site\(s\)/);
    expect(r.stderr).toMatch(/client\/src\/many\.tsx:4/);
    expect(r.stderr).toMatch(/client\/src\/many\.tsx:7/);
    expect(r.stderr).toMatch(/client\/src\/many\.tsx:10/);
  });

  it('--report mode prints violations but exits 0', () => {
    const dir = makeFixture({
      'client/src/bad.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Bad() {
  return <Link href="/x"><Button>Go</Button></Link>;
}
`,
    });
    const r = runIn(dir, ['--report']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/REPORT/);
    expect(r.stderr).toMatch(/directly contains <Button>/);
  });

  it('skips .test.tsx files (production guards must not cascade into test fixtures)', () => {
    const dir = makeFixture({
      'client/src/ok.tsx': `import { Link } from 'wouter';
export function Ok() { return <Link href="/x">Go</Link>; }
`,
      'client/src/legacy.test.tsx': `import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
export function Bad() {
  return <Link href="/x"><Button>Go</Button></Link>;
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-no-nested-link-button] OK'),
    });
  });

  it('fails loud (exit 2) when client/src has no .tsx files (refuses to silently pass)', () => {
    const dir = makeFixture({
      'client/src/.gitkeep': '',
    });
    const r = runIn(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no \.tsx files found/);
  });
});
