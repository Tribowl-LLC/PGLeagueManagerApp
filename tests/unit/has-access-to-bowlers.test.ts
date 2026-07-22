/**
 * Unit tests for hasAccessToBowlers (task #279).
 *
 * Verifies the batched access helper:
 *   - Uses a constant number of storage round-trips (<=2) regardless of N.
 *   - Returns the same per-bowler decisions as the single-bowler helper.
 *   - Honors empty input, all-allowed, all-denied, mixed, org-less bowlers,
 *     system-admin caller, and bowler-self access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const {
  mockGetBowlerLeaguesByBowlerIds,
  mockGetLeaguesByIds,
  mockGetBowlersByIds,
} = vi.hoisted(() => ({
  mockGetBowlerLeaguesByBowlerIds: vi.fn(),
  mockGetLeaguesByIds: vi.fn(),
  mockGetBowlersByIds: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getBowlerLeaguesByBowlerIds: (...args: unknown[]) => mockGetBowlerLeaguesByBowlerIds(...args),
    getLeaguesByIds: (...args: unknown[]) => mockGetLeaguesByIds(...args),
    // Task #342: hasAccessToBowlers now batch-fetches the bowler rows
    // first to short-circuit on the stamped `organizationId` before
    // falling back to the league-based scan. Default the mock to an
    // empty list so existing tests behave as if every bowler is a
    // legacy/orphan row (organizationId === null) — that path matches
    // the pre-#342 behavior the rest of these tests pin.
    getBowlersByIds: (...args: unknown[]) => mockGetBowlersByIds(...args),
  },
}));

import { hasAccessToBowlers } from '../../server/utils/access-control';

type TestUser = {
  id: number;
  role: 'system_admin' | 'org_admin' | 'admin' | 'user';
  organizationId: number | null;
  bowlerId: number | null;
};

function makeReq(user: TestUser | null): Request {
  return { user: user ?? undefined } as unknown as Request;
}

const ORG_A = 100;
const ORG_B = 200;

beforeEach(() => {
  mockGetBowlerLeaguesByBowlerIds.mockReset();
  mockGetLeaguesByIds.mockReset();
  mockGetBowlersByIds.mockReset();
  // Default: no bowler rows returned → every id falls through to the
  // legacy league-based scan (preserving pre-#342 semantics for these
  // unit tests). Tests that want to exercise the org-stamp short-circuit
  // can override this with `.mockResolvedValueOnce(...)`.
  mockGetBowlersByIds.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('hasAccessToBowlers', () => {
  it('returns an empty map for empty input without hitting storage', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    const result = await hasAccessToBowlers(req, []);

    expect(result.size).toBe(0);
    expect(mockGetBowlerLeaguesByBowlerIds).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('denies every bowler when the user is unauthenticated', async () => {
    const result = await hasAccessToBowlers(makeReq(null), [1, 2, 3]);

    expect([...result.entries()]).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(mockGetBowlerLeaguesByBowlerIds).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('allows every bowler in the same org for an org admin (mixed shape, all-allowed)', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 10, leagueId: 1000, teamId: 1 },
      { bowlerId: 11, leagueId: 1001, teamId: 1 },
      { bowlerId: 12, leagueId: 1000, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 1000, organizationId: ORG_A },
      { id: 1001, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [10, 11, 12]);

    expect(result.get(10)).toBe(true);
    expect(result.get(11)).toBe(true);
    expect(result.get(12)).toBe(true);
    expect(mockGetBowlerLeaguesByBowlerIds).toHaveBeenCalledTimes(1);
    expect(mockGetLeaguesByIds).toHaveBeenCalledTimes(1);
  });

  it('denies bowlers in a different org for an org admin (all-denied)', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 20, leagueId: 2000, teamId: 1 },
      { bowlerId: 21, leagueId: 2001, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 2000, organizationId: ORG_B },
      { id: 2001, organizationId: ORG_B },
    ]);

    const result = await hasAccessToBowlers(req, [20, 21]);

    expect(result.get(20)).toBe(false);
    expect(result.get(21)).toBe(false);
  });

  it('returns mixed allowed/denied based on per-bowler league org', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 30, leagueId: 3000, teamId: 1 }, // allowed (ORG_A)
      { bowlerId: 31, leagueId: 3001, teamId: 1 }, // denied (ORG_B)
      { bowlerId: 32, leagueId: 3002, teamId: 1 }, // denied (org-less)
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 3000, organizationId: ORG_A },
      { id: 3001, organizationId: ORG_B },
      { id: 3002, organizationId: null },
    ]);

    const result = await hasAccessToBowlers(req, [30, 31, 32, 33 /* no league entries */]);

    expect(result.get(30)).toBe(true);
    expect(result.get(31)).toBe(false);
    expect(result.get(32)).toBe(false);
    expect(result.get(33)).toBe(false);
  });

  it('denies org-less bowlers even for system_admin (matches single-helper warn-and-skip)', async () => {
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 40, leagueId: 4000, teamId: 1 },
      { bowlerId: 41, leagueId: 4001, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 4000, organizationId: null }, // org-less → denied
      { id: 4001, organizationId: ORG_B }, // any org → allowed for system admin
    ]);

    const result = await hasAccessToBowlers(req, [40, 41]);

    expect(result.get(40)).toBe(false);
    expect(result.get(41)).toBe(true);
  });

  it('denies bowlers with no league entries for every role (incl. system admin)', async () => {
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([]);
    mockGetLeaguesByIds.mockResolvedValue([]);

    const result = await hasAccessToBowlers(req, [50, 51]);

    expect(result.get(50)).toBe(false);
    expect(result.get(51)).toBe(false);
    // No leagues to fetch → second batched read should be skipped.
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('honors the self-access shortcut for the requesting user’s linked bowler', async () => {
    const req = makeReq({ id: 1, role: 'user', organizationId: ORG_A, bowlerId: 99 });

    // Bowler 99 is the caller; no league lookup needed for them.
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      // No entries for 99 — proves self-access bypasses the league check.
      { bowlerId: 60, leagueId: 6000, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 6000, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [99, 60]);

    // Self-access always wins for the caller's own bowler.
    expect(result.get(99)).toBe(true);
    // A plain "user" caller does not get org-wide
    // access. Bowler 60 is in the same org but a league the caller does
    // NOT share (caller has no league entries), so access is denied.
    expect(result.get(60)).toBe(false);
  });

  it('allows a bowler when the requesting user shares one of their leagues', async () => {
    const req = makeReq({ id: 1, role: 'user', organizationId: ORG_B, bowlerId: 70 });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 70, leagueId: 7000, teamId: 1 }, // requester's own league
      { bowlerId: 71, leagueId: 7000, teamId: 2 }, // teammate
      { bowlerId: 72, leagueId: 7001, teamId: 3 }, // unrelated league in ORG_A
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 7000, organizationId: ORG_A },
      { id: 7001, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [71, 72]);

    // Shared league wins even though requester's org doesn't match.
    expect(result.get(71)).toBe(true);
    // No shared league and a different org → denied.
    expect(result.get(72)).toBe(false);
  });

  it('uses a constant number of round-trips regardless of N', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue(
      ids.map((id) => ({ bowlerId: id, leagueId: 9000, teamId: 1 })),
    );
    mockGetLeaguesByIds.mockResolvedValue([{ id: 9000, organizationId: ORG_A }]);

    const result = await hasAccessToBowlers(req, ids);

    expect(result.size).toBe(50);
    for (const id of ids) expect(result.get(id)).toBe(true);
    expect(mockGetBowlerLeaguesByBowlerIds).toHaveBeenCalledTimes(1);
    expect(mockGetLeaguesByIds).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates input ids', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 80, leagueId: 8000, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 8000, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [80, 80, 80]);

    expect(result.size).toBe(1);
    expect(result.get(80)).toBe(true);
    const passedIds = mockGetBowlerLeaguesByBowlerIds.mock.calls[0][0] as number[];
    expect(new Set(passedIds)).toEqual(new Set([80]));
  });
});

/**
 * Task #408 — fast-path safety tests for the owning-organization shortcut.
 *
 * After task #407 made `bowlers.organizationId` NOT NULL, every existing
 * bowler row carries an authoritative org stamp. `hasAccessToBowlers`
 * now uses a fast path: same-org / sysadmin callers are decided directly
 * by the stamp without ever invoking the league-based scan, and admin
 * cross-org callers are denied authoritatively (no league fallback).
 *
 * The cases above intentionally default `getBowlersByIds` to `[]` to
 * pin the *fallback* path. The tests in this block flip that default
 * to pin the *fast path* — specifically:
 *   - same-org caller is decided without a league lookup,
 *   - cross-org admin caller is denied without a league lookup,
 *   - cross-org NON-admin caller falls through to the league scan
 *     (so the bowler-to-bowler same-league rule still works),
 *   - system admin with a stamped bowler is decided without a league lookup,
 *   - missing bowler row (no stamp) falls through to the league scan
 *     and is decided there.
 */
describe('hasAccessToBowlers — owning-org fast path (#342/#407 short-circuit)', () => {
  it('same-org caller: allowed via short-circuit, no league lookups invoked', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    // Stamp matches the caller's org → fast-path allow. The mocks for
    // `getBowlerLeaguesByBowlerIds` / `getLeaguesByIds` are NOT primed
    // because the helper must not reach them.
    mockGetBowlersByIds.mockResolvedValueOnce([
      { id: 100, organizationId: ORG_A },
      { id: 101, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [100, 101]);

    expect(result.get(100)).toBe(true);
    expect(result.get(101)).toBe(true);
    // The whole point of the fast path: no fallback round-trips.
    expect(mockGetBowlerLeaguesByBowlerIds).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('cross-org admin caller: denied via short-circuit, no league fallback', async () => {
    // Admin cross-org is the exact hardening task #407 added: an org_admin
    // with a different stamp must be DENIED without falling through to the
    // league scan, even if a (theoretical) shared-league overlap existed.
    // We prime the league mocks with data that *would* allow access if the
    // helper incorrectly fell through, to guarantee this is a real test
    // of the no-fallback contract.
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlersByIds.mockResolvedValueOnce([
      { id: 200, organizationId: ORG_B }, // mismatched stamp
    ]);
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 200, leagueId: 9999, teamId: 1 },
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 9999, organizationId: ORG_A }, // would erroneously allow on fallback
    ]);

    const result = await hasAccessToBowlers(req, [200]);

    expect(result.get(200)).toBe(false);
    // Caller has `bowlerId: null` and bowler 200 is decided by the
    // stamp gate (admin-deny, no fallthrough), so `stillToCheck` is
    // empty and the helper must early-return BEFORE the batched
    // league lookups. Pinning the no-call here makes the "no fallback
    // for admins" hardening from #407 a real assertion, not just a
    // boolean check that would silently still pass on a regression
    // that re-allowed admin cross-org via the league scan.
    expect(mockGetBowlerLeaguesByBowlerIds).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('cross-org NON-admin caller: short-circuit does NOT allow; falls through to league scan', async () => {
    // The fall-through is intentional for the bowler-to-bowler case: two
    // bowlers who share a league can see each other regardless of stamps.
    // Caller is bowler 70 in ORG_B; target is bowler 71 stamped to ORG_A
    // but they share league 7000. Stamp gate should NOT allow (different
    // org), and the league scan should then allow on the shared league.
    const req = makeReq({ id: 1, role: 'user', organizationId: ORG_B, bowlerId: 70 });

    mockGetBowlersByIds.mockResolvedValueOnce([
      { id: 71, organizationId: ORG_A }, // stamp doesn't match caller's org
    ]);
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([
      { bowlerId: 70, leagueId: 7000, teamId: 1 }, // caller's league
      { bowlerId: 71, leagueId: 7000, teamId: 2 }, // shared league
    ]);
    mockGetLeaguesByIds.mockResolvedValue([
      { id: 7000, organizationId: ORG_A },
    ]);

    const result = await hasAccessToBowlers(req, [71]);

    // Allowed via the league scan, NOT via the stamp gate.
    expect(result.get(71)).toBe(true);
    // The league scan must have been consulted — proves we fell through.
    expect(mockGetBowlerLeaguesByBowlerIds).toHaveBeenCalledTimes(1);
    expect(mockGetLeaguesByIds).toHaveBeenCalledTimes(1);
  });

  it('system admin + stamped bowler: allowed via short-circuit, no league lookups invoked', async () => {
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    mockGetBowlersByIds.mockResolvedValueOnce([
      { id: 300, organizationId: ORG_A },
      { id: 301, organizationId: ORG_B },
    ]);

    const result = await hasAccessToBowlers(req, [300, 301]);

    // Sysadmin gets allowed regardless of which org each bowler is stamped to.
    expect(result.get(300)).toBe(true);
    expect(result.get(301)).toBe(true);
    expect(mockGetBowlerLeaguesByBowlerIds).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('null stamp (defense-in-depth): falls through to league scan, no short-circuit allow even for sysadmin', async () => {
    // The schema enforces NOT NULL on `bowlers.organizationId`, so
    // null stamps are unreachable through normal CRUD. This test
    // pins the defensive runtime guard: per the file-level org-less
    // resource policy, NO role (including system_admin) may
    // short-circuit-allow on a null stamp. The id must fall through
    // to the batched league scan, which then enforces the same
    // policy via continue+debug-log.
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    // Cast through `unknown`: the schema type is `number`; we
    // deliberately construct an "impossible per schema" row to
    // exercise the defensive guard.
    mockGetBowlersByIds.mockResolvedValueOnce([
      { id: 410, organizationId: null } as unknown as { id: number; organizationId: number },
    ]);
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([]); // no league entries → deny
    mockGetLeaguesByIds.mockResolvedValue([]);

    const result = await hasAccessToBowlers(req, [410]);

    expect(result.get(410)).toBe(false);
    // Critically: the batched league scan WAS consulted — proves
    // the helper fell through past the stamp gate instead of
    // short-circuiting on a null stamp for sysadmin.
    expect(mockGetBowlerLeaguesByBowlerIds).toHaveBeenCalledTimes(1);
    const lookupArg = mockGetBowlerLeaguesByBowlerIds.mock.calls[0][0] as number[];
    expect(new Set(lookupArg)).toEqual(new Set([410]));
  });

  it('missing bowler row (no stamp present): falls through to league scan', async () => {
    // After #407 the schema makes `bowlers.organizationId` NOT NULL, so
    // "no stamp" in practice means the row is missing entirely (e.g.
    // deleted concurrently). The helper must NOT short-circuit-allow
    // such rows — it must fall through to the league scan, which will
    // deny because no league entries exist for a non-existent bowler.
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowlersByIds.mockResolvedValueOnce([]); // no bowler row returned
    mockGetBowlerLeaguesByBowlerIds.mockResolvedValue([]); // no league entries
    mockGetLeaguesByIds.mockResolvedValue([]);

    const result = await hasAccessToBowlers(req, [400]);

    expect(result.get(400)).toBe(false);
    // Fell through past the stamp gate into the league scan — proves
    // the short-circuit didn't incorrectly grant access on a missing
    // row. Pin the lookup payload too so a future refactor can't pass
    // this test by querying an unrelated bowler id (which would also
    // happen to return empty here).
    expect(mockGetBowlerLeaguesByBowlerIds).toHaveBeenCalledTimes(1);
    const lookupArg = mockGetBowlerLeaguesByBowlerIds.mock.calls[0][0] as number[];
    expect(new Set(lookupArg)).toEqual(new Set([400]));
  });
});
