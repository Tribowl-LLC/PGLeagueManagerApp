import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountReadyDeliveryJob } from "@shared/schema/account-ready-delivery-jobs";

vi.mock("../../server/db", () => ({
  db: {},
  pool: {},
}));
vi.mock("../../server/storage", () => ({ storage: {} }));
vi.mock("../../server/services/email", () => ({
  sendAccountReadyEmail: vi.fn(async () => "accepted"),
}));
vi.mock("../../server/storage/account-ready-delivery-jobs", () => ({
  claimNextAccountReadyDeliveryJob: vi.fn(),
  finalizeAccountReadyDeliveryJob: vi.fn(),
  recoverAccountReadyDeliveryJobs: vi.fn(),
}));

import {
  AccountReadyDeliveryWorker,
  type AccountReadyDeliveryTarget,
  type AccountReadyDeliveryWorkerDependencies,
  type AccountReadyProviderOutcome,
} from "../../server/services/account-ready-delivery-worker";

const NOW = "2030-01-01T00:00:00.000Z";

function makeJob(overrides: Partial<AccountReadyDeliveryJob> = {}): AccountReadyDeliveryJob {
  return {
    id: 41,
    identityLinkEventId: 900,
    userId: 901,
    bowlerId: 902,
    organizationId: 903,
    status: "processing",
    standaloneDeliveryRequested: false,
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

const target: AccountReadyDeliveryTarget = {
  toEmail: "member@example.test",
  toName: "Member",
  bowlerName: "Member Bowler",
  organization: { name: "Test League", slug: "test-league" },
  leagueName: "Tuesday League",
  teamName: "Team 1",
};

function makeDependencies(
  overrides: Partial<AccountReadyDeliveryWorkerDependencies> = {},
): AccountReadyDeliveryWorkerDependencies {
  const job = makeJob();
  return {
    claim: vi.fn(async () => ({ job, leaseToken: "lease-1" })),
    recover: vi.fn(async () => 0),
    loadTarget: vi.fn(async () => target),
    send: vi.fn(async (): Promise<AccountReadyProviderOutcome> => ({
      kind: "accepted",
      providerMessageId: "provider-1",
    })),
    finalize: vi.fn(async () => true),
    providerTimeoutMs: 30_000,
    now: () => Date.parse(NOW),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("AccountReadyDeliveryWorker", () => {
  it("records provider acceptance", async () => {
    const dependencies = makeDependencies();
    const worker = new AccountReadyDeliveryWorker(dependencies);

    await expect(worker.runOne()).resolves.toEqual({
      kind: "processed",
      jobId: 41,
      outcome: "succeeded",
    });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 41,
      leaseToken: "lease-1",
      outcome: { status: "succeeded", providerMessageId: "provider-1" },
    });
  });

  it("suppresses a stale or deleted link without sending", async () => {
    const dependencies = makeDependencies({
      loadTarget: vi.fn(async () => undefined),
    });
    const worker = new AccountReadyDeliveryWorker(dependencies);

    await expect(worker.runOne()).resolves.toMatchObject({
      kind: "processed",
      outcome: "suppressed",
    });
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 41,
      leaseToken: "lease-1",
      outcome: { status: "suppressed", reason: "state_changed" },
    });
  });

  it("bounds a provider timeout and schedules a retry", async () => {
    vi.useFakeTimers();
    const dependencies = makeDependencies({
      providerTimeoutMs: 15,
      send: vi.fn(() => new Promise<never>(() => {})),
    });
    const worker = new AccountReadyDeliveryWorker(dependencies);
    const pending = worker.runOne();
    await vi.advanceTimersByTimeAsync(15);

    await expect(pending).resolves.toMatchObject({
      kind: "processed",
      outcome: "retry_scheduled",
    });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 41,
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
      send: vi.fn(async (): Promise<AccountReadyProviderOutcome> => ({
        kind: "failed",
        errorCode: "provider_rejected",
        retryable: false,
      })),
    });
    const worker = new AccountReadyDeliveryWorker(dependencies);

    await expect(worker.runOne()).resolves.toMatchObject({
      kind: "processed",
      outcome: "failed",
    });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      jobId: 41,
      leaseToken: "lease-1",
      outcome: { status: "failed", errorCode: "provider_rejected" },
    });
  });

  it("does not report success after a stale lease loses its CAS", async () => {
    const dependencies = makeDependencies({ finalize: vi.fn(async () => false) });
    const worker = new AccountReadyDeliveryWorker(dependencies);

    await expect(worker.runOne()).resolves.toMatchObject({
      kind: "lease_lost",
      jobId: 41,
      outcome: "succeeded",
    });
  });
});
