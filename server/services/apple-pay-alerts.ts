import { env, isDev } from "../config";
import { createLogger } from "../logger";
import { storage } from "../storage";
import { sendApplePayRecoveryAlert } from "./email";

const log = createLogger("ApplePayAlerts");

const ALERT_KIND = "apple_pay_recovery";

/** Persist alert throttles/summaries per business once request context is pinned. */
export function applePayRecoveryAlertKind(organizationId?: number): string {
  return organizationId === undefined ? ALERT_KIND : `${ALERT_KIND}:org:${organizationId}`;
}

interface RecoveredItem {
  jobId: number;
  itemId: number;
}

interface AlertSummary {
  itemCount: number;
  affectedJobIds: number[];
  itemIds: number[];
  suppressedSinceLastAlert: number;
}

export interface AlerterDeps {
  send: typeof sendApplePayRecoveryAlert;
  getAdminEmails: (organizationId?: number) => Promise<string[]>;
  isEnabled: () => boolean;
  minIntervalMs: () => number;
  /**
   * Atomically attempt to claim the next alert slot. Persisted in the
   * database so multi-instance deployments and rapid restart loops
   * cannot bypass the rate limit.
   */
  tryClaimSlot: (
    kind: string,
    minIntervalMs: number,
  ) => Promise<{ claimed: boolean; suppressedCount: number }>;
  /**
   * Persist a description of the most recent alert so the admin
   * dashboard can render an in-app banner ("N items recovered at
   * HH:MM, click to investigate") without needing the operator to
   * dig the email back out (#272).
   */
  recordSummary: (kind: string, summary: AlertSummary) => Promise<void>;
}

const defaultDeps: AlerterDeps = {
  send: sendApplePayRecoveryAlert,
  getAdminEmails: async (organizationId) => {
    const allUsers = await storage.getUsers();
    return allUsers
      .filter((u) => u.role === "system_admin"
        && u.email
        && (organizationId === undefined
          || u.organizationId === organizationId
          // Preserve the explicit legacy Owner exception while excluding
          // retained system admins from the alert recipient set.
          || u.organizationId === null))
      .map((u) => u.email);
  },
  isEnabled: () => {
    if (env.APPLE_PAY_RECOVERY_ALERTS_ENABLED !== undefined) {
      return env.APPLE_PAY_RECOVERY_ALERTS_ENABLED;
    }
    return !isDev;
  },
  minIntervalMs: () => env.APPLE_PAY_RECOVERY_ALERT_MIN_INTERVAL_MS,
  tryClaimSlot: (kind, ms) => storage.tryClaimAlerterSlot(kind, ms),
  recordSummary: (kind, summary) => storage.recordAlerterSummary(kind, summary),
};

export type NotifyResult =
  | "sent"
  | "rate-limited"
  | "disabled"
  | "no-recipients"
  | "no-items"
  | "failed";

export class ApplePayRecoveryAlerter {
  constructor(private readonly deps: AlerterDeps = defaultDeps) {}

  async notifyRecovered(items: RecoveredItem[], organizationId?: number): Promise<NotifyResult> {
    if (items.length === 0) return "no-items";
    if (!this.deps.isEnabled()) {
      log.info("Apple Pay recovery alerts disabled — skipping email", {
        itemCount: items.length,
      });
      return "disabled";
    }

    const kind = applePayRecoveryAlertKind(organizationId);
    let claim: { claimed: boolean; suppressedCount: number };
    try {
      claim = await this.deps.tryClaimSlot(kind, this.deps.minIntervalMs());
    } catch (err) {
      log.error("Failed to claim Apple Pay alerter slot", {
        err: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }

    if (!claim.claimed) {
      log.warn("Apple Pay recovery alert rate-limited", {
        itemCount: items.length,
        suppressedCount: claim.suppressedCount,
        minIntervalMs: this.deps.minIntervalMs(),
      });
      return "rate-limited";
    }

    let toEmails: string[];
    try {
      toEmails = await this.deps.getAdminEmails(organizationId);
    } catch (err) {
      log.error("Failed to load system-admin emails for Apple Pay alert", {
        err: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
    if (toEmails.length === 0) {
      log.warn("No system-admin recipients configured for Apple Pay recovery alert");
      return "no-recipients";
    }

    const affectedJobIds = Array.from(new Set(items.map((i) => i.jobId)));
    const itemIds = items.map((i) => i.itemId);

    const summary: AlertSummary = {
      itemCount: items.length,
      affectedJobIds,
      itemIds,
      suppressedSinceLastAlert: claim.suppressedCount,
    };

    const sent = await this.deps.send(toEmails, summary);

    if (sent) {
      // Persist the summary so the admin dashboard banner can describe
      // what just fired without re-reading server logs (#272). A failure
      // to record is non-fatal — the email already went out.
      try {
        await this.deps.recordSummary(kind, summary);
      } catch (err) {
        log.warn("Failed to persist Apple Pay alert summary for in-app banner", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return sent ? "sent" : "failed";
  }
}

export const APPLE_PAY_RECOVERY_ALERT_KIND = ALERT_KIND;

export const applePayRecoveryAlerter = new ApplePayRecoveryAlerter();
