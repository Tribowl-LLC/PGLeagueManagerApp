import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LeagueSquareCatalogAuditor,
  type AuditDeps,
} from "../league-square-catalog-audit";
import type { sendLeagueSquareCatalogMissingAlert } from "../email";
import type { League, LeagueSquareMissingAlerterSummary } from "@shared/schema";

type SendFn = typeof sendLeagueSquareCatalogMissingAlert;

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

class FakeSlotStore {
  private lastSentAt = new Map<string, number>();
  private suppressed = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  tryClaim = async (
    kind: string,
    minIntervalMs: number,
  ): Promise<{ claimed: boolean; suppressedCount: number }> => {
    const last = this.lastSentAt.get(kind);
    const now = this.now();
    if (last === undefined || now - last >= minIntervalMs) {
      const suppressed = this.suppressed.get(kind) ?? 0;
      this.lastSentAt.set(kind, now);
      this.suppressed.set(kind, 0);
      return { claimed: true, suppressedCount: suppressed };
    }
    const next = (this.suppressed.get(kind) ?? 0) + 1;
    this.suppressed.set(kind, next);
    return { claimed: false, suppressedCount: next };
  };
}

describe("LeagueSquareCatalogAuditor", () => {
  let send: ReturnType<typeof vi.fn<SendFn>>;
  let getAdmins: ReturnType<typeof vi.fn<(orgId: number) => Promise<string[]>>>;
  let getOrgName: ReturnType<typeof vi.fn<(orgId: number) => Promise<string | null>>>;
  let recordSummary: ReturnType<
    typeof vi.fn<(kind: string, summary: LeagueSquareMissingAlerterSummary) => Promise<void>>
  >;
  let nowMs: number;
  let store: FakeSlotStore;
  let throttleMs: number;

  const buildAuditor = (
    leagues: League[],
    liveIds: Map<number, Set<string> | null>,
    overrides: Partial<AuditDeps> = {},
  ) =>
    new LeagueSquareCatalogAuditor({
      listLeaguesToAudit: async () => leagues,
      fetchLiveVariationIdsForLocation: async (locationId) => {
        if (!liveIds.has(locationId)) return new Set<string>();
        const v = liveIds.get(locationId);
        return v === undefined ? new Set<string>() : v;
      },
      getOrgAdminEmails: (id) => getAdmins(id),
      getOrganizationName: (id) => getOrgName(id),
      tryClaimSlot: store.tryClaim,
      recordSummary: (kind, summary) => recordSummary(kind, summary),
      send,
      throttleMs: () => throttleMs,
      ...overrides,
    });

  beforeEach(() => {
    nowMs = 1_000_000;
    throttleMs = 24 * 60 * 60 * 1000;
    send = vi.fn<SendFn>().mockResolvedValue(true);
    getAdmins = vi
      .fn<(orgId: number) => Promise<string[]>>()
      .mockResolvedValue(["admin@example.com"]);
    getOrgName = vi
      .fn<(orgId: number) => Promise<string | null>>()
      .mockResolvedValue("Acme Bowl");
    recordSummary = vi
      .fn<(kind: string, summary: LeagueSquareMissingAlerterSummary) => Promise<void>>()
      .mockResolvedValue(undefined);
    store = new FakeSlotStore(() => nowMs);
  });

  it("sends an alert when a saved variation id is missing from the live catalog", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]); // lineage missing
    const auditor = buildAuditor([league], liveIds);

    const summary = await auditor.runOnce();

    expect(summary.leaguesScanned).toBe(1);
    expect(summary.leaguesWithMissing).toBe(1);
    expect(summary.results).toEqual([{ leagueId: 1, result: "sent" }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(["admin@example.com"], {
      leagueId: 1,
      leagueName: "Monday League",
      organizationName: "Acme Bowl",
      missing: [
        { kind: "lineage", itemName: "Lineage Item", variationId: "var-lineage" },
      ],
    });
  });

  it("reports both lineage and prize-fund variations when both are missing", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>()]]);
    const auditor = buildAuditor([league], liveIds);

    await auditor.runOnce();

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][1];
    expect(arg.missing.map((m) => m.kind)).toEqual(["lineage", "prizeFund"]);
  });

  it("does not alert when both saved variations are still present", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-lineage", "var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    const summary = await auditor.runOnce();

    expect(summary.leaguesWithMissing).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("throttles repeat alerts for the same league inside the 24h window", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    await auditor.runOnce();
    nowMs += 60 * 60 * 1000; // +1h, still inside window
    const summary = await auditor.runOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary.results).toEqual([{ leagueId: 1, result: "rate-limited" }]);
  });

  it("sends again once the throttle window has elapsed", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    await auditor.runOnce();
    nowMs += throttleMs + 1;
    await auditor.runOnce();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses an independent throttle slot per league", async () => {
    const a = makeLeague({ id: 1, name: "A" });
    const b = makeLeague({ id: 2, name: "B", organizationId: 101 });
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([a, b], liveIds);

    await auditor.runOnce();
    expect(send).toHaveBeenCalledTimes(2);

    nowMs += 60 * 1000;
    await auditor.runOnce();
    // Both throttled inside window, no new sends.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips leagues whose location has no Square catalog available", async () => {
    const league = makeLeague({});
    const liveIds = new Map<number, Set<string> | null>([[200, null]]);
    const auditor = buildAuditor([league], liveIds);

    const summary = await auditor.runOnce();

    expect(summary.leaguesWithMissing).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns no-recipients when no org admins are configured", async () => {
    getAdmins.mockResolvedValueOnce([]);
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    const summary = await auditor.runOnce();

    expect(summary.results).toEqual([{ leagueId: 1, result: "no-recipients" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("persists the per-league summary after a successful send so the banner can render", async () => {
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]); // lineage missing
    const auditor = buildAuditor([league], liveIds);

    await auditor.runOnce();

    expect(recordSummary).toHaveBeenCalledTimes(1);
    expect(recordSummary).toHaveBeenCalledWith("league_square_missing:1", {
      leagueId: 1,
      leagueName: "Monday League",
      organizationId: 100,
      missing: [
        { kind: "lineage", itemName: "Lineage Item", variationId: "var-lineage" },
      ],
      suppressedSinceLastAlert: 0,
    });
  });

  it("does not persist a summary when the send itself fails", async () => {
    send.mockResolvedValueOnce(false);
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    await auditor.runOnce();

    expect(recordSummary).not.toHaveBeenCalled();
  });

  it("still returns sent when persisting the summary throws (banner is best-effort)", async () => {
    recordSummary.mockRejectedValueOnce(new Error("db down"));
    const league = makeLeague({});
    const liveIds = new Map([[200, new Set<string>(["var-pf"])]]);
    const auditor = buildAuditor([league], liveIds);

    const summary = await auditor.runOnce();

    expect(summary.results).toEqual([{ leagueId: 1, result: "sent" }]);
  });

  it("fetches the catalog at most once per location even with many leagues", async () => {
    const leagues = [
      makeLeague({ id: 1, name: "L1" }),
      makeLeague({ id: 2, name: "L2" }),
      makeLeague({ id: 3, name: "L3" }),
    ];
    const fetchSpy = vi
      .fn<(locationId: number) => Promise<Set<string> | null>>()
      .mockResolvedValue(new Set<string>(["var-pf"])); // lineage missing for all
    const auditor = buildAuditor(leagues, new Map(), {
      fetchLiveVariationIdsForLocation: fetchSpy,
    });

    await auditor.runOnce();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
