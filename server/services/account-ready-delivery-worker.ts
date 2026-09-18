import {
  ACCOUNT_READY_DELIVERY_PROVIDER_TIMEOUT_MS,
  type AccountReadyDeliveryJob,
} from "@shared/schema/account-ready-delivery-jobs";
import { storage } from "../storage";
import { sendAccountReadyEmail, type EmailNotification } from "./email";
import { db } from "../db.js";
import { desc, eq } from "drizzle-orm";
import { identityLinkEvents } from "@shared/schema/identity-link-events";
import { createLogger } from "../logger.js";
import {
  claimNextAccountReadyDeliveryJob,
  finalizeAccountReadyDeliveryJob,
  recoverAccountReadyDeliveryJobs,
  type ClaimedAccountReadyDeliveryJob,
} from "../storage/account-ready-delivery-jobs.js";
const log = createLogger("AccountReadyDeliveryWorker");
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

type AccountReadyDeliveryFinalization =
  | { status: "succeeded"; providerMessageId?: string | null }
  | { status: "retry_scheduled"; errorCode: string; retryAfterMs: number }
  | { status: "failed"; errorCode: string }
  | { status: "suppressed"; reason: string };

export interface AccountReadyDeliveryTarget {
  toEmail: string;
  toName: string;
  bowlerName: string;
  organization: {
    name?: string | null;
    slug?: string | null;
    subdomain?: string | null;
    logo?: string | null;
  };
  leagueName: string;
  teamName: string;
}

export type AccountReadyProviderOutcome =
  | { kind: "accepted"; providerMessageId?: string | null }
  | { kind: "failed"; errorCode: string; retryable?: boolean };
export interface AccountReadyDeliveryRunResult {
  kind: "idle" | "processed" | "lease_lost";
  jobId?: number;
  outcome?: AccountReadyDeliveryFinalization["status"];
}

export interface AccountReadyDeliveryWorkerDependencies {
  claim: () => Promise<ClaimedAccountReadyDeliveryJob | undefined>;
  recover: () => Promise<number>;
  loadTarget: (job: AccountReadyDeliveryJob) => Promise<AccountReadyDeliveryTarget | undefined>;
  send: (input: {
    job: AccountReadyDeliveryJob;
    target: AccountReadyDeliveryTarget;
  }) => Promise<AccountReadyProviderOutcome>;
  finalize: (input: {
    jobId: number;
    leaseToken: string;
    outcome: AccountReadyDeliveryFinalization;
  }) => Promise<boolean>;
  providerTimeoutMs: number;
  now: () => number;
}

const productionDependencies: AccountReadyDeliveryWorkerDependencies = {
  claim: () => claimNextAccountReadyDeliveryJob(),
  recover: () => recoverAccountReadyDeliveryJobs(),
  loadTarget: async (job) => {
    const [user, bowler, organization] = await Promise.all([
      storage.getUser(job.userId),
      storage.getBowler(job.bowlerId),
      storage.getOrganization(job.organizationId),
    ]);
    if (
      !user
      || user.role !== "user"
      || !user.email?.trim()
      || user.bowlerId !== job.bowlerId
      || user.organizationId !== job.organizationId
      || !bowler
      || bowler.organizationId !== job.organizationId
      || !organization
      || !organization.active
    ) {
      return undefined;
    }

    // A user can be unlinked and linked again to the same bowler while an old
    // job is waiting. Only the newest identity event may send this message;
    // otherwise the old job would duplicate the current link notification.
    const [latestLinkEvent] = await db
      .select({
        id: identityLinkEvents.id,
        eventType: identityLinkEvents.eventType,
        newBowlerId: identityLinkEvents.newBowlerId,
        organizationId: identityLinkEvents.organizationId,
      })
      .from(identityLinkEvents)
      .where(eq(identityLinkEvents.subjectUserId, user.id))
      .orderBy(desc(identityLinkEvents.createdAt), desc(identityLinkEvents.id))
      .limit(1);
    if (
      !latestLinkEvent
      || latestLinkEvent.id !== job.identityLinkEventId
      || !["link", "admin_assignment"].includes(latestLinkEvent.eventType)
      || latestLinkEvent.newBowlerId !== job.bowlerId
      || latestLinkEvent.organizationId !== job.organizationId
    ) {
      return undefined;
    }

    // The profile-claim worker owns the combined message when the immutable
    // roster recipient is the same mailbox as the new account. Suppressing
    // this separate intent prevents two automatic emails while preserving the
    // report capability in the combined notice.
    const { shouldCombineProfileClaimWithAccountReady } = await import(
      "../storage/profile-claim-notifications.js"
    );
    const combineProfileClaim = await shouldCombineProfileClaimWithAccountReady({
      identityLinkEventId: job.identityLinkEventId,
      accountReadyRecipientEmail: user.email,
    });
    if (combineProfileClaim) return undefined;

    let leagueName = "";
    let teamName = "";
    const [membership] = await storage.getBowlerLeagues({ bowlerId: bowler.id });
    if (membership) {
      const [league, team] = await Promise.all([
        storage.getLeague(membership.leagueId),
        storage.getTeam(membership.teamId),
      ]);
      if (league?.organizationId === organization.id) {
        leagueName = league.name;
        if (team?.leagueId === league.id) teamName = team.name;
      }
    }

    return {
      toEmail: user.email.trim().toLowerCase(),
      toName: user.name,
      bowlerName: bowler.name,
      organization,
      leagueName,
      teamName,
    };
  },
  send: async ({ target }): Promise<AccountReadyProviderOutcome> => {
    const result: EmailNotification = await sendAccountReadyEmail({
      toEmail: target.toEmail,
      toName: target.toName,
      bowlerName: target.bowlerName,
      leagueName: target.leagueName,
      teamName: target.teamName,
      organization: target.organization,
    });
    return result === "accepted"
      ? { kind: "accepted" }
      : { kind: "failed", errorCode: "provider_not_accepted", retryable: true };
  },
  finalize: finalizeAccountReadyDeliveryJob,
  providerTimeoutMs: ACCOUNT_READY_DELIVERY_PROVIDER_TIMEOUT_MS,
  now: () => Date.now(),
};

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  }
  return "provider_error";
}

function retryDelayForAttempt(attemptCount: number): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1));
  return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

export class AccountReadyDeliveryWorker {
  private active = false;
  private started = false;
  private recoveryPromise: Promise<number> | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private readonly dependencies: AccountReadyDeliveryWorkerDependencies;

  constructor(overrides: Partial<AccountReadyDeliveryWorkerDependencies> = {}) {
    this.dependencies = { ...productionDependencies, ...overrides };
  }

  async start(): Promise<void> {
    this.started = true;
    this.active = true;
    await this.recoverOnStartup();
  }

  stop(): void {
    this.active = false;
  }

  async stopAndDrain(timeoutMs = 35_000): Promise<void> {
    this.stop();
    if (this.inFlight.size === 0) return;
    const pending = Promise.allSettled([...this.inFlight]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
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

  async runOne(): Promise<AccountReadyDeliveryRunResult> {
    if (this.started && !this.active) return { kind: "idle" };
    const operation = this.runOneInternal();
    this.inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(operation);
    }
  }

  async runUntilIdle(options: { maxJobs?: number } = {}): Promise<AccountReadyDeliveryRunResult[]> {
    const maxJobs = options.maxJobs ?? 100;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) {
      throw new Error("maxJobs must be between 1 and 10000");
    }
    const results: AccountReadyDeliveryRunResult[] = [];
    for (let count = 0; count < maxJobs; count += 1) {
      const result = await this.runOne();
      results.push(result);
      if (result.kind === "idle") break;
    }
    return results;
  }

  private async runOneInternal(): Promise<AccountReadyDeliveryRunResult> {
    await this.recoverOnStartup();
    const claimed = await this.dependencies.claim();
    if (!claimed) return { kind: "idle" };
    const { job, leaseToken } = claimed;
    const finalize = async (
      outcome: AccountReadyDeliveryFinalization,
    ): Promise<AccountReadyDeliveryRunResult> => {
      const finalized = await this.dependencies.finalize({ jobId: job.id, leaseToken, outcome });
      return {
        kind: finalized ? "processed" : "lease_lost",
        jobId: job.id,
        outcome: outcome.status,
      };
    };

    try {
      const target = await this.dependencies.loadTarget(job);
      if (!target) return finalize({ status: "suppressed", reason: "state_changed" });
      const expiresAt = Date.parse(job.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) {
        return finalize({ status: "failed", errorCode: "intent_expired" });
      }
      const providerPromise = Promise.resolve()
        .then(() => this.dependencies.send({ job, target }))
        .catch((error): AccountReadyProviderOutcome => ({
          kind: "failed",
          errorCode: safeErrorCode(error),
          retryable: true,
        }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AccountReadyProviderOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "failed", errorCode: "provider_timeout" }),
          this.dependencies.providerTimeoutMs,
        );
        if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
      });
      let providerOutcome: AccountReadyProviderOutcome;
      try {
        providerOutcome = await Promise.race([providerPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (providerOutcome.kind === "accepted") {
        return finalize({ status: "succeeded", providerMessageId: providerOutcome.providerMessageId });
      }
      if (providerOutcome.retryable === false) {
        return finalize({ status: "failed", errorCode: providerOutcome.errorCode });
      }
      return finalize({
        status: "retry_scheduled",
        errorCode: providerOutcome.errorCode,
        retryAfterMs: retryDelayForAttempt(job.attemptCount),
      });
    } catch (error) {
      log.error("Account-ready delivery attempt failed", {
        jobId: job.id,
        errorCode: safeErrorCode(error),
      });
      return finalize({
        status: "retry_scheduled",
        errorCode: safeErrorCode(error),
        retryAfterMs: retryDelayForAttempt(job.attemptCount),
      });
    }
  }
}

export { productionDependencies as accountReadyDeliveryProductionDependencies };
