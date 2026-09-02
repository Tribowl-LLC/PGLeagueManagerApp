import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentOperationWakeScheduler } from "../../server/services/payment-operation-wake-scheduler";

const executorMocks = vi.hoisted(() => ({
  prepareCutoff: vi.fn(),
  recordPreparationFailure: vi.fn(),
}));

vi.mock("../../server/config", () => ({ scheduledPaymentExecutionMode: "ledger_execute", rosterStandingAutopayEnabled: true }));
vi.mock("../../server/services/payment-provider-factory.js", () => ({ getPaymentProvider: vi.fn() }));
vi.mock("../../server/services/roster-standing-autopay.js", () => {
  class StandingAutopayError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) {
      super(message);
    }
  }
  return {
    StandingAutopayError,
    prepareStandingAutopayCutoff: executorMocks.prepareCutoff,
    getStandingAutopayExecutionSnapshot: vi.fn(),
    standingPaymentRows: vi.fn(),
  };
});
vi.mock("../../server/storage/payment-operations.js", () => ({
  getNextStandingAutopayWake: vi.fn(),
  recordStandingAutopayPreparationFailure: executorMocks.recordPreparationFailure,
  acquirePaymentOperationLease: vi.fn(),
  acquireStandingAutopayDispatchCutoff: vi.fn(),
  finalizePaymentOperationSuccess: vi.fn(),
  getPaymentOperationForOrganization: vi.fn(),
  recordPaymentOperationActionRequired: vi.fn(),
  recordPaymentOperationFailedTerminal: vi.fn(),
  recordPaymentOperationProviderUnknown: vi.fn(),
  schedulePaymentOperationRetry: vi.fn(),
}));

describe("standing automatic-payment wake isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports a separate cutoff/operation wake shape", async () => {
    const loadNextWake = vi.fn().mockResolvedValue({ kind: "standing_cutoff", organizationId: 7, leagueId: 11, consentId: "consent", dueAt: new Date(Date.now() + 60_000).toISOString() });
    const handleWake = vi.fn().mockResolvedValue(undefined);
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const clearTimeoutFn = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const scheduler = new PaymentOperationWakeScheduler({ loadNextWake, handleWake, setTimeoutFn, clearTimeoutFn });
    await scheduler.start("ledger_execute");
    expect(loadNextWake).toHaveBeenCalledTimes(1);
    expect(handleWake).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("defers a deterministic preparation failure and returns control to the queue", async () => {
    const { StandingAutopayError } = await import("../../server/services/roster-standing-autopay.js");
    const { RosterStandingAutopayOperationExecutor } = await import("../../server/services/roster-standing-autopay-executor.js");
    executorMocks.prepareCutoff.mockRejectedValueOnce(new StandingAutopayError("ARREARS_REQUIRE_ONE_TIME_FIFO", "older balance"));
    executorMocks.recordPreparationFailure.mockResolvedValueOnce({ state: "retry_scheduled", attemptCount: 1, nextAttemptAt: "2039-01-10 19:01:00" });
    const wake = {
      kind: "standing_cutoff" as const,
      organizationId: 7,
      leagueId: 11,
      consentId: "18d4239f-4b5f-47fb-af07-205965611574",
      consentVersion: 3,
      cutoffAt: "2039-01-10 19:00:00",
      occurrenceRevision: 2,
      preparationAttemptCount: 0,
      dueAt: "2039-01-10 19:00:00",
    };

    await expect(new RosterStandingAutopayOperationExecutor().handleWake(wake)).resolves.toBeUndefined();
    expect(executorMocks.prepareCutoff).toHaveBeenCalledWith(expect.objectContaining({ cutoffAt: wake.cutoffAt }));
    expect(executorMocks.recordPreparationFailure).toHaveBeenCalledWith(expect.objectContaining({
      consentId: wake.consentId,
      cutoffAt: wake.cutoffAt,
      occurrenceRevision: 2,
      expectedAttemptCount: 0,
      errorCode: "ARREARS_REQUIRE_ONE_TIME_FIFO",
      terminal: false,
    }));
  });

  it("does not classify an execution failure as a preparation failure", async () => {
    const { RosterStandingAutopayOperationExecutor } = await import("../../server/services/roster-standing-autopay-executor.js");
    executorMocks.prepareCutoff.mockResolvedValueOnce({ organizationId: 7, id: "7f0d3323-25bc-455b-a6d1-b378f73bc557" });
    const executor = new RosterStandingAutopayOperationExecutor();
    vi.spyOn(executor, "execute").mockRejectedValueOnce(new Error("local finalization failed"));
    const wake = {
      kind: "standing_cutoff" as const,
      organizationId: 7,
      leagueId: 11,
      consentId: "18d4239f-4b5f-47fb-af07-205965611574",
      consentVersion: 3,
      cutoffAt: "2039-01-10 19:00:00",
      occurrenceRevision: 2,
      preparationAttemptCount: 0,
      dueAt: "2039-01-10 19:00:00",
    };

    await expect(executor.handleWake(wake)).rejects.toThrow("local finalization failed");
    expect(executorMocks.recordPreparationFailure).not.toHaveBeenCalled();
  });
});
