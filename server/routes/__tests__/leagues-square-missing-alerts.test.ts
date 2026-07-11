/**
 * Route-level coverage for `GET /api/leagues/square-missing-alerts/recent`
 * (Task #657). The auditor's persist behavior is unit-tested in
 * `server/services/__tests__/league-square-catalog-audit.test.ts`; this
 * file pins the *route's* filtering layer, which is where the banner's
 * tenant scoping, auto-clear, and defensive shape-check live.
 *
 * What's exercised:
 *   - org_admin sees only rows whose league is visible to their org
 *     (we feed `getLeagues(orgId)` a single league and the alerter
 *     returns rows for both that league and an out-of-tenant one;
 *     only the in-tenant row should surface).
 *   - system_admin sees rows from every tenant
 *     (`getAllLeaguesSystemAdmin` returns every league, all rows
 *     matching the shape pass through).
 *   - Auto-clear: when a league's saved variation id no longer
 *     matches what the alerter row reported missing, the entry is
 *     dropped — and when nothing remains the whole alert is
 *     suppressed (without mutating alerter_state).
 *   - Defensive shape-check: a row whose `summary` is an apple-pay
 *     shape (or otherwise lacks `leagueId`/`missing[]`) is skipped
 *     even if it shares the `league_square_missing:` prefix, so a
 *     future cross-pollution at the storage layer can never leak
 *     foreign payloads into the leagues banner.
 *
 * The route's other deps (`db`, `payment-scheduler`, `bowler-resync`,
 * etc.) are imported transitively but never hit in the request path
 * — only `storage.getLeagues`, `storage.getAllLeaguesSystemAdmin`, and
 * `storage.listRecentAlerterEventsByPrefix` are consulted, so we mock
 * just those.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { League, AlerterSummary } from "@shared/schema";

const storageMock = vi.hoisted(() => ({
  storage: {
    getLeagues: vi.fn(),
    getAllLeaguesSystemAdmin: vi.fn(),
    listRecentAlerterEventsByPrefix: vi.fn(),
  },
}));

vi.mock("../../storage", () => storageMock);

const leaguesRouter = (await import("../leagues")).default;

function makeLeague(overrides: Partial<League>): League {
  const base: League = {
    id: 1,
    name: "Monday League",
    description: null,
    active: true,
    allowPublicSignup: false,
    seasonStart: "2026-01-01",
    seasonEnd: "2026-04-01",
    weekDay: "Monday",
    weeklyFee: 1500,
    lineageFee: 1000,
    prizeFundFee: 500,
    practiceStartTime: null,
    competitionStartTime: null,
    squareLineageItemId: "item-lineage",
    lineageItemVariationId: "var-lineage",
    squareLineageItemName: "Lineage Item",
    squarePrizeFundItemId: "item-pf",
    prizeFundItemVariationId: "var-pf",
    squarePrizeFundItemName: "Prize Fund Item",
    squareCategoryId: null,
    timezone: "America/New_York",
    paymentMode: "weekly",
    seasonNumber: 1,
    previousSeasonId: null,
    organizationId: 100,
    locationId: 200,
    totalBowlingWeeks: null,
    finalTwoWeeksDueWeek: null,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
    rosterCap: null,
    embedRegistrationFee: null,
  };
  return { ...base, ...overrides };
}

type FakeUser = {
  id: number;
  role: "org_admin" | "system_admin";
  organizationId: number | null;
};

async function startApp(user: FakeUser) {
  const app = express();
  // Inject the authenticated user the same way the real auth
  // middleware would, so `filterByOrganization` and the route's
  // role checks see realistic shape. Object.assign sidesteps the
  // strict typing on `Request#user` / `Request#isAuthenticated`
  // (both pull in fields/predicates the route never reads).
  app.use((req, _res, next) => {
    Object.assign(req, { user, isAuthenticated: () => true });
    next();
  });
  app.use("/api/leagues", leaguesRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/leagues/square-missing-alerts/recent`;

  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return { url, close };
}

async function fetchAlerts(user: FakeUser) {
  const { url, close } = await startApp(user);
  try {
    const res = await fetch(url);
    const body = (await res.json()) as {
      success: boolean;
      data: { alerts: Array<Record<string, unknown>> };
    };
    return { status: res.status, body };
  } finally {
    await close();
  }
}

function leagueMissingSummary(
  league: League,
  missing: Array<{ kind: "lineage" | "prizeFund"; itemName: string | null; variationId: string }>,
): AlerterSummary {
  return {
    leagueId: league.id,
    leagueName: league.name,
    organizationId: league.organizationId ?? null,
    missing,
    suppressedSinceLastAlert: 0,
  };
}

describe("GET /api/leagues/square-missing-alerts/recent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes org_admin to their own org's leagues, hiding alerts for other tenants", async () => {
    const myLeague = makeLeague({ id: 1, organizationId: 100, name: "Mine" });
    const otherLeague = makeLeague({
      id: 2,
      organizationId: 999,
      name: "Theirs",
      lineageItemVariationId: "other-lineage",
    });

    // Org-admin storage scope returns only their league.
    storageMock.storage.getLeagues.mockResolvedValue([myLeague]);
    storageMock.storage.listRecentAlerterEventsByPrefix.mockResolvedValue([
      {
        kind: `league_square_missing:${myLeague.id}`,
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(myLeague, [
          { kind: "lineage", itemName: "Lineage Item", variationId: "var-lineage" },
        ]),
      },
      {
        kind: `league_square_missing:${otherLeague.id}`,
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(otherLeague, [
          { kind: "lineage", itemName: "X", variationId: "other-lineage" },
        ]),
      },
    ]);

    const { status, body } = await fetchAlerts({
      id: 10,
      role: "org_admin",
      organizationId: 100,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(storageMock.storage.getLeagues).toHaveBeenCalledWith(100);
    expect(storageMock.storage.getAllLeaguesSystemAdmin).not.toHaveBeenCalled();
    expect(body.data.alerts).toHaveLength(1);
    expect(body.data.alerts[0]).toMatchObject({
      leagueId: 1,
      leagueName: "Mine",
      organizationId: 100,
    });
  });

  it("returns rows from every tenant for system_admin", async () => {
    const a = makeLeague({ id: 1, organizationId: 100, name: "OrgA" });
    const b = makeLeague({
      id: 2,
      organizationId: 200,
      name: "OrgB",
      lineageItemVariationId: "var-b-lineage",
    });

    storageMock.storage.getAllLeaguesSystemAdmin.mockResolvedValue([a, b]);
    storageMock.storage.listRecentAlerterEventsByPrefix.mockResolvedValue([
      {
        kind: "league_square_missing:1",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(a, [
          { kind: "lineage", itemName: "A", variationId: "var-lineage" },
        ]),
      },
      {
        kind: "league_square_missing:2",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(b, [
          { kind: "lineage", itemName: "B", variationId: "var-b-lineage" },
        ]),
      },
    ]);

    const { body } = await fetchAlerts({
      id: 1,
      role: "system_admin",
      organizationId: null,
    });

    expect(storageMock.storage.getAllLeaguesSystemAdmin).toHaveBeenCalledTimes(1);
    expect(storageMock.storage.getLeagues).not.toHaveBeenCalled();
    expect(body.data.alerts.map((a) => a.leagueId).sort()).toEqual([1, 2]);
  });

  it("auto-clears entries whose saved variation id no longer matches what was reported missing", async () => {
    // Admin re-pointed the lineage variation to a live one; the
    // alerter row still references the old (missing) id, but the
    // league row now has `lineageItemVariationId: "var-lineage-new"`.
    // The lineage entry should drop out, and since prize-fund is the
    // only thing left, the alert still surfaces — but only with the
    // prize-fund row.
    const league = makeLeague({
      id: 1,
      organizationId: 100,
      lineageItemVariationId: "var-lineage-new",
      prizeFundItemVariationId: "var-pf",
    });
    storageMock.storage.getLeagues.mockResolvedValue([league]);
    storageMock.storage.listRecentAlerterEventsByPrefix.mockResolvedValue([
      {
        kind: "league_square_missing:1",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(league, [
          { kind: "lineage", itemName: "L", variationId: "var-lineage-old" },
          { kind: "prizeFund", itemName: "P", variationId: "var-pf" },
        ]),
      },
    ]);

    const { body } = await fetchAlerts({
      id: 10,
      role: "org_admin",
      organizationId: 100,
    });

    expect(body.data.alerts).toHaveLength(1);
    expect(body.data.alerts[0].missing).toEqual([
      { kind: "prizeFund", itemName: "P", variationId: "var-pf" },
    ]);
  });

  it("suppresses the whole alert when every reported variation has been re-pointed", async () => {
    const league = makeLeague({
      id: 1,
      organizationId: 100,
      lineageItemVariationId: "var-lineage-new",
      prizeFundItemVariationId: "var-pf-new",
    });
    storageMock.storage.getLeagues.mockResolvedValue([league]);
    storageMock.storage.listRecentAlerterEventsByPrefix.mockResolvedValue([
      {
        kind: "league_square_missing:1",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(league, [
          { kind: "lineage", itemName: "L", variationId: "var-lineage-old" },
          { kind: "prizeFund", itemName: "P", variationId: "var-pf-old" },
        ]),
      },
    ]);

    const { body } = await fetchAlerts({
      id: 10,
      role: "org_admin",
      organizationId: 100,
    });

    expect(body.data.alerts).toEqual([]);
  });

  it("drops rows whose summary doesn't match the league-missing shape (e.g. an apple-pay summary)", async () => {
    const league = makeLeague({ id: 1, organizationId: 100 });
    storageMock.storage.getLeagues.mockResolvedValue([league]);
    storageMock.storage.listRecentAlerterEventsByPrefix.mockResolvedValue([
      {
        // A legitimate league row that should pass.
        kind: "league_square_missing:1",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: leagueMissingSummary(league, [
          { kind: "lineage", itemName: "L", variationId: "var-lineage" },
        ]),
      },
      {
        // Foreign apple-pay shape that somehow shares the prefix —
        // the route's defensive shape-check must reject it before
        // it can leak into the leagues banner. The mock isn't
        // generically typed, so we can hand it a foreign shape
        // directly without laundering casts.
        kind: "league_square_missing:bogus",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: {
          organizationId: 100,
          domainsAttempted: 1,
          domainsRegistered: 1,
          domainsFailed: 0,
          suppressedSinceLastAlert: 0,
        },
      },
      {
        // Null summary — also defensively skipped.
        kind: "league_square_missing:null",
        lastSentAt: new Date("2026-05-01T00:00:00Z"),
        summary: null,
      },
    ]);

    const { body } = await fetchAlerts({
      id: 10,
      role: "org_admin",
      organizationId: 100,
    });

    expect(body.data.alerts).toHaveLength(1);
    expect(body.data.alerts[0].leagueId).toBe(1);
  });
});
