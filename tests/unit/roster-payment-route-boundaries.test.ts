import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => {
  class MockRosterPaymentError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
  }
  class MockRosterPaymentReplay extends MockRosterPaymentError {
    constructor(public readonly result: unknown) { super("IDEMPOTENCY_REPLAY", "The command was already applied", 200); }
  }
  return {
  getLeague: vi.fn(),
  hasAccess: vi.fn(),
  hasAdmin: vi.fn(),
  hasPaymentManager: vi.fn(),
  canPay: vi.fn(),
  readDue: vi.fn(),
  quote: vi.fn(),
  charge: vi.fn(),
  saveRoster: vi.fn(),
  manual: vi.fn(),
  correct: vi.fn(),
  recoverByRequestKey: vi.fn(),
  RosterPaymentError: MockRosterPaymentError,
  RosterPaymentReplay: MockRosterPaymentReplay,
  };
});

vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/storage", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAccessToLeague: (...args: unknown[]) => mocks.hasAccess(...args),
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasPaymentManagerAccessToLeague: (...args: unknown[]) => mocks.hasPaymentManager(...args),
}));
vi.mock("../../server/utils/bowler-payment-authz.js", () => ({
  canUserPayForBowler: (...args: unknown[]) => mocks.canPay(...args),
}));
vi.mock("../../server/middleware/rate-limit.js", () => ({
  adminWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../server/services/roster-payment-core.js", () => ({
  readRosterPaymentResponsibility: vi.fn(),
  readCanonicalDuePastDue: (...args: unknown[]) => mocks.readDue(...args),
  quoteInteractiveObligations: (...args: unknown[]) => mocks.quote(...args),
  chargeInteractiveObligations: (...args: unknown[]) => mocks.charge(...args),
  saveTeamRoster: (...args: unknown[]) => mocks.saveRoster(...args),
  recordOccurrenceResponsibilities: vi.fn(),
  recordCanonicalManualPayment: (...args: unknown[]) => mocks.manual(...args),
  correctCanonicalAllocation: (...args: unknown[]) => mocks.correct(...args),
  RosterPaymentError: mocks.RosterPaymentError,
  RosterPaymentReplay: mocks.RosterPaymentReplay,
}));
vi.mock("../../server/services/roster-payment-recovery.js", () => ({
  recoverRosterPaymentOperation: vi.fn(),
  recoverRosterPaymentOperationByRequestKey: (...args: unknown[]) => mocks.recoverByRequestKey(...args),
  RosterPaymentRecoveryError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
  },
}));

const router = (await import("../../server/routes/roster-payments.js")).default;
let server: Server;
let baseUrl: string;

function user(role: string, organizationId = 11, bowlerId: number | null = null) {
  return { id: 1, role, organizationId, bowlerId };
}

// Build deterministic, obviously synthetic identities without embedding
// token-shaped literals that secret scanners may mistake for credentials.
const testRequestKey = (label: string): string => `test-${label}-${"x".repeat(16)}`;

async function request(path: string, currentUser: ReturnType<typeof user>, init: RequestInit = {}) {
  return fetch(`${baseUrl}/api/financials${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-user": JSON.stringify(currentUser), ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header("x-test-user");
    if (raw) Object.defineProperty(req, "user", { value: JSON.parse(raw), configurable: true });
    next();
  });
  app.use("/api/financials", router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 11, payingLineupSize: 3 });
  mocks.hasAccess.mockResolvedValue(true);
  mocks.hasAdmin.mockResolvedValue(false);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.canPay.mockResolvedValue({ allowed: true });
  mocks.quote.mockResolvedValue({ contractVersion: "interactive-obligation-quote/2", automaticContractVersion: "automatic-fifo-payment/1", obligations: [{ id: "00000000-0000-4000-8000-000000000001", payerBowlerId: 42 }], amountMinor: 1000, currency: "USD", fingerprint: "quote" });
});

describe("roster payment route authorization", () => {
  it("scopes ordinary due reads to the authenticated bowler", async () => {
    mocks.readDue.mockResolvedValue({ rows: [] });
    const response = await request("/leagues/7/canonical-due-past-due/2", user("user", 11, 42));
    expect(response.status).toBe(200);
    expect(mocks.readDue).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42 });
  });

  it("does not disclose another bowler through due reads or cross-tenant leagues", async () => {
    const otherBowler = await request("/leagues/7/canonical-due-past-due/2?bowlerId=43", user("user", 11, 42));
    expect(otherBowler.status).toBe(404);
    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, payingLineupSize: 3 });
    const crossTenant = await request("/leagues/7/canonical-due-past-due/2", user("user", 11, 42));
    expect(crossTenant.status).toBe(404);
    expect(mocks.readDue).not.toHaveBeenCalled();
  });

  it("requires accepted payer scope for exact obligation quotes", async () => {
    mocks.canPay.mockResolvedValue({ allowed: false });
    const response = await request("/leagues/7/interactive-obligation-quote/2", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ amountMinor: 1000 }),
    });
    expect(response.status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("returns only the automatic FIFO quote summary, never allocation controls", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const response = await request("/leagues/7/interactive-obligation-quote/2", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ amountMinor: 1000, payerBowlerId: 42 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ automaticContractVersion: "automatic-fifo-payment/1", amountMinor: 1000, currency: "USD", fingerprint: "quote" });
    expect(body.data).not.toHaveProperty("obligations");
    expect(body.data).not.toHaveProperty("allocations");
  });

  it("returns a whole-payment correction summary without allocation details", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.correct.mockResolvedValue({
      contractVersion: "canonical-correction/3",
      mode: "void_only",
      payment: { id: 12, bowlerId: 42, leagueId: 7, amount: 1000, currency: "USD", status: "voided", type: "cash" },
      voidEvidence: { id: "void-1", paymentId: 12, reason: "duplicate", recordedAt: "2038-01-01T00:00:00.000Z" },
      voidedAllocations: [{ id: "allocation-1", obligationId: "obligation-1", amountMinor: 1000 }],
      replacement: { payment: { id: 13 }, allocation: { id: "allocation-2" } },
    });
    const response = await request("/leagues/7/canonical/corrections/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, reason: "duplicate", idempotencyKey: "correction-1", requestFingerprint: "quote" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ mode: "void_only", payment: { id: 12, status: "voided" }, voidEvidence: { id: "void-1", paymentId: 12 } });
    expect(body.data).not.toHaveProperty("voidedAllocations");
    expect(body.data).not.toHaveProperty("replacement");
  });

  it("allows location-scoped manual entries but keeps roster and corrections admin-only", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const payload = { commandKey: "roster-1", requestFingerprint: "fp", lineupSize: 3, slots: [{ slotIndex: 0, occupant: "vacant" }, { slotIndex: 1, occupant: "vacant" }, { slotIndex: 2, occupant: "vacant" }] };
    expect((await request("/leagues/7/roster-payment-responsibility/1/teams/9", user("payment_manager"), { method: "POST", body: JSON.stringify(payload) })).status).toBe(404);
    mocks.manual.mockResolvedValue({ records: [] });
    expect((await request("/leagues/7/canonical/manual-record/1", user("payment_manager"), { method: "POST", body: JSON.stringify({ amountMinor: 1000, payerBowlerId: 42, type: "cash", idempotencyKey: "m-1", requestFingerprint: "q" }) })).status).toBe(201);
    expect((await request("/leagues/7/canonical/corrections/1", user("payment_manager"), { method: "POST", body: JSON.stringify({ paymentId: 12, reason: "duplicate", idempotencyKey: "c-1", requestFingerprint: "q" }) })).status).toBe(404);
    expect(mocks.saveRoster).not.toHaveBeenCalled();
    expect(mocks.manual).toHaveBeenCalled();
    expect(mocks.correct).not.toHaveBeenCalled();
  });

  it("keeps payment-manager card charges out of the cash/check-only boundary", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const response = await request("/leagues/7/interactive-obligation-charge/2", user("payment_manager"), {
      method: "POST",
      body: JSON.stringify({
        amountMinor: 1000,
        payerBowlerId: 42,
        sourceId: "card-source",
        sourceKind: "new_card",
        buyerEmail: "payer@example.test",
        storeCard: false,
        idempotencyKey: "payment-manager-card-1",
        requestFingerprint: "q",
      }),
    });
    expect(response.status).toBe(404);
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("quotes a bounded batch with one management request instead of one limiter hit per row", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const rows = Array.from({ length: 31 }, (_, index) => ({
      rowKey: `batch-row-${String(index).padStart(12, "0")}`,
      amountMinor: 1000,
      payerBowlerId: 42 + index,
    }));
    const response = await request("/leagues/7/canonical/manual-record-batch/quote/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ rows }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.contractVersion).toBe("canonical-manual-record-batch-quote/1");
    expect(body.data.rows).toHaveLength(31);
    expect(body.data.rows[0]).toMatchObject({ rowKey: rows[0].rowKey, success: true });
    expect(mocks.quote).toHaveBeenCalledTimes(31);
  });

  it("returns independent mixed outcomes and rejects duplicate row idempotency keys", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.manual.mockImplementation(async (input: { request: { payerBowlerId: number } }) => {
      if (input.request.payerBowlerId === 43) throw new mocks.RosterPaymentError("EXCESS_PAYMENT", "The payment amount exceeds the remaining eligible balance", 422);
      return { contractVersion: "canonical-manual-record/1", records: [] };
    });
    const common = { amountMinor: 1000, type: "cash", requestFingerprint: "quote-fingerprint" };
    const successKey = testRequestKey("success");
    const failureKey = testRequestKey("failure");
    const mixed = await request("/leagues/7/canonical/manual-record-batch/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ rows: [
        { ...common, rowKey: successKey, payerBowlerId: 42, idempotencyKey: successKey },
        { ...common, rowKey: failureKey, payerBowlerId: 43, idempotencyKey: failureKey },
      ] }),
    });
    expect(mixed.status).toBe(200);
    await expect(mixed.json()).resolves.toMatchObject({ data: { rows: [
      { rowKey: successKey, success: true },
      { rowKey: failureKey, success: false, error: { code: "EXCESS_PAYMENT" } },
    ] } });

    const duplicateKey = testRequestKey("duplicate");
    const duplicate = await request("/leagues/7/canonical/manual-record-batch/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ rows: [
        { ...common, rowKey: duplicateKey, payerBowlerId: 42, idempotencyKey: duplicateKey },
        { ...common, rowKey: duplicateKey, payerBowlerId: 43, idempotencyKey: duplicateKey },
      ] }),
    });
    expect(duplicate.status).toBe(400);
    expect(mocks.manual).toHaveBeenCalledTimes(2);
  });

  it("rejects check numbers on cash rows at the batch boundary", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const rowKey = testRequestKey("cash-row");
    const idempotencyKey = testRequestKey("cash-command");
    const response = await request("/leagues/7/canonical/manual-record-batch/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ rows: [{
        rowKey,
        amountMinor: 1000,
        payerBowlerId: 42,
        type: "cash",
        checkNumber: "123",
        idempotencyKey,
        requestFingerprint: "quote-fingerprint",
      }] }),
    });
    expect(response.status).toBe(400);
    expect(mocks.manual).not.toHaveBeenCalled();
  });

  it("rejects duplicate payers even when their row keys are distinct", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const firstKey = testRequestKey("payer-one");
    const secondKey = testRequestKey("payer-two");
    const response = await request("/leagues/7/canonical/manual-record-batch/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ rows: [
        { rowKey: firstKey, amountMinor: 1000, payerBowlerId: 42, type: "cash", idempotencyKey: firstKey, requestFingerprint: "quote-fingerprint" },
        { rowKey: secondKey, amountMinor: 1000, payerBowlerId: 42, type: "cash", idempotencyKey: secondKey, requestFingerprint: "quote-fingerprint" },
      ] }),
    });
    expect(response.status).toBe(400);
    expect(mocks.manual).not.toHaveBeenCalled();
  });

  it("keeps the batch route tenant and league scoped", async () => {
    const response = await request("/leagues/7/canonical/manual-record-batch/quote/1", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ rows: [{ rowKey: testRequestKey("unauthorized"), amountMinor: 1000, payerBowlerId: 42 }] }),
    });
    expect(response.status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("keeps request-key recovery bound to the authenticated league and actor", async () => {
    mocks.recoverByRequestKey.mockResolvedValue({ id: "operation-1", status: "pending" });
    const response = await request("/leagues/7/interactive-obligation-charge/2/recover-by-request-key", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ requestKey: "request-key-123456" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { contractVersion: "interactive-obligation-recovery/1", operationId: "operation-1", status: "pending" } });
    expect(mocks.recoverByRequestKey).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, requestKey: "request-key-123456", actorUserId: 1 });

    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, payingLineupSize: 3 });
    expect((await request("/leagues/7/interactive-obligation-charge/2/recover-by-request-key", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ requestKey: "request-key-123456" }),
    })).status).toBe(404);
    expect(mocks.recoverByRequestKey).toHaveBeenCalledTimes(1);
  });
});
