import { getBaseUrl, sendProfileClaimNotificationEmail } from "./email.js";
import { storage } from "../storage/index.js";
import { createLogger } from "../logger.js";
import {
  PROFILE_CLAIM_NOTIFICATION_MAX_RETRY_DELAY_MS,
  PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS,
  PROFILE_CLAIM_NOTIFICATION_LEASE_MS,
  type ProfileClaimNotification,
} from "@shared/schema/profile-claim-notifications";
import {
  claimNextProfileClaimNotification,
  finalizeProfileClaimNotification,
  isCurrentProfileClaimNotification,
  recoverProfileClaimNotifications,
  profileClaimReportTokenForEvent,
  shouldCombineProfileClaimWithAccountReady,
  type ClaimedProfileClaimNotification,
  type ProfileClaimNotificationFinalization,
} from "../storage/profile-claim-notifications.js";

const log = createLogger("ProfileClaimNotificationWorker");
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

export interface ProfileClaimNotificationWorkerDependencies {
  claim: () => Promise<ClaimedProfileClaimNotification | undefined>;
  recover: () => Promise<number>;
  loadTarget: (notification: ProfileClaimNotification) => Promise<boolean>;
  send: (notification: ProfileClaimNotification) => Promise<{ accepted: boolean; providerMessageId?: string | null; failureReason?: string }>;
  finalize: (input: { notificationId: number; leaseToken: string; outcome: ProfileClaimNotificationFinalization }) => Promise<boolean>;
  now: () => number;
}

function retryDelayForAttempt(attemptCount: number): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1));
  return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : "provider_error";
}

const productionDependencies: ProfileClaimNotificationWorkerDependencies = {
  claim: () => claimNextProfileClaimNotification(),
  recover: () => recoverProfileClaimNotifications(),
  loadTarget: (notification) => isCurrentProfileClaimNotification(notification),
  send: async (notification) => {
    const reportToken = profileClaimReportTokenForEvent(notification.identityLinkEventId);
    const organization = await storage.getOrganization(notification.organizationId);
    const reportUrl = `${getBaseUrl(organization ?? null)}/report-profile-claim?token=${encodeURIComponent(reportToken)}`;
    const combinedWithAccountReady = await shouldCombineProfileClaimWithAccountReady(notification);
    const result = await sendProfileClaimNotificationEmail({
      toEmail: notification.recipientEmail,
      toName: notification.recipientName,
      bowlerName: notification.bowlerName,
      organizationName: organization?.name,
      reportUrl,
      includeAccountReady: combinedWithAccountReady,
      loginUrl: `${getBaseUrl(organization ?? null)}/login`,
      dashboardUrl: `${getBaseUrl(organization ?? null)}/bowler-dashboard`,
    });
    return {
      accepted: result.accepted,
      providerMessageId: result.providerMessageId,
      failureReason: result.failureReason,
    };
  },
  finalize: finalizeProfileClaimNotification,
  now: () => Date.now(),
};

export class ProfileClaimNotificationWorker {
  private started = false;
  private active = false;
  private recoveryPromise: Promise<number> | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private readonly dependencies: ProfileClaimNotificationWorkerDependencies;

  constructor(overrides: Partial<ProfileClaimNotificationWorkerDependencies> = {}) {
    this.dependencies = { ...productionDependencies, ...overrides };
  }

  async start(): Promise<void> {
    this.started = true;
    this.active = true;
    await this.recoverOnStartup();
  }

  stop(): void { this.active = false; }

  async stopAndDrain(timeoutMs = PROFILE_CLAIM_NOTIFICATION_LEASE_MS + 35_000): Promise<void> {
    this.stop();
    if (this.inFlight.size === 0) return;
    const pending = Promise.allSettled([...this.inFlight]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async recoverOnStartup(): Promise<number> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const current = this.dependencies.recover().finally(() => {
      if (this.recoveryPromise === current) this.recoveryPromise = null;
    });
    this.recoveryPromise = current;
    return current;
  }

  async runOne(): Promise<{ kind: "idle" | "processed" | "lease_lost"; notificationId?: number; outcome?: string }> {
    if (this.started && !this.active) return { kind: "idle" };
    const operation = this.runOneInternal();
    this.inFlight.add(operation);
    try { return await operation; } finally { this.inFlight.delete(operation); }
  }

  async runUntilIdle(options: { maxJobs?: number } = {}): Promise<Array<{ kind: "idle" | "processed" | "lease_lost"; notificationId?: number; outcome?: string }>> {
    const maxJobs = options.maxJobs ?? 100;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new Error("maxJobs must be between 1 and 10000");
    const results = [] as Array<{ kind: "idle" | "processed" | "lease_lost"; notificationId?: number; outcome?: string }>;
    for (let i = 0; i < maxJobs; i += 1) {
      const result = await this.runOne();
      results.push(result);
      if (result.kind === "idle") break;
    }
    return results;
  }

  private async runOneInternal() {
    await this.recoverOnStartup();
    const claimed = await this.dependencies.claim();
    if (!claimed) return { kind: "idle" as const };
    const { notification, leaseToken } = claimed;
    const finalize = async (outcome: ProfileClaimNotificationFinalization) => ({
      kind: (await this.dependencies.finalize({ notificationId: notification.id, leaseToken, outcome }))
        ? "processed" as const : "lease_lost" as const,
      notificationId: notification.id,
      outcome: outcome.status,
    });
    try {
      const expiresAt = Date.parse(notification.reportTokenExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) return finalize({ status: "failed", errorCode: "intent_expired" });
      if (!(await this.dependencies.loadTarget(notification))) {
        return finalize({ status: "suppressed", reason: "state_changed" });
      }
      const result = await this.dependencies.send(notification);
      if (result.accepted) return finalize({ status: "succeeded", providerMessageId: result.providerMessageId });
      if (notification.attemptCount < PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS) {
        return finalize({ status: "retry_scheduled", errorCode: safeErrorCode(result.failureReason), retryAfterMs: Math.min(retryDelayForAttempt(notification.attemptCount), PROFILE_CLAIM_NOTIFICATION_MAX_RETRY_DELAY_MS) });
      }
      return finalize({ status: "failed", errorCode: safeErrorCode(result.failureReason) });
    } catch (error) {
      log.error("Profile-claim notification delivery failed", { notificationId: notification.id, errorCode: safeErrorCode(error instanceof Error ? error.name : error) });
      if (notification.attemptCount < PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS) {
        return finalize({ status: "retry_scheduled", errorCode: safeErrorCode(error instanceof Error ? error.name : error), retryAfterMs: retryDelayForAttempt(notification.attemptCount) });
      }
      return finalize({ status: "failed", errorCode: safeErrorCode(error instanceof Error ? error.name : error) });
    }
  }
}

export const profileClaimNotificationProductionDependencies = productionDependencies;
