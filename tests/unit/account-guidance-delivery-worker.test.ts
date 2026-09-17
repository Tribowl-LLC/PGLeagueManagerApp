import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountGuidanceDeliveryJob } from "@shared/schema/account-guidance-delivery-jobs";
import {
  AccountGuidanceDeliveryWorker,
  runAccountGuidanceFairSweep,
  type AccountGuidanceDeliveryTarget,
  type AccountGuidanceDeliveryWorkerDependencies,
  type AccountGuidanceProviderOutcome,
} from "../../server/services/account-guidance-delivery-worker";

const NOW = "2030-01-01T00:00:00.000Z";

function makeJob(overrides: Partial<AccountGuidanceDeliveryJob> = {}): AccountGuidanceDeliveryJob {
  return {
    id: 11,
    userId: null,
    recipientEmail: "person@example.test",
    noticeType: "account_missing",
    organizationId: 33,
    status: "processing",
    attemptCount: 1,
    nextAttemptAt: NOW,
    lastAttemptAt: NOW,
    leaseOwner: "test-worker",
    leaseToken: "lease-1",
    leaseExpiresAt: "2030-01-01T00:01:00.000Z",
    providerMessageId: null,
    lastErrorCode: null,
    expiresAt: "2030-01-01T01:00:00.000Z",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const target: AccountGuidanceDeliveryTarget = {
  recipientEmail: "person@example.test",
  noticeType: "account_missing",
  userName: "there",
  organization: { name: "Test League", slug: "test-league" },
};

function makeDependencies(
  overrides: Partial<AccountGuidanceDeliveryWorkerDependencies> = {},
): AccountGuidanceDeliveryWorkerDependencies {
  const job = makeJob();
  return {
    claim: vi.fn(async () => ({ job, leaseToken: "lease-1" })),
    recover: vi.fn(async () => 0),
    loadTarget: vi.fn(async () => target),
    send: vi.fn(async (): Promise<AccountGuidanceProviderOutcome> => ({
      kind: "accepted",
      providerMessageId: "sg-message",
    })),
    finalize: vi.fn(async () => true),
    providerTimeoutMs: 30_000,
    now: () => Date.parse(NOW),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountGuidanceDeliveryWorker", () => {
  it("rechecks credential work before each lower-priority guidance notice", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let guidanceRuns = 0;
    const pending = runAccountGuidanceFairSweep({
      runCredentialOne: vi.fn(async () => {
        order.push("credential");
      }),
      runGuidanceOne: vi.fn(async () => {
        order.push("guidance");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        guidanceRuns += 1;
        return guidanceRuns === 2
          ? { kind: "idle" as const }
          : { kind: "processed" as const, jobId: guidanceRuns, outcome: "succeeded" as const };
      }),
      maxJobs: 5,
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(await pending).toHaveLength(2);
    expect(order).toEqual(["credential", "guidance", "credential", "guidance"]);
  });

  it("sends a noncredential notice and records provider acceptance", async () => {
    const dependencies = makeDependencies();
    const worker = new AccountGuidanceDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result).toEqual({ kind: "processed", jobId: 11, outcome: "succeeded" });
    expect(dependencies.send).toHaveBeenCalledWith({
      job: expect.objectContaining({ id: 11, noticeType: "account_missing" }),
      target,
    });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: { status: "succeeded", providerMessageId: "sg-message" },
    });
  });

  it("suppresses a queued notice when the account state changed", async () => {
    const dependencies = makeDependencies({
      loadTarget: vi.fn(async () => undefined),
    });
    const worker = new AccountGuidanceDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result.outcome).toBe("suppressed");
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: { status: "suppressed", reason: "account_state_changed" },
    });
  });

  it("turns a slow provider into a bounded retry", async () => {
    vi.useFakeTimers();
    const dependencies = makeDependencies({
      providerTimeoutMs: 10,
      send: vi.fn(() => new Promise<never>(() => {})),
    });
    const worker = new AccountGuidanceDeliveryWorker(dependencies);

    const pending = worker.runOne();
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.outcome).toBe("retry_scheduled");
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: {
        status: "retry_scheduled",
        errorCode: "provider_timeout",
        retryAfterMs: 30_000,
      },
    });
  });

  it("does not retry a definitive provider rejection", async () => {
    const dependencies = makeDependencies({
      send: vi.fn(async (): Promise<AccountGuidanceProviderOutcome> => ({
        kind: "failed",
        errorCode: "provider_rejected",
        retryable: false,
      })),
    });
    const worker = new AccountGuidanceDeliveryWorker(dependencies);

    const result = await worker.runOne();

    expect(result).toEqual({ kind: "processed", jobId: 11, outcome: "failed" });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 11,
      leaseToken: "lease-1",
      outcome: { status: "failed", errorCode: "provider_rejected" },
    });
  });
});
