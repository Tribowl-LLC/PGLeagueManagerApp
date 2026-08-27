import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
  getLeague: vi.fn(),
  readReport: vi.fn(),
  hasAdmin: vi.fn(),
  hasPaymentManager: vi.fn(),
}));

vi.mock("../../server/storage", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/db.js", () => ({ db: {} }));
vi.mock("../../server/services/canonical-payment-report.js", () => ({
  readCanonicalPaymentReport: (...args: unknown[]) => mocks.readReport(...args),
  CanonicalPaymentReportIncompatibilityError: class extends Error {},
}));
vi.mock("../../server/services/roster-payment-archive-report.js", () => ({
  readCanonicalPaymentReport: (...args: unknown[]) => mocks.readReport(...args),
  CanonicalPaymentReportIncompatibilityError: class extends Error {},
}));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasPaymentManagerAccessToLeague: (...args: unknown[]) => mocks.hasPaymentManager(...args),
  isPaymentManager: (user: { role?: string } | undefined) => user?.role === "payment_manager",
}));

const router = (await import("../../server/routes/financials-f5.js")).default;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const raw = req.header("x-test-user");
    if (raw) Object.defineProperty(req, "user", { value: JSON.parse(raw), configurable: true });
    next();
  });
  app.use("/api/financials/f5", router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 11 });
  mocks.hasAdmin.mockResolvedValue(true);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.readReport.mockResolvedValue({ data: { contractVersion: "canonical-payment-report/1", rows: [] } });
});

function user(role: string, organizationId: number | null, bowlerId: number | null = null) {
  return { id: 1, role, organizationId, bowlerId };
}

async function get(path: string, currentUser?: ReturnType<typeof user>) {
  return fetch(`${baseUrl}/api/financials/f5${path}`, {
    headers: currentUser ? { "x-test-user": JSON.stringify(currentUser) } : {},
  });
}

describe("F5 canonical payment report route", () => {
  it("requires a league and explicit system-admin organization scope", async () => {
    const missingLeague = await get("/payments", user("org_admin", 11));
    expect(missingLeague.status).toBe(400);
    expect((await get("/payments?leagueId=7", user("system_admin", null))).status).toBe(404);
    expect(mocks.readReport).not.toHaveBeenCalled();
  });

  it("keeps ordinary users bound to their own bowler", async () => {
    mocks.hasAdmin.mockResolvedValue(false);
    const response = await get("/payments?leagueId=7&bowlerId=99", user("user", 11, 42));
    expect(response.status).toBe(404);
    expect(mocks.readReport).not.toHaveBeenCalled();
  });

  it("returns stable incompatibility without falling back", async () => {
    class EvidenceError extends Error {}
    mocks.readReport.mockRejectedValue(new EvidenceError());
    const serviceModule = await import("../../server/services/roster-payment-archive-report.js");
    mocks.readReport.mockRejectedValue(new serviceModule.CanonicalPaymentReportIncompatibilityError());
    const response = await get("/payments?leagueId=7", user("org_admin", 11));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("FINANCIAL_EVIDENCE_INCOMPATIBLE");
  });

  it("keeps ordinary combined-participant totals full-scope across report pages", async () => {
    mocks.hasAdmin.mockResolvedValue(false);
    const reportForPage = (page: number) => {
      const row = {
        paymentId: 21,
        leagueId: 7,
        bowlerId: 42,
        amountMinor: 4000,
        currency: "USD",
        status: "confirmed_paid",
        paymentType: "square",
        businessDate: "2038-01-01T00:00:00.000Z",
        authoritativeLocalDate: "2037-12-31",
        providerPaymentId: "provider-secret",
        paymentOperationId: "operation-secret",
        operationType: "standing_autopay_charge",
        operationStatus: "succeeded",
        allocatedMinor: 4000,
        unallocatedMinor: 0,
        reviewRequired: false,
        source: "canonical_allocation",
        refund: { present: false, amountMinor: 0, providerRefundId: null },
        dispute: { present: true, amountMinor: 400, disputeId: "durable-dispute", scope: "transaction", state: "OPEN", reviewRequired: true },
        unresolved: false,
        receipt: { contractVersion: "payment-receipt/1", availability: "available", receiptUrl: "https://secret", receiptNumber: "secret", deliveryEvidence: "delivery_not_recorded", paymentId: 21, paymentOperationId: "operation-secret", source: "canonical_allocation", allocations: [], sharedTransaction: { groupKey: "operation-secret", childCount: 2 } },
        allocations: [
          { allocationId: "a1", obligationId: "ob1", occurrenceId: "occ1", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" },
          { allocationId: "a2", obligationId: "ob2", occurrenceId: "occ2", bowlerId: 43, amountMinor: 2000, currency: "USD", state: "active" },
        ],
      };
      return {
        contractVersion: "canonical-payment-report/1",
        orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1",
        organizationId: 11,
        leagueId: 7,
        mode: "canonical",
        authoritativeSource: "canonical",
        asOf: "2038-01-01T00:00:00.000Z",
        fingerprint: `fingerprint-${page}`,
        page,
        limit: 1,
        totalRows: 4,
        totalTransactions: 3,
        totals: { grossConfirmedPaidMinor: 2000, activeAllocatedMinor: 2000, refundedMinor: 0, disputedReviewRequiredMinor: 400, reviewRequiredMinor: 0, unresolvedOperationMinor: 0, unallocatedLegacyMinor: 0 },
        rows: [row],
        transactions: [{ groupKey: "operation-secret", paymentOperationId: "operation-secret", amountMinor: 4000, currency: "USD", rows: [row] }],
        unlinkedHistory: [],
      };
    };
    mocks.readReport.mockImplementation((input: { page?: number }) => Promise.resolve(reportForPage(input.page ?? 1)));

    const pageOne = await get("/payments?leagueId=7&page=1&limit=1", user("user", 11, 42));
    const pageTwo = await get("/payments?leagueId=7&page=2&limit=1", user("user", 11, 42));
    const firstBody = await pageOne.json();
    const secondBody = await pageTwo.json();
    expect(pageOne.status).toBe(200);
    expect(pageTwo.status).toBe(200);
    expect(firstBody.data.totals).toEqual(secondBody.data.totals);
    expect(firstBody.data.totals).toMatchObject({ grossConfirmedPaidMinor: 2000, activeAllocatedMinor: 2000 });
    expect(firstBody.data.rows[0]).toMatchObject({ amountMinor: 2000, paymentOperationId: null, providerPaymentId: null, allocations: [] });
    expect(firstBody.data.rows[0].sharedTransaction).toBeNull();
    expect(firstBody.data.transactions[0].amountMinor).toBe(2000);
    expect(firstBody.data.totals.disputedReviewRequiredMinor).toBe(400);
  });

  it.each([
    { label: "no-operation shared payment", operationType: null, payer: null },
    { label: "F2 operation", operationType: "interactive_charge", payer: 42 },
    { label: "standing operation", operationType: "standing_autopay_charge", payer: 42 },
  ])("keeps shared refund/dispute totals payer-scoped for $label", async ({ operationType, payer }) => {
    mocks.hasAdmin.mockResolvedValue(false);
    const baseRow = {
      paymentId: operationType === null ? 31 : 32,
      leagueId: 7,
      bowlerId: 42,
      amountMinor: 4000,
      currency: "USD",
      status: "refunded",
      paymentType: "square",
      businessDate: "2038-01-01",
      authoritativeLocalDate: "2038-01-01",
      providerPaymentId: "provider-secret",
      paymentOperationId: operationType === null ? null : `op-${operationType}`,
      operationType,
      operationStatus: "succeeded",
      allocatedMinor: 4000,
      unallocatedMinor: 0,
      reviewRequired: true,
      source: "canonical_allocation",
      refund: { present: true, amountMinor: 4000, providerRefundId: "refund-secret" },
      dispute: { present: true, amountMinor: 4000, disputeId: "dispute-secret", scope: "transaction", state: "OPEN", reviewRequired: true },
      unresolved: false,
      receipt: { contractVersion: "payment-receipt/1", availability: "available", receiptUrl: "https://secret", receiptNumber: "secret", deliveryEvidence: "delivery_not_recorded", paymentId: 31, paymentOperationId: null, source: "canonical_allocation", allocations: [], sharedTransaction: { groupKey: "operation-secret", childCount: 2 } },
      allocations: [
        { allocationId: "a1", obligationId: "ob1", occurrenceId: "occ1", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" },
        { allocationId: "a2", obligationId: "ob2", occurrenceId: "occ2", bowlerId: 43, amountMinor: 2000, currency: "USD", state: "active" },
      ],
      ...(payer === null ? {} : { initiatingPayerBowlerId: payer }),
    };
    const report = (bowlerId: number) => ({
      contractVersion: "canonical-payment-report/1", orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1", organizationId: 11, leagueId: 7, mode: "canonical", authoritativeSource: "canonical", asOf: "2038-01-01T00:00:00.000Z", fingerprint: `fingerprint-${bowlerId}`, page: 1, limit: 50, totalRows: 1, totalTransactions: 1,
      totals: bowlerId === 42 && payer !== null ? { grossConfirmedPaidMinor: 0, activeAllocatedMinor: 2000, refundedMinor: 4000, disputedReviewRequiredMinor: 4000, reviewRequiredMinor: 0, unresolvedOperationMinor: 0, unallocatedLegacyMinor: 0 } : { grossConfirmedPaidMinor: 0, activeAllocatedMinor: 2000, refundedMinor: 0, disputedReviewRequiredMinor: 0, reviewRequiredMinor: 0, unresolvedOperationMinor: 0, unallocatedLegacyMinor: 0 },
      rows: [{ ...baseRow, ...(payer === null ? {} : { initiatingPayerBowlerId: payer }) }], transactions: [], unlinkedHistory: [], paymentTiming: { paymentMode: "weekly", upfrontDueAt: null, source: "canonical_activation" },
    });
    mocks.readReport.mockImplementation((input: { bowlerId?: number }) => Promise.resolve(report(input.bowlerId ?? 42)));
    const partnerResponse = await get("/payments?leagueId=7", user("user", 11, 43));
    expect(partnerResponse.status).toBe(200);
    const partnerBody = await partnerResponse.json();
    expect(partnerBody.data.totals).toMatchObject({ refundedMinor: 0, disputedReviewRequiredMinor: 0 });
    expect(partnerBody.data.rows[0]).toMatchObject({ amountMinor: 2000, sharedTransaction: null, refund: { amountMinor: 0 }, dispute: { amountMinor: 0 } });
    const payerResponse = await get("/payments?leagueId=7", user("user", 11, 42));
    expect(payerResponse.status).toBe(200);
    const payerBody = await payerResponse.json();
    expect(payerBody.data.totals).toMatchObject(payer === null ? { refundedMinor: 0, disputedReviewRequiredMinor: 0 } : { refundedMinor: 4000, disputedReviewRequiredMinor: 4000 });
  });
});
