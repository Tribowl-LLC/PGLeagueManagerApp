import {
  ACCOUNT_GUIDANCE_DELIVERY_PROVIDER_TIMEOUT_MS,
  type AccountGuidanceDeliveryJob,
} from "@shared/schema/account-guidance-delivery-jobs";
import { storage } from "../storage";
import { normalizeAccountEmail } from "../storage/users.js";
import { getAccountActionPendingState, hasPendingAccountInvitation } from "../storage/account-action-requests.js";
import { hasCurrentUnfinishedAccountRegistration } from "../storage/account-action-delivery-jobs.js";
import {
  claimNextAccountGuidanceDeliveryJob,
  finalizeAccountGuidanceDeliveryJob,
  recoverAccountGuidanceDeliveryJobs,
  type ClaimedAccountGuidanceDeliveryJob,
  type AccountGuidanceDeliveryFinalization,
} from "../storage/account-guidance-delivery-jobs.js";
import { createLogger } from "../logger.js";

const log = createLogger("AccountGuidanceDeliveryWorker");
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

export interface AccountGuidanceDeliveryTarget {
  recipientEmail: string;
  noticeType: AccountGuidanceDeliveryJob["noticeType"];
  userName: string;
  organization: { name?: string | null; slug?: string | null; subdomain?: string | null } | null;
}

export type AccountGuidanceProviderOutcome =
  | { kind: "accepted"; providerMessageId?: string | null }
  | { kind: "failed"; errorCode: string; retryable?: boolean };

export interface AccountGuidanceDeliveryWorkerDependencies {
  claim: () => Promise<ClaimedAccountGuidanceDeliveryJob | undefined>;
  recover: () => Promise<number>;
  loadTarget: (job: AccountGuidanceDeliveryJob) => Promise<AccountGuidanceDeliveryTarget | undefined>;
  send: (input: { job: AccountGuidanceDeliveryJob; target: AccountGuidanceDeliveryTarget }) => Promise<AccountGuidanceProviderOutcome>;
  finalize: (input: {
    jobId: number;
    leaseToken: string;
    outcome: AccountGuidanceDeliveryFinalization;
  }) => Promise<boolean>;
  providerTimeoutMs: number;
  now: () => number;
}

const productionDependencies: AccountGuidanceDeliveryWorkerDependencies = {
  claim: () => claimNextAccountGuidanceDeliveryJob(),
  recover: () => recoverAccountGuidanceDeliveryJobs(),
  loadTarget: async (job) => {
    if (job.noticeType === "account_exists") {
      if (job.userId === null) return undefined;
      const user = await storage.getUser(job.userId);
      if (
        !user
        || normalizeAccountEmail(user.email) !== job.recipientEmail
        || !user.password
      ) return undefined;

      // A still-unfinished email-first registration is handled by the
      // existing setup-link flow. The durable origin check is necessary even
      // when its delivery row is queued, failed, or expired: all new users
      // have a placeholder password, so password truthiness is not completion.
      const unfinishedRegistration = await hasCurrentUnfinishedAccountRegistration({
        userId: user.id,
        role: user.role,
        credentialGeneration: user.credentialGeneration,
      });
      if (unfinishedRegistration) return undefined;
      const pending = await getAccountActionPendingState({
        userId: user.id,
        action: "account_registration",
      });
      if (pending.pendingCount > 0) return undefined;
      if (await hasPendingAccountInvitation(user.id)) return undefined;

      if (user.organizationId !== null) {
        const organization = await storage.getOrganization(user.organizationId);
        if (!organization?.active) return undefined;
        return {
          recipientEmail: job.recipientEmail,
          noticeType: job.noticeType,
          userName: user.name?.trim() || "there",
          organization,
        };
      }
      return {
        recipientEmail: user.email,
        noticeType: job.noticeType,
        userName: user.name?.trim() || "there",
        organization: null,
      };
    }

    // An unknown address can become registered while its notice is queued.
    // Recheck immediately before dispatch so the message never states stale
    // account status. The signup organization is the validated snapshot from
    // the public request; it is never derived from an arbitrary Host header.
    const existing = await storage.getUserByEmail(job.recipientEmail);
    if (existing) return undefined;
    if (job.organizationId === null) return undefined;
    const organization = await storage.getOrganization(job.organizationId);
    if (!organization?.active) return undefined;
    return {
      recipientEmail: job.recipientEmail,
      noticeType: job.noticeType,
      userName: "there",
      organization,
    };
  },
  send: async () => {
    throw new Error("Account guidance delivery sender is not configured");
  },
  finalize: finalizeAccountGuidanceDeliveryJob,
  providerTimeoutMs: ACCOUNT_GUIDANCE_DELIVERY_PROVIDER_TIMEOUT_MS,
  now: () => Date.now(),
};

export interface AccountGuidanceDeliveryRunResult {
  kind: "idle" | "processed" | "lease_lost";
  jobId?: number;
  outcome?: AccountGuidanceDeliveryFinalization["status"];
}

/**
 * Interleave credential work between guidance notices. A provider timeout is
 * bounded, but checking the credential queue before every lower-priority
 * notice keeps a newly requested reset from waiting behind a whole batch.
 */
export async function runAccountGuidanceFairSweep(input: {
  runCredentialOne: () => Promise<unknown>;
  runGuidanceOne: () => Promise<AccountGuidanceDeliveryRunResult>;
  maxJobs: number;
}): Promise<AccountGuidanceDeliveryRunResult[]> {
  if (!Number.isSafeInteger(input.maxJobs) || input.maxJobs < 1 || input.maxJobs > 10_000) {
    throw new Error("maxJobs must be between 1 and 10000");
  }
  const results: AccountGuidanceDeliveryRunResult[] = [];
  for (let count = 0; count < input.maxJobs; count += 1) {
    await input.runCredentialOne();
    const result = await input.runGuidanceOne();
    results.push(result);
    if (result.kind === "idle") break;
  }
  return results;
}

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

/** Bounded durable worker for account-status guidance emails. */
export class AccountGuidanceDeliveryWorker {
  private active = false;
  private started = false;
  private recoveryPromise: Promise<number> | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private readonly dependencies: AccountGuidanceDeliveryWorkerDependencies;

  constructor(overrides: Partial<AccountGuidanceDeliveryWorkerDependencies> = {}) {
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

  async runOne(): Promise<AccountGuidanceDeliveryRunResult> {
    if (this.started && !this.active) return { kind: "idle" };
    const operation = this.runOneInternal();
    this.inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(operation);
    }
  }

  async runUntilIdle(options: { maxJobs?: number } = {}): Promise<AccountGuidanceDeliveryRunResult[]> {
    const maxJobs = options.maxJobs ?? 100;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) {
      throw new Error("maxJobs must be between 1 and 10000");
    }
    const results: AccountGuidanceDeliveryRunResult[] = [];
    for (let count = 0; count < maxJobs; count += 1) {
      const result = await this.runOne();
      results.push(result);
      if (result.kind === "idle") break;
    }
    return results;
  }

  private async runOneInternal(): Promise<AccountGuidanceDeliveryRunResult> {
    await this.recoverOnStartup();
    const claimed = await this.dependencies.claim();
    if (!claimed) return { kind: "idle" };
    const { job, leaseToken } = claimed;
    const finalize = async (outcome: AccountGuidanceDeliveryFinalization): Promise<AccountGuidanceDeliveryRunResult> => {
      const finalized = await this.dependencies.finalize({ jobId: job.id, leaseToken, outcome });
      return { kind: finalized ? "processed" : "lease_lost", jobId: job.id, outcome: outcome.status };
    };

    try {
      const target = await this.dependencies.loadTarget(job);
      if (!target) return finalize({ status: "suppressed", reason: "account_state_changed" });
      const expiresAt = Date.parse(job.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) {
        return finalize({ status: "failed", errorCode: "intent_expired" });
      }
      const providerPromise = Promise.resolve()
        .then(() => this.dependencies.send({ job, target }))
        .catch((error): AccountGuidanceProviderOutcome => ({
          kind: "failed",
          errorCode: safeErrorCode(error),
          retryable: true,
        }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AccountGuidanceProviderOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "failed", errorCode: "provider_timeout" }), this.dependencies.providerTimeoutMs);
        if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
      });
      let providerOutcome: AccountGuidanceProviderOutcome;
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
      log.error("Account guidance delivery attempt failed", {
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

export { productionDependencies as accountGuidanceDeliveryProductionDependencies };
