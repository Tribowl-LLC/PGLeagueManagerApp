import { env, isDev } from "../config";
import { createLogger } from "../logger";
import { storage } from "../storage";
import { sendSquareCatalogCapAlert } from "./email";
import type { SquareCatalogCapAlerterSummary } from "@shared/schema";

const log = createLogger("SquareCatalogCapAlerts");

/**
 * `kind` prefix for the alerter_state rows this alerter writes
 * (Task #644). Combined with a per-location suffix
 * (`square_catalog_cap:loc:<locationId>`) so support gets one
 * notification per affected tenant per rate-limit window — rather
 * than one global slot that would shadow whichever org happened to
 * fire most recently.
 *
 * The system-admin banner reads `listRecentAlerterEventsByPrefix`
 * with this prefix to surface every recent (org, location) hit.
 */
export const SQUARE_CATALOG_CAP_ALERT_KIND_PREFIX = "square_catalog_cap:loc:";

export function squareCatalogCapAlertKind(locationId: number): string {
  return `${SQUARE_CATALOG_CAP_ALERT_KIND_PREFIX}${locationId}`;
}

export interface SquareCatalogCapEvent {
  organizationId: number | null;
  locationId: number;
  reason: "max_items" | "max_pages";
  context: string;
}

export interface SquareCatalogCapAlerterDeps {
  send: typeof sendSquareCatalogCapAlert;
  getAdminEmails: (organizationId: number | null) => Promise<string[]>;
  isEnabled: () => boolean;
  minIntervalMs: () => number;
  tryClaimSlot: (
    kind: string,
    minIntervalMs: number,
  ) => Promise<{ claimed: boolean; suppressedCount: number }>;
  recordSummary: (
    kind: string,
    summary: SquareCatalogCapAlerterSummary,
  ) => Promise<void>;
}

const defaultDeps: SquareCatalogCapAlerterDeps = {
  send: sendSquareCatalogCapAlert,
  getAdminEmails: async (organizationId) => {
    const allUsers = await storage.getUsers();
    return allUsers
      .filter((u) => u.role === "system_admin"
        && u.email
        && (u.organizationId === organizationId || u.organizationId === null))
      .map((u) => u.email);
  },
  isEnabled: () => {
    if (env.SQUARE_CATALOG_CAP_ALERTS_ENABLED !== undefined) {
      return env.SQUARE_CATALOG_CAP_ALERTS_ENABLED;
    }
    return !isDev;
  },
  minIntervalMs: () => env.SQUARE_CATALOG_CAP_ALERT_MIN_INTERVAL_MS,
  tryClaimSlot: (kind, ms) => storage.tryClaimAlerterSlot(kind, ms),
  recordSummary: (kind, summary) => storage.recordAlerterSummary(kind, summary),
};

export type NotifyResult =
  | "sent"
  | "rate-limited"
  | "disabled"
  | "no-recipients"
  | "failed";

/**
 * Page support when one organization's Square catalog hits the
 * pagination safety cap (#644). One alert per location per
 * rate-limit window: the persistent `alerter_state` row is keyed by
 * `square_catalog_cap:loc:<locationId>` so two server instances
 * concurrently observing a cap on the same tenant cannot double-page
 * (the row's `SELECT ... FOR UPDATE` serializes them).
 *
 * Failure semantics mirror `ApplePayRecoveryAlerter`:
 *   - `disabled` → opt-out via env, treated as a no-op.
 *   - `rate-limited` → another alert for this exact location is
 *     already inside the window; the suppressed counter is bumped
 *     and surfaced on the next successful alert.
 *   - `no-recipients` → no system-admin user has an email; nothing
 *     to send to.
 *   - `failed` → slot claim or send failed; logged at error.
 *   - `sent` → email dispatched and the summary persisted for the
 *     in-app banner. Persisting the summary is best-effort: a
 *     persist failure does not flip `sent` back.
 */
export class SquareCatalogCapAlerter {
  constructor(private readonly deps: SquareCatalogCapAlerterDeps = defaultDeps) {}

  async notifyCapHit(event: SquareCatalogCapEvent): Promise<NotifyResult> {
    if (!this.deps.isEnabled()) {
      log.info("Square catalog cap alerts disabled — skipping email", {
        locationId: event.locationId,
        organizationId: event.organizationId,
      });
      return "disabled";
    }

    const kind = squareCatalogCapAlertKind(event.locationId);
    let claim: { claimed: boolean; suppressedCount: number };
    try {
      claim = await this.deps.tryClaimSlot(kind, this.deps.minIntervalMs());
    } catch (err) {
      log.error("Failed to claim Square catalog cap alerter slot", {
        kind,
        err: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }

    if (!claim.claimed) {
      log.warn("Square catalog cap alert rate-limited", {
        locationId: event.locationId,
        organizationId: event.organizationId,
        suppressedCount: claim.suppressedCount,
        minIntervalMs: this.deps.minIntervalMs(),
      });
      return "rate-limited";
    }

    let toEmails: string[];
    try {
      toEmails = await this.deps.getAdminEmails(event.organizationId);
    } catch (err) {
      log.error("Failed to load system-admin emails for Square catalog cap alert", {
        err: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
    if (toEmails.length === 0) {
      log.warn("No system-admin recipients configured for Square catalog cap alert");
      return "no-recipients";
    }

    const summary: SquareCatalogCapAlerterSummary = {
      organizationId: event.organizationId,
      locationId: event.locationId,
      reason: event.reason,
      context: event.context,
      suppressedSinceLastAlert: claim.suppressedCount,
    };

    const sent = await this.deps.send(toEmails, {
      organizationId: event.organizationId,
      locationId: event.locationId,
      reason: event.reason,
      context: event.context,
      suppressedSinceLastAlert: claim.suppressedCount,
    });

    if (sent) {
      try {
        await this.deps.recordSummary(kind, summary);
      } catch (err) {
        log.warn("Failed to persist Square catalog cap alert summary for in-app banner", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return sent ? "sent" : "failed";
  }
}

export const squareCatalogCapAlerter = new SquareCatalogCapAlerter();
