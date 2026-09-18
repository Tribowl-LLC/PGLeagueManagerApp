import { storage } from "../storage";
import { createLogger } from "../logger";
import { env, isProdLike, isSingletonOrganizationMode } from "../config";
import { SingleTenantContextError } from "./single-tenant-context";
import { getPaymentProvider, ProviderNotConfiguredError } from "./payment-provider-factory";
import { sendLeagueSquareCatalogMissingAlert } from "./email";
import type { League, LeagueSquareMissingAlerterSummary } from "@shared/schema";

const log = createLogger("LeagueSquareCatalogAudit");

const ALERT_KIND_PREFIX = "league_square_missing";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000;

export interface MissingVariation {
  kind: "lineage" | "prizeFund";
  itemName: string | null;
  variationId: string;
}

export interface AuditDeps {
  /** Active leagues to inspect (must include the variation id columns). */
  listLeaguesToAudit: () => Promise<League[]>;
  /**
   * Returns the set of currently-live Square item-variation ids for a
   * given location. The auditor calls this once per location per run
   * and reuses the set across all leagues at that location. Should
   * return `null` when the location has no Square provider configured
   * (we then skip the leagues there rather than alerting on a fetch
   * failure).
   */
  fetchLiveVariationIdsForLocation: (locationId: number) => Promise<Set<string> | null>;
  /** Loads org_admin recipient addresses for an org. */
  getOrgAdminEmails: (organizationId: number) => Promise<string[]>;
  /** Looks up an organization name to include in the email. */
  getOrganizationName: (organizationId: number) => Promise<string | null>;
  /**
   * Atomic, persisted per-league throttle slot. Reuses the
   * `alerter_state` row infrastructure so two server instances
   * cannot both fire the same league's alert inside the window.
   */
  tryClaimSlot: (
    kind: string,
    minIntervalMs: number,
  ) => Promise<{ claimed: boolean; suppressedCount: number }>;
  /**
   * Persist a per-league summary of the most recent missing-variation
   * alert so the leagues-page banner (Task #657) can describe what
   * just fired without operators having to dig the email back out.
   * Mirrors the apple-pay / square-catalog-cap alerter pattern (#272,
   * #644). Best-effort: failure here does not flip the send result.
   */
  recordSummary: (
    kind: string,
    summary: LeagueSquareMissingAlerterSummary,
  ) => Promise<void>;
  send: typeof sendLeagueSquareCatalogMissingAlert;
  throttleMs: () => number;
}

export type AuditResult =
  | "sent"
  | "rate-limited"
  | "no-recipients"
  | "no-provider"
  | "send-failed";

export interface AuditRunSummary {
  leaguesScanned: number;
  leaguesWithMissing: number;
  results: { leagueId: number; result: AuditResult }[];
}

const defaultDeps: AuditDeps = {
  listLeaguesToAudit: async () => {
    if (isProdLike && !isSingletonOrganizationMode) {
      throw new SingleTenantContextError(
        "configuration_missing",
        "APP_ORGANIZATION_ID is required before background operations can run.",
      );
    }
    const configuredOrganizationId = env.APP_ORGANIZATION_ID;
    const all = configuredOrganizationId === undefined
      ? await storage.getAllLeaguesSystemAdmin()
      : await storage.getLeagues(configuredOrganizationId);
    return all.filter(
      (l) =>
        l.active &&
        l.locationId != null &&
        l.organizationId != null &&
        (l.lineageItemVariationId || l.prizeFundItemVariationId),
    );
  },
  fetchLiveVariationIdsForLocation: async (locationId: number) => {
    let provider;
    try {
      provider = await getPaymentProvider(locationId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      throw err;
    }
    // Only Square provider exposes catalog item variations; other
    // providers don't share the variation-id concept this audit was
    // written for.
    const candidate = provider as { listCatalogItems?: typeof import("./square-provider").SquarePaymentProvider.prototype.listCatalogItems };
    if (typeof candidate.listCatalogItems !== "function") return null;
    try {
      const { items } = await candidate.listCatalogItems();
      const ids = new Set<string>();
      for (const item of items) {
        for (const v of item.variations) {
          if (v.id) ids.add(v.id);
        }
      }
      return ids;
    } catch (err) {
      log.warn(`Failed to fetch live Square catalog for location ${locationId}`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
  getOrgAdminEmails: async (organizationId: number) => {
    const admins = await storage.getOrgAdmins(organizationId);
    return admins.map((u) => u.email).filter((e): e is string => !!e);
  },
  getOrganizationName: async (organizationId: number) => {
    const org = await storage.getOrganization(organizationId);
    return org?.name ?? null;
  },
  tryClaimSlot: (kind, ms) => storage.tryClaimAlerterSlot(kind, ms),
  recordSummary: (kind, summary) => storage.recordAlerterSummary(kind, summary),
  send: sendLeagueSquareCatalogMissingAlert,
  throttleMs: () => DEFAULT_THROTTLE_MS,
};

/**
 * Scheduled audit (task #654) that walks every active league with a
 * saved Square Lineage / Prize Fund variation id, compares those ids
 * against the live Square catalog for the league's location, and
 * emails the org's admins when one is missing.
 */
export class LeagueSquareCatalogAuditor {
  constructor(private readonly deps: AuditDeps = defaultDeps) {}

  async runOnce(): Promise<AuditRunSummary> {
    const leagues = await this.deps.listLeaguesToAudit();
    const summary: AuditRunSummary = {
      leaguesScanned: leagues.length,
      leaguesWithMissing: 0,
      results: [],
    };

    // Group leagues by locationId so each location's catalog is fetched
    // once per run regardless of how many leagues share it.
    const byLocation = new Map<number, League[]>();
    for (const l of leagues) {
      if (l.locationId == null) continue;
      const arr = byLocation.get(l.locationId) ?? [];
      arr.push(l);
      byLocation.set(l.locationId, arr);
    }

    for (const [locationId, locationLeagues] of byLocation) {
      let liveIds: Set<string> | null;
      try {
        liveIds = await this.deps.fetchLiveVariationIdsForLocation(locationId);
      } catch (err) {
        log.error(`Audit fetch threw for location ${locationId}`, {
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (liveIds === null) {
        // Square not configured here — nothing to compare against.
        continue;
      }

      for (const league of locationLeagues) {
        const missing: MissingVariation[] = [];
        if (
          league.lineageItemVariationId &&
          !liveIds.has(league.lineageItemVariationId)
        ) {
          missing.push({
            kind: "lineage",
            itemName: league.squareLineageItemName,
            variationId: league.lineageItemVariationId,
          });
        }
        if (
          league.prizeFundItemVariationId &&
          !liveIds.has(league.prizeFundItemVariationId)
        ) {
          missing.push({
            kind: "prizeFund",
            itemName: league.squarePrizeFundItemName,
            variationId: league.prizeFundItemVariationId,
          });
        }
        if (missing.length === 0) continue;

        summary.leaguesWithMissing += 1;
        const result = await this.notifyOne(league, missing);
        summary.results.push({ leagueId: league.id, result });
      }
    }

    log.info(
      `League Square-catalog audit complete: scanned=${summary.leaguesScanned} withMissing=${summary.leaguesWithMissing}`,
    );
    return summary;
  }

  private async notifyOne(
    league: League,
    missing: MissingVariation[],
  ): Promise<AuditResult> {
    const kind = `${ALERT_KIND_PREFIX}:${league.id}`;
    let claim;
    try {
      claim = await this.deps.tryClaimSlot(kind, this.deps.throttleMs());
    } catch (err) {
      log.error(`Failed to claim alerter slot for league ${league.id}`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return "send-failed";
    }
    if (!claim.claimed) {
      log.info(
        `League Square-catalog alert rate-limited for league ${league.id} (suppressed=${claim.suppressedCount})`,
      );
      return "rate-limited";
    }

    if (league.organizationId == null) return "no-recipients";

    let toEmails: string[];
    try {
      toEmails = await this.deps.getOrgAdminEmails(league.organizationId);
    } catch (err) {
      log.error(`Failed to load org admins for league ${league.id}`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return "send-failed";
    }
    if (toEmails.length === 0) return "no-recipients";

    let orgName: string | null = null;
    try {
      orgName = await this.deps.getOrganizationName(league.organizationId);
    } catch {
      // Best-effort — the email falls back to a generic phrase.
    }

    const sent = await this.deps.send(toEmails, {
      leagueId: league.id,
      leagueName: league.name,
      organizationName: orgName,
      missing,
    });

    if (sent) {
      // Persist the summary so the leagues-page banner (#657) can
      // describe what just fired without operators re-reading the
      // email. Best-effort: a persist failure does not flip `sent`
      // back — the email already went out.
      try {
        const summary: LeagueSquareMissingAlerterSummary = {
          leagueId: league.id,
          leagueName: league.name,
          organizationId: league.organizationId ?? null,
          missing,
          suppressedSinceLastAlert: claim.suppressedCount,
        };
        await this.deps.recordSummary(kind, summary);
      } catch (err) {
        log.warn(
          `Failed to persist league Square-catalog alert summary for league ${league.id}`,
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    return sent ? "sent" : "send-failed";
  }
}

const leagueSquareCatalogAuditor = new LeagueSquareCatalogAuditor();

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Starts a daily interval that runs the audit. Safe to call multiple
 * times — the previous interval is cleared first. The first run
 * happens immediately after start so a crash-loop doesn't push the
 * next audit off by another full day.
 */
export function startLeagueSquareCatalogAudit(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  stopLeagueSquareCatalogAudit();
  log.info(`Starting league Square-catalog audit (every ${Math.round(intervalMs / 1000)}s)`);
  const tick = () => {
    leagueSquareCatalogAuditor.runOnce().catch((err) => {
      log.error("League Square-catalog audit tick failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };
  intervalHandle = setInterval(tick, intervalMs);
  if (intervalHandle && typeof intervalHandle === "object" && "unref" in intervalHandle) {
    intervalHandle.unref();
  }
  // Defer the first run a short tick so server boot completes first.
  setTimeout(tick, 5_000).unref?.();
}

function stopLeagueSquareCatalogAudit(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

const LEAGUE_SQUARE_MISSING_ALERT_KIND_PREFIX = ALERT_KIND_PREFIX;
