import {
  ACCOUNT_ACTION_DELIVERY_PROVIDER_TIMEOUT_MS,
  type AccountActionDeliveryJob,
} from "@shared/schema/account-action-delivery-jobs";
import {
  attachPasswordResetActionToDeliveryJob,
  claimNextPasswordResetDeliveryJob,
  finalizePasswordResetDeliveryJob,
  recoverPasswordResetDeliveryJobs,
  type ClaimedPasswordResetDeliveryJob,
  type PasswordResetDeliveryFinalization,
} from "../storage/account-action-delivery-jobs.js";
import {
  tryIssuePasswordReset,
  type PasswordResetIssuanceResult,
  type IssuedAccountAction,
} from "../storage/account-action-requests.js";
import { createLogger } from "../logger.js";

const log = createLogger("AccountActionDeliveryWorker");

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

export interface PasswordResetDeliveryTarget {
  userId: number;
  email: string;
  userName: string;
  organizationId: number | null;
  /** Must be read from the authoritative user row immediately before issue. */
  credentialGeneration: number;
  /** Root integration may use this to construct the tenant URL. */
  organizationSlug?: string | null;
}

export type PasswordResetProviderOutcome =
  | { kind: "accepted"; providerMessageId?: string | null }
  | { kind: "failed"; errorCode: string; retryable?: boolean }
  | { kind: "uncertain"; errorCode: string };

export interface PasswordResetDeliverySenderInput {
  job: AccountActionDeliveryJob;
  target: PasswordResetDeliveryTarget;
  action: IssuedAccountAction;
}

export interface AccountActionDeliveryWorkerDependencies {
  claim: () => Promise<ClaimedPasswordResetDeliveryJob | undefined>;
  recover: () => Promise<number>;
  loadTarget: (job: AccountActionDeliveryJob) => Promise<PasswordResetDeliveryTarget | undefined>;
  issue: (input: {
    userId: number;
    recipientEmail: string;
    organizationId: number | null;
    expiresAt: Date;
    deliveryJobId: number;
    expectedCredentialGeneration: number;
  }) => Promise<PasswordResetIssuanceResult>;
  attachAction: (input: {
    jobId: number;
    leaseToken: string;
    actionRequestId: number;
  }) => Promise<boolean>;
  send: (input: PasswordResetDeliverySenderInput) => Promise<PasswordResetProviderOutcome>;
  finalize: (input: {
    jobId: number;
    leaseToken: string;
    outcome: PasswordResetDeliveryFinalization;
  }) => Promise<boolean>;
  providerTimeoutMs: number;
  now: () => number;
}

const productionDependencies: AccountActionDeliveryWorkerDependencies = {
  claim: () => claimNextPasswordResetDeliveryJob(),
  recover: () => recoverPasswordResetDeliveryJobs(),
  loadTarget: async () => {
    // The target resolver is application-specific because it must load the
    // current user, organization URL context, and credential generation. Root
    // wiring supplies this function; silently sending without it is unsafe.
    throw new Error("Password-reset delivery target resolver is not configured");
  },
  issue: (input) => tryIssuePasswordReset({
    userId: input.userId,
    recipientEmail: input.recipientEmail,
    organizationId: input.organizationId,
    expiresAt: input.expiresAt,
    deliveryJobId: input.deliveryJobId,
    expectedCredentialGeneration: input.expectedCredentialGeneration,
  }),
  attachAction: attachPasswordResetActionToDeliveryJob,
  send: async () => {
    throw new Error("Password-reset delivery sender is not configured");
  },
  finalize: finalizePasswordResetDeliveryJob,
  providerTimeoutMs: ACCOUNT_ACTION_DELIVERY_PROVIDER_TIMEOUT_MS,
  now: () => Date.now(),
};

export interface AccountActionDeliveryRunResult {
  kind: "idle" | "processed" | "lease_lost";
  jobId?: number;
  outcome?: PasswordResetDeliveryFinalization["status"];
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

/**
 * Bounded worker for password-reset delivery intents. It never keeps a DB
 * transaction open across user lookup, template rendering, or provider I/O.
 */
export class AccountActionDeliveryWorker {
  private active = false;
  private started = false;
  private recoveryPromise: Promise<number> | null = null;
  private inFlight = new Set<Promise<unknown>>();

  private readonly dependencies: AccountActionDeliveryWorkerDependencies;

  constructor(overrides: Partial<AccountActionDeliveryWorkerDependencies> = {}) {
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

  /** Stop accepting new claims and wait briefly for a provider call to settle. */
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

  /** Process one currently due intent. Safe to call from tests before start. */
  async runOne(): Promise<AccountActionDeliveryRunResult> {
    if (this.started && !this.active) return { kind: "idle" };
    const operation = this.runOneInternal();
    // Include recovery and claiming in the drain fence. A shutdown must not
    // see an empty set between claim and process while the DB pool is closing.
    this.inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(operation);
    }
  }

  private async runOneInternal(): Promise<AccountActionDeliveryRunResult> {
    await this.recoverOnStartup();
    const claimed = await this.dependencies.claim();
    if (!claimed) return { kind: "idle" };
    return this.processClaimed(claimed);
  }

  /** Drain due work deterministically; future retry timestamps remain queued. */
  async runUntilIdle(options: { maxJobs?: number } = {}): Promise<AccountActionDeliveryRunResult[]> {
    const maxJobs = options.maxJobs ?? 100;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) {
      throw new Error("maxJobs must be between 1 and 10000");
    }
    const results: AccountActionDeliveryRunResult[] = [];
    for (let count = 0; count < maxJobs; count += 1) {
      const result = await this.runOne();
      results.push(result);
      if (result.kind === "idle") break;
    }
    return results;
  }

  private async processClaimed(
    claimed: ClaimedPasswordResetDeliveryJob,
  ): Promise<AccountActionDeliveryRunResult> {
    const { job, leaseToken } = claimed;
    const finalize = async (outcome: PasswordResetDeliveryFinalization): Promise<AccountActionDeliveryRunResult> => {
      const finalized = await this.dependencies.finalize({ jobId: job.id, leaseToken, outcome });
      return {
        kind: finalized ? "processed" : "lease_lost",
        jobId: job.id,
        outcome: outcome.status,
      };
    };

    try {
      const target = await this.dependencies.loadTarget(job);
      if (!target) {
        return finalize({ status: "suppressed", reason: "user_missing" });
      }
      if (
        target.userId !== job.userId
        || !Number.isSafeInteger(target.credentialGeneration)
        || target.credentialGeneration < 0
        || target.credentialGeneration !== job.credentialGeneration
      ) {
        return finalize({ status: "suppressed", reason: "stale_credential" });
      }

      const expiresAt = new Date(job.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= this.dependencies.now()) {
        return finalize({ status: "failed", errorCode: "intent_expired" });
      }

      const issuance = await this.dependencies.issue({
        userId: target.userId,
        recipientEmail: target.email,
        organizationId: target.organizationId,
        expiresAt,
        deliveryJobId: job.id,
        expectedCredentialGeneration: job.credentialGeneration,
      });
      if (issuance.kind === "suppressed") {
        return finalize({ status: "suppressed", reason: issuance.reason });
      }
      if (!await this.dependencies.attachAction({
        jobId: job.id,
        leaseToken,
        actionRequestId: issuance.request.id,
      })) {
        return { kind: "lease_lost", jobId: job.id };
      }

      const providerOutcome = await this.sendWithTimeout({
        job,
        target,
        action: issuance,
      });
      if (providerOutcome.kind === "accepted") {
        return finalize({
          status: "succeeded",
          actionRequestId: issuance.request.id,
          providerMessageId: providerOutcome.providerMessageId,
        });
      }
      if (providerOutcome.kind === "failed" && providerOutcome.retryable === false) {
        return finalize({
          status: "failed",
          actionRequestId: issuance.request.id,
          errorCode: providerOutcome.errorCode,
        });
      }
      return finalize({
        status: "retry_scheduled",
        actionRequestId: issuance.request.id,
        errorCode: providerOutcome.errorCode,
        retryAfterMs: retryDelayForAttempt(job.attemptCount),
      });
    } catch (error) {
      // A worker exception is treated as uncertain provider work. The action
      // remains pending/usable, and a bounded retry may create another link
      // without evicting it. Error logs contain only a stable code and job ID.
      log.error("Password-reset delivery attempt failed", {
        jobId: job.id,
        errorCode: safeErrorCode(error),
      });
      return finalize({
        status: "retry_scheduled",
        actionRequestId: job.actionRequestId ?? undefined,
        errorCode: safeErrorCode(error),
        retryAfterMs: retryDelayForAttempt(job.attemptCount),
      });
    }
  }

  private async sendWithTimeout(input: PasswordResetDeliverySenderInput): Promise<PasswordResetProviderOutcome> {
    const providerPromise = Promise.resolve()
      .then(() => this.dependencies.send(input))
      .catch((error): PasswordResetProviderOutcome => ({
        kind: "failed",
        errorCode: safeErrorCode(error),
        retryable: true,
      }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PasswordResetProviderOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "uncertain", errorCode: "provider_timeout" }), this.dependencies.providerTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    });
    try {
      return await Promise.race([providerPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
