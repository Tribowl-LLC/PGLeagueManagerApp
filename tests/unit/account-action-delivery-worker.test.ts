import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountActionRequest } from "@shared/schema/account-action-requests";
import type { IssuedAccountAction, PasswordResetIssuanceResult } from "../../server/storage/account-action-requests";
import type { AccountActionDeliveryJob } from "@shared/schema/account-action-delivery-jobs";
import {
  AccountActionDeliveryWorker,
  type AccountActionDeliveryWorkerDependencies,
  type PasswordResetProviderOutcome,
  type PasswordResetDeliveryTarget,
} from "../../server/services/account-action-delivery-worker";
import { expectErrorLog } from "../helpers/expected-error-logs";

const NOW = "2030-01-01T00:00:00.000Z";

function makeJob(overrides: Partial<AccountActionDeliveryJob> = {}): AccountActionDeliveryJob {
  return {
    id: 11,
    userId: 22,
    organizationId: 33,
    action: "password_reset",
    credentialGeneration: 4,
    expiresAt: "2030-01-01T01:00:00.000Z",
    status: "processing",
    attemptCount: 1,
    nextAttemptAt: NOW,
    lastAttemptAt: NOW,
    leaseOwner: "test-worker",
    leaseToken: "lease-1",
    leaseExpiresAt: "2030-01-01T00:01:00.000Z",
    actionRequestId: null,
    providerMessageId: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAction(): IssuedAccountAction {
  const request = {
    id: 91,
    userId: 22,
    organizationId: 33,
    createdByUserId: null,
    deliveryJobId: 11,
    action: "password_reset",
    tokenHash: "a".repeat(64),
    expiresAt: "2030-01-01T01:00:00.000Z",
    status: "pending",
    deliveryStatus: "not_attempted",
    deliveryAttemptedAt: null,
    deliveredAt: null,
    consumedAt: null,
    supersededAt: null,
    revokedAt: null,
    expiredAt: null,
    createdAt: NOW,
  } satisfies AccountActionRequest;
  return { request, token: "transient-token" };
}

const target: PasswordResetDeliveryTarget = {
  userId: 22,
  email: "person@example.test",
  userName: "Test Person",
  organizationId: 33,
  credentialGeneration: 4,
  organizationSlug: "test-org",
};

function makeDependencies(
  overrides: Partial<AccountActionDeliveryWorkerDependencies> = {},
): AccountActionDeliveryWorkerDependencies {
  const job = makeJob();
  return {
    claim: vi.fn(async () => ({ job, leaseToken: "lease-1" })),
    recover: vi.fn(async () => 0),
    loadTarget: vi.fn(async () => target),
    issue: vi.fn(async (): Promise<PasswordResetIssuanceResult> => ({ kind: "issued", ...makeAction() })),
    attachAction: vi.fn(async () => true),
    send: vi.fn(async (): Promise<PasswordResetProviderOutcome> => ({ kind: "accepted", providerMessageId: "sg-message" })),
    finalize: vi.fn(async () => true),
    providerTimeoutMs: 30_000,
    now: () => Date.parse(NOW),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountActionDeliveryWorker", () => {
  it("issues one transient token and finalizes accepted delivery", async () => {
    const dependencies = makeDependencies();
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result).toEqual({ kind: "processed", jobId: 11, outcome: "succeeded" });
    expect(dependencies.attachAction).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      actionRequestId: 91,
    });
    expect(dependencies.send).toHaveBeenCalledWith(expect.objectContaining({
      job: expect.objectContaining({ id: 11 }),
      action: expect.objectContaining({ token: "transient-token" }),
    }));
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: {
        status: "succeeded",
        actionRequestId: 91,
        providerMessageId: "sg-message",
      },
    });
  });

  it("suppresses a stale credential-generation snapshot before minting a token", async () => {
    const dependencies = makeDependencies({
      loadTarget: vi.fn(async () => ({ ...target, credentialGeneration: 5 })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.kind).toBe("processed");
    expect(dependencies.issue).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { status: "suppressed", reason: "stale_credential" },
    }));
  });

  it("suppresses a registration job when the account moved organizations before issuance", async () => {
    const dependencies = makeDependencies({
      claim: vi.fn(async () => ({
        job: makeJob({ action: "account_registration", organizationId: 33 }),
        leaseToken: "lease-1",
      })),
      loadTarget: vi.fn(async () => ({ ...target, organizationId: 44 })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("suppressed");
    expect(dependencies.issue).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { status: "suppressed", reason: "account_not_pending" },
    }));
  });

  it("leaves an existing usable link intact when the three-link cap is reached", async () => {
    const dependencies = makeDependencies({
      issue: vi.fn(async (): Promise<PasswordResetIssuanceResult> => ({ kind: "suppressed", reason: "at_capacity" })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("suppressed");
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { status: "suppressed", reason: "at_capacity" },
    }));
  });

  it("turns a slow provider into a bounded uncertain retry", async () => {
    vi.useFakeTimers();
    const dependencies = makeDependencies({
      providerTimeoutMs: 10,
      send: vi.fn(() => new Promise<never>(() => {})),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const pending = worker.runOne();
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.outcome).toBe("retry_scheduled");
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        status: "retry_scheduled",
        actionRequestId: 91,
        errorCode: "provider_timeout",
        deliveryDisposition: "uncertain",
      }),
    }));
  });

  it("carries a retryable known-unsent provider disposition with the exact action", async () => {
    const dependencies = makeDependencies({
      send: vi.fn(async (): Promise<PasswordResetProviderOutcome> => ({
        kind: "failed",
        errorCode: "provider_rate_limited",
        retryable: true,
        deliveryDisposition: "known_unsent",
      })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("retry_scheduled");
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: {
        status: "retry_scheduled",
        actionRequestId: 91,
        errorCode: "provider_rate_limited",
        retryAfterMs: 30_000,
        deliveryDisposition: "known_unsent",
      },
    });
  });

  it("revokes an action only for a definitive pre-submission failure", async () => {
    const dependencies = makeDependencies({
      send: vi.fn(async (): Promise<PasswordResetProviderOutcome> => ({
        kind: "failed",
        errorCode: "not_configured",
        retryable: false,
        deliveryDisposition: "known_unsent",
      })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result).toEqual({ kind: "processed", jobId: 11, outcome: "failed" });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: {
        status: "failed",
        actionRequestId: 91,
        errorCode: "not_configured",
        deliveryDisposition: "known_unsent",
      },
    });
  });

  it("retains an action when a nonretryable result does not prove provider non-submission", async () => {
    const dependencies = makeDependencies({
      send: vi.fn(async (): Promise<PasswordResetProviderOutcome> => ({
        kind: "failed",
        errorCode: "provider_rejected",
        retryable: false,
        deliveryDisposition: "uncertain",
      })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("failed");
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: {
        status: "failed",
        actionRequestId: 91,
        errorCode: "provider_rejected",
        deliveryDisposition: "uncertain",
      },
    }));
  });

  it("does not reuse a prior uncertain action when the durable intent expires", async () => {
    const dependencies = makeDependencies({
      claim: vi.fn(async () => ({
        job: makeJob({
          expiresAt: "2029-12-31T23:00:00.000Z",
          actionRequestId: 91,
        }),
        leaseToken: "lease-1",
      })),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result).toEqual({ kind: "processed", jobId: 11, outcome: "failed" });
    expect(dependencies.issue).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: {
        status: "failed",
        errorCode: "intent_expired",
        deliveryDisposition: "uncertain",
      },
    });
  });

  it("classifies a resolver crash as uncertain work and schedules a bounded retry", async () => {
    expectErrorLog(/Password-reset delivery attempt failed/);
    const dependencies = makeDependencies({
      loadTarget: vi.fn(async () => {
        throw new Error("database connection closed");
      }),
    });
    const worker = new AccountActionDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("retry_scheduled");
    expect(dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        status: "retry_scheduled",
        errorCode: "provider_error",
      }),
    }));
  });

  it("allows only one of two concurrent workers to process a single claim", async () => {
    let claimed = true;
    const dependencies = makeDependencies({
      claim: vi.fn(async () => {
        if (!claimed) return undefined;
        claimed = false;
        return { job: makeJob(), leaseToken: "lease-1" };
      }),
    });
    const workerA = new AccountActionDeliveryWorker(dependencies);
    const workerB = new AccountActionDeliveryWorker(dependencies);

    const results = await Promise.all([workerA.runOne(), workerB.runOne()]);

    expect(results.filter((result) => result.kind === "processed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "idle")).toHaveLength(1);
    expect(dependencies.send).toHaveBeenCalledTimes(1);
  });
});
