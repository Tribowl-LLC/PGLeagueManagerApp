/**
 * Tests the raw-row wire-sanitization CI guard introduced in task
 * #382, extended to Location/Bowler in task #505, and extended to
 * Payment in task #536.
 *
 * The guard (`scripts/check-wire-sanitization.ts`) loads the project's
 * TypeScript program and fails when `sendSuccess`,
 * `sendPaginatedSuccess`, or `res.json` / `res.status(...).json` is
 * called with a value structurally assignable to the canonical `User`,
 * `Organization`, `Location`, `Bowler`, or `Payment` row type —
 * bypassing `sanitizeUser` / `sanitizeOrg` / `sanitizeLocation` /
 * `sanitizeBowler` / `sanitizePayment` from `server/utils/api.ts`.
 *
 * These tests drive the script against synthetic TypeScript
 * fixtures via spawnSync to pin down its detection logic for:
 * raw-row leak, raw-array leak, spread-of-row leak,
 * shorthand-property leak, `res.json` leak, `res.status(...).json`
 * leak, and the canonical safe wraps (`sanitizeUser`, manual
 * projection, message-only payload). Each fixture builds a
 * self-contained mini-project (its own tsconfig, schema, sanitize
 * helpers) so the test doesn't depend on the live codebase.
 */
import { spawnSync } from 'node:child_process';
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-wire-sanitization.ts');

function runIn(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  // Resolve `tsx` against the real project's node_modules so the
  // synthetic fixtures (which have no node_modules of their own)
  // can still spawn the script.
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Minimal mini-project: tsconfig + canonical schema (User /
 * Organization / Location / Bowler) + sanitize helpers + the
 * user-supplied test files. Each call returns the fixture root so
 * the script can be run against it via `runIn(dir)`.
 *
 * Rationale: the script reads `process.cwd()/tsconfig.json` to
 * build a TypeScript program, so we have to give it a real (if
 * tiny) tsconfig that sees real (if tiny) declarations of every
 * canonical row type the guard knows about. The shapes here mirror
 * the production rows closely enough to exercise the full
 * assignability story (sensitive fields → can't be satisfied by a
 * Sanitized* projection).
 */
function makeFixture(extraFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wire-sanitization-'));

  const writeFile = (rel: string, contents: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  writeFile(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          baseUrl: '.',
          paths: { '@shared/*': ['./shared/*'] },
          types: [],
        },
        include: ['server/**/*', 'shared/**/*'],
      },
      null,
      2,
    ),
  );

  writeFile(
    'shared/schema/users.ts',
    `export type User = {
  id: number;
  email: string;
  password: string;
  name: string;
  secret: string;
  createdAt: string;
};
`,
  );

  writeFile(
    'shared/schema/organizations.ts',
    `export type Organization = {
  id: number;
  name: string;
  slug: string;
  integrations: Record<string, unknown>;
  createdAt: string;
};
`,
  );

  writeFile(
    'shared/schema/locations.ts',
    `export type Location = {
  id: number;
  name: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  organizationId: number;
  paymentProvider: string;
  squareCredentials: Record<string, unknown>;
  cloverCredentials: Record<string, unknown>;
};
`,
  );

  writeFile(
    'shared/schema/bowlers.ts',
    `export type Bowler = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  organizationId: number;
  paymentCustomerId: string | null;
  cloverCustomerId: string | null;
  paymentProviderLocationId: number | null;
};
`,
  );

  writeFile(
    'shared/schema/payments.ts',
    `export type Payment = {
  id: number;
  bowlerId: number;
  leagueId: number;
  amount: number;
  status: string;
  type: string;
  providerPaymentId: string | null;
  cloverChargeId: string | null;
  // A future sensitive column the safe-list / sanitizer would have
  // to drop, mirroring the squareCredentials shape on Location: any
  // route returning a raw Payment would ship this verbatim, so the
  // structural lint must catch the leak here too.
  processorWebhookSecret: string | null;
  createdAt: string;
};
`,
  );

  writeFile(
    'shared/schema/index.ts',
    `export type { User } from './users';
export type { Organization } from './organizations';
export type { Location } from './locations';
export type { Bowler } from './bowlers';
export type { Payment } from './payments';
`,
  );

  writeFile(
    'server/utils/api.ts',
    `import type { User } from '../../shared/schema/users';
import type { Organization } from '../../shared/schema/organizations';
import type { Location } from '../../shared/schema/locations';
import type { Bowler } from '../../shared/schema/bowlers';
import type { Payment } from '../../shared/schema/payments';

export type SanitizedUser = Pick<User, 'id' | 'email' | 'name' | 'createdAt'>;
export type SanitizedOrganization = Pick<Organization, 'id' | 'name' | 'slug' | 'createdAt'>;
export type SanitizedLocation = Pick<Location, 'id' | 'name' | 'address' | 'city' | 'state' | 'zipCode' | 'organizationId' | 'paymentProvider'>;
export type SanitizedBowler = Pick<Bowler, 'id' | 'name' | 'email' | 'phone' | 'active' | 'organizationId' | 'paymentCustomerId'>;
export type SanitizedPayment = Pick<Payment, 'id' | 'bowlerId' | 'leagueId' | 'amount' | 'status' | 'type' | 'providerPaymentId' | 'cloverChargeId' | 'createdAt'>;

// Deny-list (#501): the inverse of the safe lists above. The script
// reads these constants out of this file via the AST. Mirrors the
// shape used in the real server/utils/api.ts so the fixture path
// and the production path exercise the same parser.
export const SENSITIVE_USER_FIELDS = ['password', 'secret'] as const;
export const SENSITIVE_ORG_FIELDS = ['integrations'] as const;

// Stubbed bodies — the guard never executes, only type-checks.
export function sanitizeUser(u: User): SanitizedUser {
  return u as unknown as SanitizedUser;
}
export function sanitizeOrg(o: Organization): SanitizedOrganization {
  return o as unknown as SanitizedOrganization;
}
export function sanitizeLocation(l: Location): SanitizedLocation {
  return l as unknown as SanitizedLocation;
}
export function sanitizeLocations(ls: Location[]): SanitizedLocation[] {
  return ls.map(sanitizeLocation);
}
export function sanitizeBowler(b: Bowler): SanitizedBowler {
  return b as unknown as SanitizedBowler;
}
export function sanitizeBowlers(bs: Bowler[]): SanitizedBowler[] {
  return bs.map(sanitizeBowler);
}
export function sanitizePayment(p: Payment): SanitizedPayment {
  return p as unknown as SanitizedPayment;
}
export function sanitizePayments(ps: Payment[]): SanitizedPayment[] {
  return ps.map(sanitizePayment);
}

// Minimal Response stand-in so we don't need express in the fixture.
export interface Response {
  status(code: number): Response;
  json(data: unknown): void;
}

export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}
export function sendPaginatedSuccess<T>(
  res: Response,
  data: T[],
  pagination: { page: number; limit: number },
): void {
  res.status(200).json({ success: true, data, pagination });
}
`,
  );

  for (const [rel, contents] of Object.entries(extraFiles)) {
    writeFile(rel, contents);
  }

  return dir;
}

describe('check-wire-sanitization CI guard', () => {
  it('flags sendSuccess(res, user) where user is User', () => {
    const dir = makeFixture({
      'server/leak.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const user: User;
export function bad() { sendSuccess(res, user); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/sendSuccess\(\) <- User/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  it('does NOT flag sanitizeUser(user)', () => {
    const dir = makeFixture({
      'server/safe.ts': `import type { User } from '@shared/schema';
import { sendSuccess, sanitizeUser, type Response } from './utils/api';
declare const res: Response;
declare const user: User;
export function ok() { sendSuccess(res, sanitizeUser(user)); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  it('flags a helper whose return type embeds a User in a property', () => {
    // The guard must descend into properties of named (non-anonymous)
    // object types so a future helper like `buildAccountResponse(user)`
    // returning `{ user: User; emailSent: boolean }` can't smuggle a
    // raw row past the wire-sanitization check just by hiding it
    // behind a wrapper at the call site.
    const dir = makeFixture({
      'server/leak.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const user: User;
function buildAccountResponse(u: User) {
  return { user: u, emailSent: true };
}
export function bad() { sendSuccess(res, buildAccountResponse(user)); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/<- User/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  // ---------------------------------------------------------------
  // Deny-list pass (task #501) — catches hand-rolled projections
  // that pick a SUBSET of a User/Organization row and include a
  // sensitive column. These shapes are NOT structurally assignable
  // to the full row (they're missing required columns), so they
  // pass the structural assignability pass above and have to be
  // caught by the name-based deny-list pass instead.
  // ---------------------------------------------------------------

  it('flags a manual { id, password: u.password } projection (initializer leak)', () => {
    // The canonical motivating case: a route that hand-builds an
    // object containing the user's id alongside their hashed
    // password. The shape is `{ id: number, password: string }` —
    // assignable to neither `User` (missing required columns) nor
    // `SanitizedUser` (extra `password` key would be a TS error in
    // strict mode, but most call sites are not annotated). The
    // deny-list scanner catches it via the property NAME `password`.
    const dir = makeFixture({
      'server/leak.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const u: User;
export function bad() { sendSuccess(res, { id: u.id, password: u.password }); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/<- sensitive:password/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  it('does NOT flag a manual projection of only safe fields', () => {
    // The negative half of the contract: a hand-rolled subset that
    // only picks columns on the safe list (id, email, name) is the
    // intended escape hatch and must stay green.
    const dir = makeFixture({
      'server/safe.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const u: User;
export function ok() {
  sendSuccess(res, { id: u.id, email: u.email, name: u.name });
}
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  // ---------------------------------------------------------------
  // Location / Bowler structural assignability (task #505) — same
  // pass-1 contract as User/Organization, just expanded to two more
  // canonical row types. The acceptance criterion is that adding
  // `sendSuccess(res, bowler)` or `res.json(location)` back to a
  // route fails the lint, and that the existing wraps in
  // `server/routes/{locations,bowlers,user-bowlers,teams}.ts`
  // (#381) stay green — the latter is covered by the
  // "runs against the real codebase" test above.
  // ---------------------------------------------------------------

  it('flags res.json(location) where location is Location', () => {
    const dir = makeFixture({
      'server/leak.ts': `import type { Location } from '@shared/schema';
import { type Response } from './utils/api';
declare const res: Response;
declare const location: Location;
export function bad() { res.json(location); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/res\.json\(\) <- Location/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  it('does NOT flag sanitizeLocation(location) / sanitizeLocations(list)', () => {
    const dir = makeFixture({
      'server/safe.ts': `import type { Location } from '@shared/schema';
import { sendSuccess, sanitizeLocation, sanitizeLocations, type Response } from './utils/api';
declare const res: Response;
declare const location: Location;
declare const locations: Location[];
export function ok1() { sendSuccess(res, sanitizeLocation(location)); }
export function ok2() { sendSuccess(res, sanitizeLocations(locations)); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  // ---------------------------------------------------------------
  // Payment structural assignability (task #536) — same pass-1
  // contract as User/Organization/Location/Bowler, expanded to
  // cover the canonical Payment row type. Acceptance: a future
  // route that returns `storage.getPayment*` output through
  // `sendSuccess` / `res.json` / a paginated wrapper without
  // calling `sanitizePayment` / `sanitizePayments` fails the
  // lint, and the existing wraps in
  // `server/routes/payments/{payment-reports,payment-record,payment-refunds}.ts`
  // (#504) plus `server/routes/admin.ts` and
  // `server/routes/bowlers.ts` stay green — the latter is
  // covered by the "runs against the real codebase" test above.
  // ---------------------------------------------------------------

  it('flags sendSuccess(res, payment) where payment is Payment', () => {
    const dir = makeFixture({
      'server/leak.ts': `import type { Payment } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const payment: Payment;
export function bad() { sendSuccess(res, payment); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/sendSuccess\(\) <- Payment/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  it('does NOT flag sanitizePayment(payment) / sanitizePayments(list)', () => {
    // The canonical safe wraps. `SanitizedPayment` is a
    // `Pick<Payment, …>` missing `processorWebhookSecret`, so it
    // is NOT structurally assignable to `Payment` and the guard
    // stays silent.
    const dir = makeFixture({
      'server/safe.ts': `import type { Payment } from '@shared/schema';
import { sendSuccess, sendPaginatedSuccess, sanitizePayment, sanitizePayments, type Response } from './utils/api';
declare const res: Response;
declare const payment: Payment;
declare const payments: Payment[];
export function ok1() { sendSuccess(res, sanitizePayment(payment)); }
export function ok2() { sendSuccess(res, sanitizePayments(payments)); }
export function ok3() { sendSuccess(res, payments.map(sanitizePayment)); }
export function ok4() {
  sendPaginatedSuccess(res, sanitizePayments(payments), { page: 1, limit: 50 });
}
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  // ---------------------------------------------------------------
  // String-index / dictionary-shape descent (task #532). The earlier
  // structural pass walked union members, numeric-index types, and
  // named properties of object/intersection types — so a helper
  // returning `{ user: User }` was caught (task #500). It did NOT
  // walk string-index types, which meant `Record<string, User>` (or
  // any object whose only access path is a string index signature
  // like `{ [orgSlug: string]: Organization }`) sneaked past the
  // guard: the bare Record has no enumerable named properties to
  // descend into, and the structural assignability check at the top
  // of `findLeakInType` doesn't fire because Record-of-User is not
  // assignable to User itself. Same shape of risk as the numeric-
  // index case (`User[]` would have slipped past before the
  // numeric-index descent was added) — these tests pin the new
  // string-index descent so it can't be removed silently.
  // ---------------------------------------------------------------

  it('flags a helper returning Record<string, User> (the canonical Record leak)', () => {
    const dir = makeFixture({
      'server/leak.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const users: User[];
function buildUserDirectory(list: User[]): Record<string, User> {
  const out: Record<string, User> = {};
  for (const u of list) out[u.email] = u;
  return out;
}
export function bad() { sendSuccess(res, buildUserDirectory(users)); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stdout || r.stderr).toBe(1);
    expect(r.stderr).toMatch(/<- User/);
    expect(r.stderr).toMatch(/leak\.ts/);
  }, 30_000);

  it('does NOT flag Record<string, SanitizedUser> (the safe projected dictionary)', () => {
    // The negative half of the contract. The whole point of the
    // descent is that it sees through the wrapper — but it must
    // still respect the structural assignability check on the
    // VALUE type. A `SanitizedUser` is a `Pick<User, …>` missing
    // the sensitive columns, so it is NOT assignable to `User`,
    // and a `Record<string, SanitizedUser>` is the intended safe
    // shape for a dictionary response. Must stay green.
    const dir = makeFixture({
      'server/safe.ts': `import type { User } from '@shared/schema';
import { sendSuccess, sanitizeUser, type Response, type SanitizedUser } from './utils/api';
declare const res: Response;
declare const users: User[];
function buildSafeDirectory(list: User[]): Record<string, SanitizedUser> {
  const out: Record<string, SanitizedUser> = {};
  for (const u of list) out[u.email] = sanitizeUser(u);
  return out;
}
export function ok() { sendSuccess(res, buildSafeDirectory(users)); }
`,
    });
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  it('--report mode prints the violation table without exiting non-zero', () => {
    const dir = makeFixture({
      'server/leak.ts': `import type { User } from '@shared/schema';
import { sendSuccess, type Response } from './utils/api';
declare const res: Response;
declare const user: User;
export function bad() { sendSuccess(res, user); }
`,
    });
    const r = runIn(dir, ['--report']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/REPORT/);
    expect(r.stderr).toMatch(/<- User/);
  }, 30_000);
});
