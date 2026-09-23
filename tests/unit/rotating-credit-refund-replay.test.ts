import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paymentOperations, rotatingCreditFundings, rotatingCreditRefundOperationSnapshots, rotatingCreditRefunds } from "@shared/schema";
import { canonicalizePaymentOperationInput } from "../../server/services/payment-operation-idempotency";
import { createRotatingCreditRefundSnapshot } from "../../server/services/rotating-credit-refund-snapshot";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockLeague: vi.fn(),
  readBalance: vi.fn(),
  readFundingBalances: vi.fn(),
  createRefundOperation: vi.fn(),
  persistRefundSnapshot: vi.fn(),
  executeRefund: vi.fn(),
}));

vi.mock("../../server/db.js", () => ({ db: { transaction: (...args: unknown[]) => mocks.transaction(...args) } }));
vi.mock("../../server/storage/payment-operations.js", () => ({
  createOrGetRotatingCreditRefundPaymentOperation: (...args: unknown[]) => mocks.createRefundOperation(...args),
  persistRotatingCreditRefundPaymentOperationSnapshot: (...args: unknown[]) => mocks.persistRefundSnapshot(...args),
}));
vi.mock("../../server/storage/league-schedule-lock.js", () => ({ lockLeagueSchedule: (...args: unknown[]) => mocks.lockLeague(...args) }));
vi.mock("../../server/services/refund-payment-operation-executor.js", () => ({
  refundPaymentOperationExecutor: { execute: (...args: unknown[]) => mocks.executeRefund(...args) },
}));
vi.mock("../../server/services/rotating-credit-applications.js", () => ({
  readRotatingCreditFundingBalancesInTransaction: (...args: unknown[]) => mocks.readFundingBalances(...args),
  isProviderRefundRetryBlocked: (operation: {
    status: string;
    providerObjectId: string | null;
    errorClassification: string | null;
    errorCode: string | null;
  }) => (operation.status === "failed_terminal"
    && operation.providerObjectId !== null
    && operation.errorClassification === "invalid_request"
    && (operation.errorCode === "REFUND_REJECTED" || operation.errorCode === "REFUND_FAILED"))
    || (operation.status === "action_required"
      && operation.providerObjectId === null
      && operation.errorClassification === "hard_decline"
      && operation.errorCode === "REFUND_DECLINED"),
}));
vi.mock("../../server/services/rotating-credit.js", () => ({
  readRotatingCreditBalance: (...args: unknown[]) => mocks.readBalance(...args),
}));

const { recordRotatingCreditRefund } = await import("../../server/services/rotating-credit-refund");

function requestFingerprint(input: {
  organizationId: number;
  leagueId: number;
  fundingId: string;
  actorUserId: number;
  request: {
    refundKind: "cash" | "provider";
    quoteFingerprint: string;
    idempotencyKey: string;
    reason: string;
    reference?: string;
  };
}): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-refund-request/1",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingId: input.fundingId,
    actorUserId: input.actorUserId,
    refundKind: input.request.refundKind,
    quoteFingerprint: input.request.quoteFingerprint,
    idempotencyKey: input.request.idempotencyKey,
    reason: input.request.reason.trim(),
    reference: input.request.reference?.trim() ?? null,
  })).digest("hex");
  return `lvrotcrrefund:v1:${digest}`;
}

function refundTargetKey(fundingId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-refund-target/1",
    fundingId,
    idempotencyKey,
  })).digest("hex");
  return `rotating-credit-refund:${fundingId}:${digest}`;
}

function refundQuoteFingerprint(input: {
  organizationId: number;
  leagueId: number;
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
}): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-refund-quote/1",
    ...input,
    currency: "USD",
  })).digest("hex");
  return `lvrotcrrefundquote:v1:${digest}`;
}

type TestRefund = {
  id: string;
  organizationId: number;
  leagueId: number;
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  currency: string;
  refundKind: "cash" | "provider";
  refundOperationId: string | null;
  reference: string | null;
  reason: string;
  actorUserId: number;
  idempotencyKey: string;
  requestFingerprint: string;
  issuedAt: string | null;
  createdAt: string;
};

function transactionFor(input: {
  refund?: TestRefund | null;
  bowlerId: number;
  operation?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  fundingEvidence?: Record<string, unknown>;
  lot?: Record<string, unknown>;
  previousProviderRefunds?: Array<Record<string, unknown>>;
  lockCalls?: Array<{ table: unknown; mode: string; joined: boolean }>;
}) {
  return {
    select: () => {
      let table: unknown;
      const query = {
        from: (source: unknown) => { table = source; return query; },
        innerJoin: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: () => query,
        for: (mode: string) => {
          input.lockCalls?.push({ table, mode, joined: false });
          return Promise.resolve(table === rotatingCreditRefunds
            ? input.refund ? [input.refund] : []
            : table === paymentOperations && input.operation
              ? [input.operation]
              : table === rotatingCreditRefundOperationSnapshots && input.snapshot
                ? [input.snapshot]
                : table === rotatingCreditFundings && input.lot
                  ? [input.lot]
                : []);
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) => Promise.resolve(
          table === rotatingCreditFundings
            ? [input.fundingEvidence ?? { bowlerId: input.bowlerId }]
            : table === rotatingCreditRefunds
              ? input.previousProviderRefunds ?? []
              : [],
        ).then(resolve, reject),
      };
      return query;
    },
  };
}

function emptyBalance(input: { organizationId: number; leagueId: number; bowlerId: number }) {
  return {
    contractVersion: "rotating-credit-balance/1",
    ...input,
    eligibleForCredit: true,
    shareAmountMinor: 1_000,
    currency: "USD",
    fundedMinor: 3_000,
    availableMinor: 1_000,
    appliedMinor: 2_000,
    refundedMinor: 0,
    refundHeldMinor: 0,
    reviewHeldMinor: 0,
    lots: [],
    applications: [],
  };
}

describe("rotating credit refund replay", () => {
  const organizationId = 14;
  const leagueId = 28;
  const bowlerId = 82;
  const actorUserId = 97;
  const fundingId = "b27bb3f2-542f-46ef-8f1d-1908f27ab839";
  const request = {
    fundingId,
    refundKind: "cash" as const,
    quoteFingerprint: `lvrotcrrefundquote:v1:${"a".repeat(64)}`,
    idempotencyKey: "credit-refund-replay-0001",
    reason: "Unused credit returned in cash",
    reference: "Cash drawer receipt 204",
  };
  const refund = {
    id: "43a38880-9ca6-44c2-a0d2-43d6e0dfc2c7",
    organizationId,
    leagueId,
    fundingId,
    paymentId: 501,
    bowlerId,
    amountMinor: 1_000,
    currency: "USD",
    refundKind: "cash" as const,
    refundOperationId: null,
    reference: request.reference,
    reason: request.reason,
    actorUserId,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: requestFingerprint({ organizationId, leagueId, fundingId, actorUserId, request }),
    issuedAt: "2033-03-01T00:00:00.000Z",
    createdAt: "2033-03-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays a staff cash refund while locking only the refund row", async () => {
    const lockCalls: Array<{ table: unknown; mode: string; joined: boolean }> = [];
    const tx = transactionFor({ refund, bowlerId, lockCalls });
    mocks.transaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("transaction callback is required");
      return (callback as (value: unknown) => Promise<unknown>)(tx);
    });
    mocks.readBalance.mockResolvedValue(emptyBalance({ organizationId, leagueId, bowlerId }));

    const result = await recordRotatingCreditRefund({
      organizationId,
      leagueId,
      actorUserId,
      request,
    });

    expect(result.refundId).toBe(refund.id);
    expect(result.amountMinor).toBe(refund.amountMinor);
    expect(mocks.createRefundOperation).not.toHaveBeenCalled();
    expect(mocks.executeRefund).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([{ table: rotatingCreditRefunds, mode: "update", joined: false }]);
  });

  it("replays an exact partial-lot provider refund after the response was lost", async () => {
    const providerRequest = {
      fundingId,
      refundKind: "provider" as const,
      quoteFingerprint: `lvrotcrrefundquote:v1:${"d".repeat(64)}`,
      idempotencyKey: "credit-refund-provider-partial-replay-0001",
      reason: "Return the unused provider credit",
    };
    const semantic = createRotatingCreditRefundSnapshot({
      organizationId,
      leagueId,
      fundingId,
      paymentId: 501,
      bowlerId,
      amountMinor: 1_000,
      currency: "USD",
      providerName: "square",
      providerPaymentId: "square-credit-charge",
      locationId: 73,
      reason: providerRequest.reason,
    });
    const operation = {
      id: "4a35aa2b-13cb-4fde-bec1-15dcc6f86daa",
      organizationId,
      leagueId,
      operationType: "refund",
      targetKey: refundTargetKey(fundingId, providerRequest.idempotencyKey),
      amountMinor: 1_000,
      currency: "USD",
      providerName: "square",
      authorizingUserId: actorUserId,
      status: "succeeded",
      providerObjectId: "square-credit-partial-refund",
    };
    const providerRefund = {
      ...refund,
      amountMinor: 1_000,
      refundKind: "provider" as const,
      refundOperationId: operation.id,
      reference: null,
      reason: providerRequest.reason,
      idempotencyKey: providerRequest.idempotencyKey,
      requestFingerprint: requestFingerprint({ organizationId, leagueId, fundingId, actorUserId, request: providerRequest }),
      issuedAt: null,
    };
    const storedSnapshot = {
      organizationId,
      leagueId,
      fundingId,
      paymentId: providerRefund.paymentId,
      bowlerId,
      amountMinor: providerRefund.amountMinor,
      currency: "USD",
      providerPaymentId: "square-credit-charge",
      locationId: 73,
      reason: providerRequest.reason,
      snapshotFingerprint: semantic.snapshotFingerprint,
    };
    mocks.transaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("transaction callback is required");
      return (callback as (value: unknown) => Promise<unknown>)(transactionFor({
        refund: providerRefund,
        bowlerId,
        operation,
        snapshot: storedSnapshot,
        fundingEvidence: {
          bowlerId,
          fundingKind: "provider",
          paymentId: 501,
          amountMinor: 3_000,
          currency: "USD",
          paymentStatus: "paid",
          paymentAmount: 3_000,
          paymentCurrency: "USD",
          paymentType: "square",
          providerPaymentId: "square-credit-charge",
          locationId: 73,
        },
      }));
    });
    mocks.readBalance.mockResolvedValue(emptyBalance({ organizationId, leagueId, bowlerId }));

    const result = await recordRotatingCreditRefund({
      organizationId,
      leagueId,
      actorUserId,
      request: providerRequest,
    });

    expect(result).toMatchObject({
      refundId: providerRefund.id,
      operationId: operation.id,
      amountMinor: 1_000,
      providerRefundId: operation.providerObjectId,
    });
    expect(mocks.createRefundOperation).not.toHaveBeenCalled();
    expect(mocks.executeRefund).not.toHaveBeenCalled();
  });

  it("rejects provider refund replay when its immutable operation evidence differs", async () => {
    const providerRequest = {
      fundingId,
      refundKind: "provider" as const,
      quoteFingerprint: `lvrotcrrefundquote:v1:${"c".repeat(64)}`,
      idempotencyKey: "credit-refund-provider-replay-0001",
      reason: "Unused provider credit refunded",
    };
    const semantic = createRotatingCreditRefundSnapshot({
      organizationId,
      leagueId,
      fundingId,
      paymentId: 501,
      bowlerId,
      amountMinor: 1_000,
      currency: "USD",
      providerName: "square",
      providerPaymentId: "square-credit-charge",
      locationId: 73,
      reason: providerRequest.reason,
    });
    const operation = {
      id: "2e4ecb94-c8d1-4f42-8b34-96f60029f0f3",
      organizationId,
      leagueId,
      operationType: "refund",
      targetKey: refundTargetKey(fundingId, providerRequest.idempotencyKey),
      amountMinor: 1_000,
      currency: "USD",
      providerName: "square",
      authorizingUserId: actorUserId + 1,
      status: "succeeded",
      providerObjectId: "square-credit-refund",
    };
    const providerRefund = {
      ...refund,
      refundKind: "provider" as const,
      refundOperationId: operation.id,
      reference: null,
      reason: providerRequest.reason,
      idempotencyKey: providerRequest.idempotencyKey,
      requestFingerprint: requestFingerprint({ organizationId, leagueId, fundingId, actorUserId, request: providerRequest }),
      issuedAt: null,
    };
    const storedSnapshot = {
      organizationId,
      leagueId,
      fundingId,
      paymentId: providerRefund.paymentId,
      bowlerId,
      amountMinor: providerRefund.amountMinor,
      currency: "USD",
      providerPaymentId: "square-credit-charge",
      locationId: 73,
      reason: providerRequest.reason,
      snapshotFingerprint: semantic.snapshotFingerprint,
    };
    mocks.transaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("transaction callback is required");
      return (callback as (value: unknown) => Promise<unknown>)(transactionFor({
        refund: providerRefund,
        bowlerId,
        operation,
        snapshot: storedSnapshot,
        fundingEvidence: {
          bowlerId,
          fundingKind: "provider",
          paymentId: 501,
          amountMinor: providerRefund.amountMinor,
          currency: "USD",
          paymentStatus: "paid",
          paymentAmount: providerRefund.amountMinor,
          paymentCurrency: "USD",
          paymentType: "square",
          providerPaymentId: "square-credit-charge",
          locationId: 73,
        },
      }));
    });

    await expect(recordRotatingCreditRefund({
      organizationId,
      leagueId,
      actorUserId,
      request: providerRequest,
    })).rejects.toMatchObject({ code: "REFUND_OPERATION_MISMATCH" });
    expect(mocks.executeRefund).not.toHaveBeenCalled();
    expect(mocks.readBalance).not.toHaveBeenCalled();
  });

  it("does not retry a provider refund after Square confirms a terminal failure", async () => {
    const providerRequest = {
      fundingId,
      refundKind: "provider" as const,
      quoteFingerprint: refundQuoteFingerprint({
        organizationId,
        leagueId,
        fundingId,
        paymentId: 501,
        bowlerId,
        amountMinor: 1_000,
      }),
      idempotencyKey: "credit-refund-provider-retry-0001",
      reason: "Unused provider credit refunded",
    };
    const failedOperation = {
      id: "47af4dd1-d44f-48b0-8ef6-91a4befce272",
      organizationId,
      leagueId,
      operationType: "refund",
      amountMinor: 1_000,
      currency: "USD",
      status: "failed_terminal",
      providerObjectId: "square-refund-failed",
      errorClassification: "invalid_request",
      errorCode: "REFUND_FAILED",
    };
    const lot = {
      funding: { id: fundingId, organizationId, leagueId, bowlerId, paymentId: 501, amountMinor: 3_000, currency: "USD", fundingKind: "provider" },
      payment: { id: 501, organizationId, leagueId, bowlerId, amount: 3_000, currency: "USD", type: "square", status: "paid", providerPaymentId: "square-credit-charge", disputeId: null, disputedAt: null },
      league: { id: leagueId, organizationId, locationId: 73 },
    };
    mocks.transaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("transaction callback is required");
      return (callback as (value: unknown) => Promise<unknown>)(transactionFor({
        refund: null,
        bowlerId,
        lot,
        previousProviderRefunds: [{ operation: failedOperation }],
      }));
    });
    mocks.readFundingBalances.mockResolvedValue([{
      fundingId,
      reviewRequired: false,
      refundHeldMinor: 0,
      availableMinor: 1_000,
    }]);

    await expect(recordRotatingCreditRefund({
      organizationId,
      leagueId,
      actorUserId,
      request: providerRequest,
    })).rejects.toMatchObject({ code: "PROVIDER_REFUND_UNAVAILABLE" });
    expect(mocks.createRefundOperation).not.toHaveBeenCalled();
    expect(mocks.executeRefund).not.toHaveBeenCalled();
  });
});
