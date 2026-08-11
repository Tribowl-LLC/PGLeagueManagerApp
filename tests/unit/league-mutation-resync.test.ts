/**
 * Integration tests for the rename-→-Square-resync chain (task #477).
 *
 * Task #429 wired every league/bowler-league mutation surface to fire
 * `bowler-resync.ts`, which in turn pushes the bowler's
 * `league_name` + `league_season` Square custom attributes. Until now
 * that whole chain was only verified by hand: the unit tests covered
 * the helpers in isolation, and the routes were observed manually in
 * the dev environment.
 *
 * This file mounts the real `leagues` and `bowler-leagues` routers
 * onto an isolated Express app, mocks the boundary modules
 * (`storage`, `payment-provider-factory`,
 * `access-control`, `middleware/organization`, `db.js`,
 * `payment-scheduler.js`), and drives each mutation over real HTTP.
 *
 * For every covered mutation we assert that the fake Square provider
 * received `syncCustomerLeagueAttributes(customerId, bowlerId, attrs)`
 * with the EXPECTED `(leagueName, leagueSeason)` strings derived from
 * the mocked storage state — the exact contract the resync chain is
 * supposed to maintain.
 *
 * Coverage matrix:
 *   PATCH  /api/leagues/:id           — rename
 *   PATCH  /api/leagues/:id/archive   — archive
 *   PATCH  /api/leagues/:id/restore   — restore
 *   DELETE /api/leagues/:id           — delete (uses transaction result ids)
 *   POST   /api/leagues/:id/new-season— season clone
 *   POST   /api/bowler-leagues        — bowler joins a league
 *   PATCH  /api/bowler-leagues/:id    — bowler-league mutation (e.g.
 *                                       team move / active-flip)
 *   DELETE /api/bowler-leagues/:id    — bowler leaves a league (uses
 *                                       pre-captured id)
 *
 * Plus two helper-level guarantees from `bowler-resync.ts`:
 *   - skips the Square branch silently when the bowler has no
 *     `paymentCustomerId` yet (attribute push is not the right time
 *     to create a Square customer)
 *   - flips `payment_sync_pending_at` via `storage.updateBowler` when
 *     the provider returns `{ ok: false }` so the existing
 *     `payment-sync-retry.ts` sweep picks the failure up
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// ---------------------------------------------------------------------------
// Storage mock — every method any route OR helper under test reaches into.
// Methods are reset between tests; per-test setup pre-loads return values.
// ---------------------------------------------------------------------------
const mockStorage = {
  // Leagues
  getLeague: vi.fn(),
  updateLeague: vi.fn(),
  archiveLeague: vi.fn(),
  restoreLeague: vi.fn(),
  deleteLeague: vi.fn(),
  createLeague: vi.fn(),
  getActiveSchedulesByLeague: vi.fn(),
  // Teams
  getTeams: vi.fn(),
  createTeam: vi.fn(),
  deleteTeam: vi.fn(),
  // Bowlers
  getBowler: vi.fn(),
  getBowlers: vi.fn(),
  updateBowler: vi.fn(),
  // Bowler leagues
  getBowlerLeague: vi.fn(),
  getBowlerLeagues: vi.fn(),
  createBowlerLeague: vi.fn(),
  // Task #473: the non-bootstrap POST /api/bowler-leagues path now goes
  // through the atomic `createBowlerLeagueIfNotInLeague` helper instead
  // of `createBowlerLeague`. Tests that previously stubbed the latter
  // also stub this so the route reaches a 201 instead of crashing with
  // "is not a function" → 500.
  createBowlerLeagueIfNotInLeague: vi.fn(),
  updateBowlerLeague: vi.fn(),
  deleteBowlerLeague: vi.fn(),
  createBowlerLeagueIfBowlerFree: vi.fn(),
};
const { LeagueEvidenceError, LeaguePaymentModeError } = vi.hoisted(() => ({
  LeagueEvidenceError: class LeagueOccurrenceEvidenceExistsError extends Error {},
  LeaguePaymentModeError: class LeaguePaymentModeLockedError extends Error {},
}));
const { mockCreateLeagueWithCanonicalSetup, mockCreateNewSeasonWithCanonicalSetup } = vi.hoisted(() => ({
  mockCreateLeagueWithCanonicalSetup: vi.fn(),
  mockCreateNewSeasonWithCanonicalSetup: vi.fn(),
}));
vi.mock('../../server/storage', () => ({ storage: mockStorage }));
vi.mock('../../server/storage/leagues', () => ({
  LeagueOccurrenceEvidenceExistsError: LeagueEvidenceError,
  LeaguePaymentModeLockedError: LeaguePaymentModeError,
}));
vi.mock('../../server/services/league-setup-integration.js', () => ({
  LeagueSetupIntegrationError: class LeagueSetupIntegrationError extends Error {},
  createLeagueWithCanonicalSetup: mockCreateLeagueWithCanonicalSetup,
  createNewSeasonWithCanonicalSetup: mockCreateNewSeasonWithCanonicalSetup,
}));

// ---------------------------------------------------------------------------
// Access-control / org-middleware mocks — let everything through. Auth is
// already covered by other test files; we want to focus on resync wiring.
// ---------------------------------------------------------------------------
vi.mock('../../server/utils/access-control', () => ({
  requireOrganizationAccess: () => true,
  hasAccessToLeague: () => Promise.resolve(true),
  hasAccessToTeam: () => Promise.resolve(true),
  hasAccessToBowler: () => Promise.resolve(true),
  hasSelfOrAdminAccessToBowler: () => Promise.resolve(true),
  isOrgOrHigher: () => true,
}));

vi.mock('../../server/middleware/organization', () => ({
  filterByOrganization: (_req: unknown, _res: unknown, next: () => void) => next(),
  getOrganizationFilter: (req: { user?: { organizationId?: number | null } }) =>
    req.user?.organizationId ?? null,
}));

// ---------------------------------------------------------------------------
// Payment-scheduler / db / email / auth — only touched by route paths we
// don't exercise (timezone changes, fee changes, send-invites). Mock just
// enough to satisfy module load.
// ---------------------------------------------------------------------------
vi.mock('../../server/services/payment-scheduler.js', () => ({
  paymentScheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn() },
}));

vi.mock('../../server/db.js', () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('../../server/services/email', () => ({ sendInviteEmail: vi.fn() }));
vi.mock('../../server/auth', () => ({
  hashPassword: () => Promise.resolve('hashed'),
}));

// ---------------------------------------------------------------------------
// Square provider — the boundary the task spec asks us to mock. We define a
// tiny `FakeSquareProvider` class and have `payment-provider-factory` return
// instances of it. `bowler-attributes.ts` does
// `provider instanceof SquarePaymentProvider`, so the same class identity
// also has to live on the `square-provider` module export.
// ---------------------------------------------------------------------------
const mockSyncCustomerLeagueAttributes = vi.fn();
class FakeSquareProvider {
  constructor(public locationId: number) {}
  async syncCustomerLeagueAttributes(
    ...args: unknown[]
  ): Promise<{ ok: boolean }> {
    return mockSyncCustomerLeagueAttributes(...args);
  }
}
vi.mock('../../server/services/square-provider', () => ({
  SquarePaymentProvider: FakeSquareProvider,
}));

const mockGetPaymentProvider = vi.fn();
class FakeProviderNotConfiguredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProviderNotConfiguredError';
  }
}
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  ProviderNotConfiguredError: FakeProviderNotConfiguredError,
}));

// Imports must come after vi.mock declarations.
const leaguesRouter = (await import('../../server/routes/leagues')).default;
const bowlerLeaguesRouter = (await import('../../server/routes/bowler-leagues'))
  .default;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const ORG_ID = 1;
const LOCATION_ID = 99;
const TEST_USER = {
  id: 7,
  role: 'org_admin' as const,
  organizationId: ORG_ID,
  bowlerId: null,
};

interface LeagueRow {
  id: number;
  name: string;
  organizationId: number;
  active: boolean;
  seasonStart: string;
  seasonEnd: string;
  weekDay: number;
  weeklyFee: number;
  totalBowlingWeeks: number | null;
  skipDates: string[];
  cancelledDates: string[];
  timezone: string | null;
  description: string | null;
  paymentMode: string;
  seasonNumber: number;
  previousSeasonId: number | null;
  locationId: number;
  doublePayDates: string[];
  practiceStartTime: string | null;
  competitionStartTime: string | null;
  squareLineageItemId: string | null;
  lineageItemVariationId: string | null;
  squareLineageItemName: string | null;
  squarePrizeFundItemId: string | null;
  prizeFundItemVariationId: string | null;
  squarePrizeFundItemName: string | null;
  squareCategoryId: string | null;
  lineageFee: number | null;
  prizeFundFee: number | null;
  allowPublicSignup: boolean;
}

function makeLeague(overrides: Partial<LeagueRow> = {}): LeagueRow {
  return {
    id: 100,
    name: 'Tuesday Night Mixed',
    organizationId: ORG_ID,
    active: true,
    seasonStart: '2025-09-02T00:00:00.000Z',
    seasonEnd: '2026-01-13T00:00:00.000Z',
    weekDay: 2,
    weeklyFee: 2000,
    totalBowlingWeeks: 20,
    skipDates: [],
    cancelledDates: [],
    timezone: 'America/Chicago',
    description: null,
    paymentMode: 'weekly',
    seasonNumber: 1,
    previousSeasonId: null,
    locationId: LOCATION_ID,
    doublePayDates: [],
    practiceStartTime: null,
    competitionStartTime: null,
    squareLineageItemId: null,
    lineageItemVariationId: null,
    squareLineageItemName: null,
    squarePrizeFundItemId: null,
    prizeFundItemVariationId: null,
    squarePrizeFundItemName: null,
    squareCategoryId: null,
    lineageFee: null,
    prizeFundFee: null,
    allowPublicSignup: false,
    ...overrides,
  };
}

interface BowlerRow {
  id: number;
  name: string;
  organizationId: number | null;
  paymentCustomerId: string | null;
  paymentProviderLocationId: number | null;
  paymentSyncPendingAt: string | null;
  paymentSyncAttempts: number;
  paymentSyncLastAttemptAt: string | null;
  paymentSyncNextRetryAt: string | null;
  email: string | null;
  active: boolean;
}

function makeBowler(overrides: Partial<BowlerRow> = {}): BowlerRow {
  return {
    id: 5000,
    name: 'Pat Bowler',
    organizationId: ORG_ID,
    paymentCustomerId: 'sq_cust_123',
    paymentProviderLocationId: LOCATION_ID,
    paymentSyncPendingAt: null,
    paymentSyncAttempts: 0,
    paymentSyncLastAttemptAt: null,
    paymentSyncNextRetryAt: null,
    email: 'pat@example.com',
    active: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Inject req.user from a header to simulate auth.
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as unknown as { user: unknown }).user = JSON.parse(raw);
    next();
  });
  app.use('/api/leagues', leaguesRouter);
  app.use('/api/bowler-leagues', bowlerLeaguesRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(mockStorage))
    (fn as ReturnType<typeof vi.fn>).mockReset();
  mockSyncCustomerLeagueAttributes.mockReset();
  mockSyncCustomerLeagueAttributes.mockResolvedValue({ ok: true });
  mockGetPaymentProvider.mockReset();
  mockGetPaymentProvider.mockImplementation(
    async (locationId: number) => new FakeSquareProvider(locationId),
  );
  mockCreateLeagueWithCanonicalSetup.mockReset();
  mockCreateNewSeasonWithCanonicalSetup.mockReset();
});

afterEach(() => vi.clearAllMocks());

function userHeader() {
  return {
    'x-test-user': JSON.stringify(TEST_USER),
    'content-type': 'application/json',
  };
}

async function patch(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: userHeader(),
    body: JSON.stringify(body),
  });
}
async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: userHeader(),
    body: JSON.stringify(body),
  });
}
async function del(path: string) {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE', headers: userHeader() });
}

/**
 * Wait for the fire-and-forget resync to complete.
 *
 * The routes return synchronously (the resync is `void`-fired), so
 * after the HTTP response we have to give the microtask + macrotask
 * queue time to settle before asserting on the provider mock. We poll
 * the call count up to 1s — fast in the happy case, and a generous
 * ceiling so a slow CI box doesn't false-fail.
 */
async function waitForUpserts(expected: number, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mockSyncCustomerLeagueAttributes.mock.calls.length >= expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Helper: stage a "league with N bowlers, all already in this one
 * league" world for the league-wide resync helpers. Returns the
 * rendered storage closures so individual tests can extend them.
 */
function stageLeagueWithBowlers(opts: {
  league: LeagueRow;
  bowlers: BowlerRow[];
}) {
  const { league, bowlers } = opts;
  const blRows = bowlers.map((b, i) => ({
    id: 9000 + i,
    bowlerId: b.id,
    leagueId: league.id,
    teamId: 200 + i,
    active: true,
    order: i,
  }));

  // getLeague: by id
  mockStorage.getLeague.mockImplementation(async (id: number) => {
    if (id === league.id) return league;
    return null;
  });

  // getBowler: by id
  const bowlerById = new Map(bowlers.map((b) => [b.id, b]));
  mockStorage.getBowler.mockImplementation(async (id: number) =>
    bowlerById.get(id) ?? null,
  );

  // getBowlerLeagues: filter by leagueId OR bowlerId.
  // - leagueId path: used by `fireLeagueBowlersExternalResync` and the
  //   leagues-DELETE pre-capture step.
  // - bowlerId path: used by `resolveBowlerLeagueAttributes` to fetch
  //   the bowler's full league set.
  mockStorage.getBowlerLeagues.mockImplementation(
    async (filters: { leagueId?: number; bowlerId?: number }) => {
      if (filters.leagueId === league.id) return blRows;
      if (filters.bowlerId != null) {
        return blRows.filter((r) => r.bowlerId === filters.bowlerId);
      }
      return [];
    },
  );

  // updateBowler: pass-through; track for retry-flag assertions.
  mockStorage.updateBowler.mockImplementation(
    async (id: number, patch: Partial<BowlerRow>) => {
      const cur = bowlerById.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      bowlerById.set(id, next);
      return next;
    },
  );

  return { blRows, bowlerById };
}

// ---------------------------------------------------------------------------
// 1. League rename → resync every bowler with the NEW name
// ---------------------------------------------------------------------------
describe('PATCH /api/leagues/:id (rename) → fires Square resync for every bowler in the league', () => {
  it('pushes the new league_name string to every bowler in the league', async () => {
    const league = makeLeague({ name: 'Old Name' });
    const renamed = { ...league, name: 'New Name' };
    const bowlers = [
      makeBowler({ id: 5001, paymentCustomerId: 'sq_cust_A' }),
      makeBowler({ id: 5002, paymentCustomerId: 'sq_cust_B' }),
    ];
    stageLeagueWithBowlers({ league: renamed, bowlers });
    mockStorage.updateLeague.mockResolvedValue(renamed);
    // The PATCH route refetches `league` BEFORE updateLeague to compare
    // against the new value. We need getLeague to return the OLD name
    // first so the diff (`update.name !== league.name`) detects a
    // change, then it doesn't matter what subsequent calls return.
    let callIdx = 0;
    mockStorage.getLeague.mockImplementation(async () => {
      callIdx += 1;
      return callIdx === 1 ? league : renamed;
    });

    const res = await patch(`/api/leagues/${league.id}`, { name: 'New Name' });
    expect(res.status, await res.text().catch(() => '')).toBe(200);

    // Two bowlers → two upserts. Sequential per file header of bowler-resync.
    await waitForUpserts(2);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(2);

    // Each upsert is shaped (customerId, bowlerId, attrs) and carries
    // the NEW league name (since `resolveBowlerLeagueAttributes`
    // re-reads the live league row, which storage returns post-rename).
    for (const b of bowlers) {
      const call = mockSyncCustomerLeagueAttributes.mock.calls.find(
        (c) => c[1] === b.id,
      );
      expect(call, `expected upsert for bowler ${b.id}`).toBeDefined();
      expect(call![0]).toBe(b.paymentCustomerId);
      expect(call![2].leagueName).toBe('New Name');
      // Season label is derived from the league's seasonStart/seasonEnd,
      // unchanged by the rename — but the contract is "always present".
      expect(typeof call![2].leagueSeason).toBe('string');
      expect(call![2].leagueSeason.length).toBeGreaterThan(0);
    }
  });

  it('does NOT fire resync when the PATCH does not change name/season/active (e.g. description-only update)', async () => {
    // We pick `description` deliberately. Other innocuous-looking
    // fields like `weekDay` actually DO transitively change
    // `seasonEnd` (the route re-derives it from
    // `weekDay + seasonStart + totalBowlingWeeks` and that path is
    // covered by the rename test's trigger logic). `description` has
    // no derivation side-effects, so it is the cleanest signal that
    // the trigger gate is honouring the documented contract.
    // `totalBowlingWeeks: null` bypasses the route's seasonEnd
    // re-derivation pass — without that, ANY PATCH whose merged inputs
    // (`weekDay + seasonStart + totalBowlingWeeks`) produce a derived
    // seasonEnd that differs from the stored one would silently
    // trigger a resync. Setting totalBowlingWeeks=null lets us
    // exercise the trigger gate in isolation.
    const league = makeLeague({ totalBowlingWeeks: null });
    stageLeagueWithBowlers({ league, bowlers: [makeBowler()] });
    mockStorage.updateLeague.mockResolvedValue({
      ...league,
      description: 'Updated info',
    });

    const res = await patch(`/api/leagues/${league.id}`, {
      description: 'Updated info',
    });
    expect(res.status, await res.text().catch(() => '')).toBe(200);
    // No resync trigger condition satisfied — Smart List membership
    // is independent of the league description.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSyncCustomerLeagueAttributes).not.toHaveBeenCalled();
  });

  it('returns a stable conflict when canonical evidence locks payment timing', async () => {
    const league = makeLeague({ paymentMode: 'weekly' });
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.updateLeague.mockRejectedValue(new LeaguePaymentModeError());

    const res = await patch(`/api/leagues/${league.id}`, { paymentMode: 'upfront' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      error: { code: 'LEAGUE_PAYMENT_MODE_LOCKED' },
    });
    expect(mockSyncCustomerLeagueAttributes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. League archive (PATCH /:id/archive) → resync every bowler
// ---------------------------------------------------------------------------
describe('PATCH /api/leagues/:id/archive → fires resync so bowlers drop out of Smart Lists', () => {
  it('upserts attributes for every bowler in the archived league', async () => {
    // Note: the resync happens AFTER archiveLeague flips `active=false`.
    // `resolveBowlerLeagueAttributes` filters out leagues with
    // `active=false`, so the bowlers' leagueName/leagueSeason should
    // collapse to empty strings — exactly the "drop from Smart List"
    // contract.
    const league = makeLeague();
    const archived = { ...league, active: false };
    const bowlers = [makeBowler({ id: 5010 }), makeBowler({ id: 5011 })];

    let getLeagueCalls = 0;
    mockStorage.getLeague.mockImplementation(async () => {
      getLeagueCalls += 1;
      // First call (route guard) sees the live league; subsequent calls
      // (from `resolveBowlerLeagueAttributes`) see the post-archive row.
      return getLeagueCalls === 1 ? league : archived;
    });
    mockStorage.archiveLeague.mockResolvedValue(archived);
    const blRows = bowlers.map((b, i) => ({
      id: 9100 + i,
      bowlerId: b.id,
      leagueId: league.id,
      teamId: 210 + i,
      active: true,
      order: i,
    }));
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { leagueId?: number; bowlerId?: number }) => {
        if (f.leagueId === league.id) return blRows;
        if (f.bowlerId != null) return blRows.filter((r) => r.bowlerId === f.bowlerId);
        return [];
      },
    );
    const bowlerById = new Map(bowlers.map((b) => [b.id, b]));
    mockStorage.getBowler.mockImplementation(async (id: number) => bowlerById.get(id) ?? null);

    const res = await patch(`/api/leagues/${league.id}/archive`, {});
    expect(res.status).toBe(200);

    await waitForUpserts(2);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(2);
    for (const call of mockSyncCustomerLeagueAttributes.mock.calls) {
      // Archived league filtered out → both attribute strings empty.
      // This is the "drop from Smart List" wire format.
      expect(call[2].leagueName).toBe('');
      expect(call[2].leagueSeason).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. League restore → resync every bowler
// ---------------------------------------------------------------------------
describe('PATCH /api/leagues/:id/restore → fires resync so bowlers return to Smart Lists', () => {
  it('upserts attributes for every bowler in the restored league', async () => {
    const league = makeLeague({ active: false });
    const restored = { ...league, active: true };
    const bowlers = [makeBowler({ id: 5020 })];

    let getLeagueCalls = 0;
    mockStorage.getLeague.mockImplementation(async () => {
      getLeagueCalls += 1;
      return getLeagueCalls === 1 ? league : restored;
    });
    mockStorage.restoreLeague.mockResolvedValue(restored);
    const blRows = [
      { id: 9200, bowlerId: bowlers[0].id, leagueId: league.id, teamId: 220, active: true, order: 0 },
    ];
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { leagueId?: number; bowlerId?: number }) => {
        if (f.leagueId === league.id) return blRows;
        if (f.bowlerId === bowlers[0].id) return blRows;
        return [];
      },
    );
    mockStorage.getBowler.mockImplementation(async () => bowlers[0]);

    const res = await patch(`/api/leagues/${league.id}/restore`, {});
    expect(res.status).toBe(200);

    await waitForUpserts(1);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    const [, , attrs] = mockSyncCustomerLeagueAttributes.mock.calls[0];
    expect(attrs.leagueName).toBe(league.name);
    expect(attrs.leagueSeason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. League delete → resync uses the committed storage result ids (the join
//    rows are gone by the time the helper runs, so a post-delete lookup would
//    observe an empty roster)
// ---------------------------------------------------------------------------
describe('DELETE /api/leagues/:id → fires resync against the pre-captured bowler id list', () => {
  it('still upserts attributes for every formerly-affected bowler after the league + join rows are gone', async () => {
    const league = makeLeague({ id: 110 });
    const bowlers = [makeBowler({ id: 5030 }), makeBowler({ id: 5031 })];
    const blRows = bowlers.map((b, i) => ({
      id: 9300 + i,
      bowlerId: b.id,
      leagueId: league.id,
      teamId: 230 + i,
      active: true,
      order: i,
    }));

    // Storage state machine: the post-delete world.
    let leagueDeleted = false;
    let blRowsCleared = false;
    mockStorage.getLeague.mockImplementation(async () => (leagueDeleted ? null : league));
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { leagueId?: number; bowlerId?: number }) => {
        if (f.leagueId === league.id) return blRowsCleared ? [] : blRows;
        if (f.bowlerId != null) {
          return blRowsCleared ? [] : blRows.filter((r) => r.bowlerId === f.bowlerId);
        }
        return [];
      },
    );
    mockStorage.deleteLeague.mockImplementation(async () => {
      leagueDeleted = true;
      blRowsCleared = true;
      return bowlers.map((bowler) => bowler.id);
    });
    const bowlerById = new Map(bowlers.map((b) => [b.id, b]));
    mockStorage.getBowler.mockImplementation(async (id: number) => bowlerById.get(id) ?? null);

    const res = await del(`/api/leagues/${league.id}`);
    expect(res.status).toBe(200);

    await waitForUpserts(2);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(2);
    // Both bowlers are now in zero active leagues → both strings empty.
    for (const call of mockSyncCustomerLeagueAttributes.mock.calls) {
      expect(call[2].leagueName).toBe('');
      expect(call[2].leagueSeason).toBe('');
    }
    // Both expected bowler ids are represented.
    const upsertedBowlerIds = new Set(
      mockSyncCustomerLeagueAttributes.mock.calls.map((c) => c[1]),
    );
    expect(upsertedBowlerIds).toEqual(new Set(bowlers.map((b) => b.id)));
  });

  it('returns 409 for retained A1 evidence without mutating or resyncing', async () => {
    const league = makeLeague({ id: 111 });
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.deleteLeague.mockRejectedValue(new LeagueEvidenceError());

    const res = await del(`/api/leagues/${league.id}`);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'LEAGUE_OCCURRENCE_EVIDENCE_EXISTS',
        message: expect.stringContaining('Archive'),
      },
    });
    expect(mockStorage.deleteLeague).toHaveBeenCalledWith(league.id, league.organizationId);
    expect(mockStorage.updateBowler).not.toHaveBeenCalled();
    expect(mockStorage.deleteTeam).not.toHaveBeenCalled();
    expect(mockSyncCustomerLeagueAttributes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. New-season clone → resync each unique bowler from the source league
// ---------------------------------------------------------------------------
describe('POST /api/leagues/:id/new-season → fires resync for every bowler cloned into the new season', () => {
  it('requires an explicit payment timing choice', async () => {
    const sourceLeague = makeLeague({ id: 119 });
    mockStorage.getLeague.mockResolvedValue(sourceLeague);

    const res = await post(`/api/leagues/${sourceLeague.id}/new-season`, {
      seasonStart: '2026-09-01T00:00:00.000Z',
      totalBowlingWeeks: 12,
      weekDay: 'Tuesday',
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
    });
    expect(res.status).toBe(400);
    expect(mockStorage.createLeague).not.toHaveBeenCalled();
  });

  it('upserts attributes once per unique source-league bowler', async () => {
    const sourceLeague = makeLeague({ id: 120, name: 'Fall League' });
    const newLeague = makeLeague({
      id: 121,
      name: 'Fall League',
      seasonNumber: 2,
      previousSeasonId: 120,
      seasonStart: '2026-09-01T00:00:00.000Z',
      seasonEnd: '2027-01-15T00:00:00.000Z',
    });
    const bowlers = [makeBowler({ id: 5040 }), makeBowler({ id: 5041 })];
    // Source has two bowlers on two different teams.
    const sourceBlRows = [
      { id: 9400, bowlerId: 5040, leagueId: 120, teamId: 240, active: true, order: 0 },
      { id: 9401, bowlerId: 5041, leagueId: 120, teamId: 241, active: true, order: 0 },
    ];
    const sourceTeams = [
      { id: 240, name: 'Pins', number: 1, leagueId: 120, active: true, displayOrder: 1 },
      { id: 241, name: 'Strikes', number: 2, leagueId: 120, active: true, displayOrder: 2 },
    ];

    mockStorage.getLeague.mockImplementation(async (id: number) => {
      if (id === 120) return sourceLeague;
      if (id === 121) return newLeague;
      return null;
    });
    mockStorage.createLeague.mockResolvedValue(newLeague);
    mockStorage.getTeams.mockResolvedValue(sourceTeams);
    mockStorage.createTeam.mockImplementation(async (t: { name: string }) => ({
      id: 250 + sourceTeams.findIndex((s) => s.name === t.name),
      ...t,
    }));
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { leagueId?: number; bowlerId?: number }) => {
        if (f.leagueId === 120) return sourceBlRows;
        // After clone, each bowler is in BOTH the source (now inactive)
        // AND the new league. resolveBowlerLeagueAttributes filters by
        // active leagues — only the new league counts.
        if (f.bowlerId != null) {
          return [
            { id: 9500, bowlerId: f.bowlerId, leagueId: 121, teamId: 250, active: true, order: 0 },
          ];
        }
        return [];
      },
    );
    mockStorage.createBowlerLeague.mockResolvedValue({});
    mockStorage.createBowlerLeagueIfNotInLeague.mockResolvedValue({});
    mockStorage.updateLeague.mockResolvedValue({ ...sourceLeague, active: false });
    mockCreateNewSeasonWithCanonicalSetup.mockResolvedValue({
      result: {
        ...newLeague,
        setupIntegration: {
          resultContractVersion: 'league-setup-integration-result/1',
          requestContractVersion: 'league-setup-integration-request/1',
          mode: 'created',
          writesPerformed: true,
        },
        canonicalDraftGeneration: {},
      },
      affectedBowlerIds: sourceBlRows.map((row) => row.bowlerId),
    });
    const bowlerById = new Map(bowlers.map((b) => [b.id, b]));
    mockStorage.getBowler.mockImplementation(async (id: number) => bowlerById.get(id) ?? null);

    const res = await post(`/api/leagues/${sourceLeague.id}/new-season`, {
      seasonStart: newLeague.seasonStart,
      totalBowlingWeeks: 12,
      weekDay: 'Tuesday',
      skipDates: ['2026-09-08'],
      cancelledDates: [],
      doublePayDates: ['2026-09-15'],
      allowPublicSignup: true,
      paymentMode: 'upfront',
      setupIntegration: {
        contractVersion: 'league-setup-integration-request/1',
        idempotencyKey: '10000000-0000-4000-8000-000000000120',
      },
    });
    expect(res.status, await res.text().catch(() => '')).toBe(201);

    expect(mockCreateNewSeasonWithCanonicalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLeagueId: sourceLeague.id,
        values: expect.objectContaining({
        totalBowlingWeeks: 12,
        weekDay: 'Tuesday',
        skipDates: ['2026-09-08'],
        cancelledDates: [],
        doublePayDates: ['2026-09-15'],
        allowPublicSignup: true,
        paymentMode: 'upfront',
        }),
      }),
    );

    await waitForUpserts(2);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(2);
    // Both upserts carry the NEW season label, not the old one.
    for (const call of mockSyncCustomerLeagueAttributes.mock.calls) {
      expect(call[2].leagueName).toBe('Fall League');
      // 2026 season label, not 2025.
      expect(call[2].leagueSeason).toMatch(/26|27/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. POST /api/bowler-leagues → resync the joining bowler
// ---------------------------------------------------------------------------
describe('POST /api/bowler-leagues → fires resync for the bowler that just joined', () => {
  it('upserts attributes for the new bowler-league owner', async () => {
    const league = makeLeague({ id: 130 });
    const bowler = makeBowler({ id: 5050 });
    const newBlRow = {
      id: 9600,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 260,
      active: true,
      order: 0,
    };

    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { leagueId?: number; bowlerId?: number }) => {
        // Pre-create existence check filters by BOTH bowlerId+leagueId
        // — return empty so the insert proceeds. The post-create
        // resync helper queries by bowlerId ONLY — return the new row.
        if (f.bowlerId === bowler.id && f.leagueId === undefined) {
          return [newBlRow];
        }
        return [];
      },
    );
    mockStorage.createBowlerLeague.mockResolvedValue(newBlRow);
    mockStorage.createBowlerLeagueIfNotInLeague.mockResolvedValue(newBlRow);

    const res = await post('/api/bowler-leagues', {
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 260,
      active: true,
      order: 0,
    });
    expect(res.status, await res.text().catch(() => '')).toBe(201);

    await waitForUpserts(1);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    const [customerId, bowlerId, attrs] =
      mockSyncCustomerLeagueAttributes.mock.calls[0];
    expect(customerId).toBe(bowler.paymentCustomerId);
    expect(bowlerId).toBe(bowler.id);
    expect(attrs.leagueName).toBe(league.name);
  });
});

// ---------------------------------------------------------------------------
// 7. PATCH /api/bowler-leagues/:id → resync the affected bowler
// ---------------------------------------------------------------------------
describe('PATCH /api/bowler-leagues/:id → fires resync (covers active-flip and team-move)', () => {
  it('upserts attributes on a teamId-change (team move within the same league)', async () => {
    // Team moves don't change the bowler's `league_name` /
    // `league_season` payload — but the resync MUST still fire so
    // any platform with team-derived smart lists (or a downstream
    // attribute we add later) sees the update. The contract under
    // test is "every bowler-league mutation re-pushes attributes",
    // not "only attribute-relevant mutations re-push".
    const league = makeLeague({ id: 145, name: 'Thursday Scratch' });
    const bowler = makeBowler({ id: 5065 });
    const existing = {
      id: 9750,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 275,
      active: true,
      order: 0,
    };
    const moved = { ...existing, teamId: 276 };

    mockStorage.getBowlerLeague.mockResolvedValue(existing);
    mockStorage.updateBowlerLeague.mockResolvedValue(moved);
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { bowlerId?: number }) => {
        if (f.bowlerId === bowler.id) return [moved];
        return [];
      },
    );

    const res = await patch(`/api/bowler-leagues/${existing.id}`, {
      teamId: 276,
    });
    expect(res.status, await res.text().catch(() => '')).toBe(200);

    await waitForUpserts(1);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    const [customerId, bowlerId, attrs] =
      mockSyncCustomerLeagueAttributes.mock.calls[0];
    expect(customerId).toBe(bowler.paymentCustomerId);
    expect(bowlerId).toBe(bowler.id);
    // League membership is unchanged → attrs reflect the (single)
    // active league the bowler still belongs to.
    expect(attrs.leagueName).toBe(league.name);
    expect(attrs.leagueSeason.length).toBeGreaterThan(0);
  });

  it('upserts attributes when an active=false flip would change the bowler\'s leagueName', async () => {
    const league = makeLeague({ id: 140, name: 'Wednesday Open' });
    const bowler = makeBowler({ id: 5060 });
    const existing = {
      id: 9700,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 270,
      active: true,
      order: 0,
    };
    const updated = { ...existing, active: false };

    mockStorage.getBowlerLeague.mockResolvedValue(existing);
    mockStorage.updateBowlerLeague.mockResolvedValue(updated);
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    // After the active=false flip, the bowler has zero active rows.
    mockStorage.getBowlerLeagues.mockImplementation(
      async (f: { bowlerId?: number }) => {
        if (f.bowlerId === bowler.id) return [updated];
        return [];
      },
    );

    const res = await patch(`/api/bowler-leagues/${existing.id}`, {
      active: false,
    });
    expect(res.status, await res.text().catch(() => '')).toBe(200);

    await waitForUpserts(1);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    const [, , attrs] = mockSyncCustomerLeagueAttributes.mock.calls[0];
    // Empty: bowler is no longer active in any league.
    expect(attrs.leagueName).toBe('');
    expect(attrs.leagueSeason).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 8. DELETE /api/bowler-leagues/:id → resync uses pre-captured bowler id
// ---------------------------------------------------------------------------
describe('DELETE /api/bowler-leagues/:id → fires resync against the pre-captured bowlerId', () => {
  it('upserts attributes after the join row is gone', async () => {
    const league = makeLeague({ id: 150 });
    const bowler = makeBowler({ id: 5070 });
    const existing = {
      id: 9800,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 280,
      active: true,
      order: 0,
    };

    mockStorage.getBowlerLeague.mockResolvedValue(existing);
    mockStorage.deleteBowlerLeague.mockResolvedValue(true);
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    // After delete, the bowler is in zero leagues.
    mockStorage.getBowlerLeagues.mockResolvedValue([]);

    const res = await del(`/api/bowler-leagues/${existing.id}`);
    expect(res.status).toBe(200);

    await waitForUpserts(1);
    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    const [customerId, bowlerId, attrs] =
      mockSyncCustomerLeagueAttributes.mock.calls[0];
    expect(customerId).toBe(bowler.paymentCustomerId);
    expect(bowlerId).toBe(bowler.id);
    expect(attrs.leagueName).toBe('');
    expect(attrs.leagueSeason).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Helper-level guarantees (bowler-resync.ts internals exercised through a
// real route — the simplest mutation surface to keep the test small).
// ---------------------------------------------------------------------------
describe('bowler-resync helper guarantees (exercised via a bowler-leagues mutation)', () => {
  it('skips the Square branch silently when the bowler has no paymentCustomerId yet', async () => {
    // A freshly created bowler with no Square customer ID yet must
    // NOT trigger a Square call (per the file header: customer
    // creation is bound to bowler create / profile edit, not to
    // attribute writes).
    const league = makeLeague({ id: 160 });
    const bowler = makeBowler({
      id: 5080,
      paymentCustomerId: null,
      paymentProviderLocationId: null,
    });
    const newBlRow = {
      id: 9900,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 290,
      active: true,
      order: 0,
    };
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    mockStorage.getBowlerLeagues.mockResolvedValue([]);
    mockStorage.createBowlerLeague.mockResolvedValue(newBlRow);
    mockStorage.createBowlerLeagueIfNotInLeague.mockResolvedValue(newBlRow);

    const res = await post('/api/bowler-leagues', {
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 290,
      active: true,
      order: 0,
    });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSyncCustomerLeagueAttributes).not.toHaveBeenCalled();
    // Provider factory must not have been touched either — there's
    // nothing to sync.
    expect(mockGetPaymentProvider).not.toHaveBeenCalled();
  });

  it('flips paymentSyncPendingAt when the provider returns ok:false so the retry sweep picks it up', async () => {
    // Stage one bowler whose Square upsert will be rejected.
    const league = makeLeague({ id: 170 });
    const bowler = makeBowler({ id: 5090 });
    const existing = {
      id: 9950,
      bowlerId: bowler.id,
      leagueId: league.id,
      teamId: 295,
      active: true,
      order: 0,
    };

    mockStorage.getBowlerLeague.mockResolvedValue(existing);
    mockStorage.deleteBowlerLeague.mockResolvedValue(true);
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.getBowler.mockResolvedValue(bowler);
    mockStorage.getBowlerLeagues.mockResolvedValue([]);

    // Provider rejects this upsert.
    mockSyncCustomerLeagueAttributes.mockResolvedValue({ ok: false });

    const res = await del(`/api/bowler-leagues/${existing.id}`);
    expect(res.status).toBe(200);

    await waitForUpserts(1);
    // Wait one extra tick for the post-upsert flagBowlerForRetry update.
    await new Promise((r) => setTimeout(r, 30));

    expect(mockSyncCustomerLeagueAttributes).toHaveBeenCalledTimes(1);
    // The retry-flag write happens via storage.updateBowler with a
    // non-null paymentSyncPendingAt timestamp.
    const flagCall = mockStorage.updateBowler.mock.calls.find(
      (c) =>
        c[0] === bowler.id &&
        typeof (c[1] as { paymentSyncPendingAt?: string }).paymentSyncPendingAt ===
          'string',
    );
    expect(flagCall, 'expected updateBowler with paymentSyncPendingAt set').toBeDefined();
    expect((flagCall?.[1] as { paymentSyncNextRetryAt?: string }).paymentSyncNextRetryAt)
      .toEqual(expect.any(String));
  });
});
