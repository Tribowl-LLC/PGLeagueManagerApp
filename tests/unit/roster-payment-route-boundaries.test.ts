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
  captureException: vi.fn(),
  getLeague: vi.fn(),
  hasAccess: vi.fn(),
  hasAdmin: vi.fn(),
  hasPaymentManager: vi.fn(),
  canPay: vi.fn(),
  readDue: vi.fn(),
  quote: vi.fn(),
  quoteManual: vi.fn(),
  charge: vi.fn(),
  readAccountParticipants: vi.fn(),
  quoteAccountFunding: vi.fn(),
  chargeAccountFunding: vi.fn(),
  saveRoster: vi.fn(),
  manual: vi.fn(),
  correct: vi.fn(),
  deleteCash: vi.fn(),
  editCash: vi.fn(),
  repairHistoricalCash: vi.fn(),
  repairHistoricalSquare: vi.fn(),
  recoverByRequestKey: vi.fn(),
  RosterPaymentError: MockRosterPaymentError,
  RosterPaymentReplay: MockRosterPaymentReplay,
  };
});

vi.mock("../../server/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    captureException: (...args: unknown[]) => mocks.captureException(...args),
  }),
}));
vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/storage", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAccessToLeague: (...args: unknown[]) => mocks.hasAccess(...args),
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasPaymentManagerAccessToLeague: (...args: unknown[]) => mocks.hasPaymentManager(...args),
  requireOrganizationAccess: (req: { user?: { role?: string; organizationId?: number | null } }, organizationId: number | null) =>
    organizationId !== null
    && (req.user?.role === "system_admin" || req.user?.organizationId === organizationId),
}));
vi.mock("../../server/utils/bowler-payment-authz.js", () => ({
  canUserPayForBowler: (...args: unknown[]) => mocks.canPay(...args),
}));
vi.mock("../../server/middleware/rate-limit.js", () => ({
  adminWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentQuoteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../server/services/roster-payment-core.js", () => ({
  readRosterPaymentResponsibility: vi.fn(),
  readCanonicalDuePastDue: (...args: unknown[]) => mocks.readDue(...args),
  quoteInteractiveObligations: (...args: unknown[]) => mocks.quote(...args),
  quoteCanonicalManualPayment: (...args: unknown[]) => mocks.quoteManual(...args),
  chargeInteractiveObligations: (...args: unknown[]) => mocks.charge(...args),
  saveTeamRoster: (...args: unknown[]) => mocks.saveRoster(...args),
  recordOccurrenceResponsibilities: vi.fn(),
  recordCanonicalManualPayment: (...args: unknown[]) => mocks.manual(...args),
  correctCanonicalAllocation: (...args: unknown[]) => mocks.correct(...args),
  deleteCanonicalCashPayment: (...args: unknown[]) => mocks.deleteCash(...args),
  editCanonicalCashPayment: (...args: unknown[]) => mocks.editCash(...args),
  repairHistoricalCashPaymentAllocation: (...args: unknown[]) => mocks.repairHistoricalCash(...args),
  RosterPaymentError: mocks.RosterPaymentError,
  RosterPaymentReplay: mocks.RosterPaymentReplay,
}));
vi.mock("../../server/services/account-payment-funding.js", () => ({
  readInteractivePaymentParticipantsV4: (...args: unknown[]) => mocks.readAccountParticipants(...args),
  quoteAccountPaymentFundingV4: (...args: unknown[]) => mocks.quoteAccountFunding(...args),
  chargeAccountPaymentFundingV4: (...args: unknown[]) => mocks.chargeAccountFunding(...args),
}));
vi.mock("../../server/services/interactive-partner-payment.js", () => ({
  chargeInteractivePartnerPayments: vi.fn(),
  quoteInteractivePartnerPayments: vi.fn(),
  readInteractivePaymentParticipants: vi.fn(),
}));
vi.mock("../../server/services/roster-payment-recovery.js", () => ({
  recoverRosterPaymentOperation: vi.fn(),
  recoverRosterPaymentOperationByRequestKey: (...args: unknown[]) => mocks.recoverByRequestKey(...args),
  RosterPaymentRecoveryError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
  },
}));
vi.mock("../../server/services/historical-square-payment-correction.js", () => ({
  correctHistoricalSquarePaymentAllocation: (...args: unknown[]) => mocks.repairHistoricalSquare(...args),
  HistoricalSquareAllocationCorrectionError: mocks.RosterPaymentError,
  HistoricalSquareAllocationCorrectionReplay: mocks.RosterPaymentReplay,
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
  delete process.env.HISTORICAL_PAYMENT_REPAIR_ALLOWLIST;
  mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 11, payingLineupSize: 3 });
  mocks.hasAccess.mockResolvedValue(true);
  mocks.hasAdmin.mockResolvedValue(false);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.canPay.mockResolvedValue({ allowed: true });
  mocks.quote.mockResolvedValue({ contractVersion: "interactive-obligation-quote/2", automaticContractVersion: "automatic-fifo-payment/1", obligations: [{ id: "00000000-0000-4000-8000-000000000001", payerBowlerId: 42 }], amountMinor: 1000, currency: "USD", fingerprint: "quote" });
  mocks.quoteManual.mockResolvedValue({ contractVersion: "canonical-manual-record-quote/1", payerBowlerId: 42, amountMinor: 1000, type: "cash", fingerprint: "manual-quote" });
  mocks.readAccountParticipants.mockResolvedValue({ contractVersion: "interactive-payment-participants/4", payerBowlerId: 42 });
  mocks.quoteAccountFunding.mockResolvedValue({ contractVersion: "account-payment-funding-quote/4", payerBowlerId: 42 });
  mocks.chargeAccountFunding.mockResolvedValue({ contractVersion: "account-payment-funding-charge/4", operationId: "operation-1", status: "succeeded", providerPaymentId: "payment-1" });
});

describe("roster payment route authorization", () => {
  it("captures unexpected failures while returning only the generic roster error", async () => {
    const unexpected = new Error("private provider detail");
    mocks.readDue.mockRejectedValue(unexpected);

    const response = await request("/leagues/7/canonical-due-past-due/2", user("user", 11, 42));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unable to process roster payment evidence" },
    });
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException).toHaveBeenCalledWith(unexpected);
  });

  it("does not capture known roster payment domain errors", async () => {
    mocks.readDue.mockRejectedValue(new mocks.RosterPaymentError("KNOWN_CONFLICT", "Expected conflict", 409));

    const response = await request("/leagues/7/canonical-due-past-due/2", user("user", 11, 42));

    expect(response.status).toBe(409);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("scopes ordinary due reads to the authenticated bowler", async () => {
    mocks.readDue.mockResolvedValue({ rows: [] });
    const response = await request("/leagues/7/canonical-due-past-due/2", user("user", 11, 42));
    expect(response.status).toBe(200);
    expect(mocks.readDue).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42 });
  });

  it("lets an authorized administrator select the payer for V4 checkout", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const admin = user("org_admin", 11);
    const participants = await request("/leagues/7/interactive-payment-participants/4?payerBowlerId=42", admin);
    expect(participants.status).toBe(200);
    expect(mocks.readAccountParticipants).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42 });

    const selection = { payerBowlerId: 42, recipients: [{ bowlerId: 42, selection: { kind: "explicit_amount", amountMinor: 1000 } }] };
    const quote = await request("/leagues/7/interactive-payment-quote/4", admin, { method: "POST", body: JSON.stringify(selection) });
    expect(quote.status).toBe(200);
    expect(mocks.quoteAccountFunding).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42, request: selection });

    const chargeRequest = {
      ...selection,
      sourceId: "synthetic-provider-token",
      sourceKind: "new_card",
      storeCard: false,
      idempotencyKey: testRequestKey("admin-v4-charge"),
      quoteFingerprint: `lvaccountfundquote:v4:${"a".repeat(64)}`,
    };
    const charge = await request("/leagues/7/interactive-payment-charge/4", admin, { method: "POST", body: JSON.stringify(chargeRequest) });
    expect(charge.status).toBe(201);
    expect(mocks.chargeAccountFunding).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, actorUserId: 1, payerBowlerId: 42, request: chargeRequest });
  });

  it("does not allow ordinary users to select a different V4 payer", async () => {
    const ownUser = user("user", 11, 42);
    const selection = { payerBowlerId: 43, recipients: [{ bowlerId: 43, selection: { kind: "explicit_amount", amountMinor: 1000 } }] };
    expect((await request("/leagues/7/interactive-payment-participants/4?payerBowlerId=43", ownUser)).status).toBe(404);
    expect((await request("/leagues/7/interactive-payment-quote/4", ownUser, { method: "POST", body: JSON.stringify(selection) })).status).toBe(404);
    expect((await request("/leagues/7/interactive-payment-charge/4", ownUser, {
      method: "POST",
      body: JSON.stringify({ ...selection, sourceId: "synthetic-provider-token", idempotencyKey: testRequestKey("other-payer"), quoteFingerprint: `lvaccountfundquote:v4:${"b".repeat(64)}` }),
    })).status).toBe(404);
    expect(mocks.readAccountParticipants).not.toHaveBeenCalled();
    expect(mocks.quoteAccountFunding).not.toHaveBeenCalled();
    expect(mocks.chargeAccountFunding).not.toHaveBeenCalled();
  });

  it("requires an administrator to select a payer when their account has no linked bowler", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const admin = user("org_admin", 11);
    expect((await request("/leagues/7/interactive-payment-participants/4", admin)).status).toBe(400);
    expect((await request("/leagues/7/interactive-payment-quote/4", admin, {
      method: "POST",
      body: JSON.stringify({ recipients: [{ bowlerId: 42, selection: { kind: "explicit_amount", amountMinor: 1000 } }] }),
    })).status).toBe(400);
    expect(mocks.readAccountParticipants).not.toHaveBeenCalled();
    expect(mocks.quoteAccountFunding).not.toHaveBeenCalled();
  });

  it("keeps payment managers out of V4 card charge even with a selected payer", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const response = await request("/leagues/7/interactive-payment-charge/4", user("payment_manager", 11), {
      method: "POST",
      body: JSON.stringify({
        payerBowlerId: 42,
        recipients: [{ bowlerId: 42, selection: { kind: "explicit_amount", amountMinor: 1000 } }],
        sourceId: "synthetic-provider-token",
        idempotencyKey: testRequestKey("manager-v4-charge"),
        quoteFingerprint: `lvaccountfundquote:v4:${"c".repeat(64)}`,
      }),
    });
    expect(response.status).toBe(404);
    expect(mocks.chargeAccountFunding).not.toHaveBeenCalled();
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

  it("routes eligible cash edits to the admin-only atomic command", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.editCash.mockResolvedValue({
      contractVersion: "canonical-cash-payment-edit/1",
      mode: "edit_cash",
      originalPaymentId: 12,
      replacementPaymentId: 13,
      oldAmountMinor: 5000,
      newAmountMinor: 6000,
      oldPaymentDate: "2034-09-10",
      newPaymentDate: "2034-09-17",
      allocationMode: "fifo_reapplied",
      allocationCount: 1,
      payment: { id: 13, bowlerId: 42, leagueId: 7, amount: 6000, currency: "USD", status: "paid", type: "cash" },
      voidEvidence: { id: "void-1", paymentId: 12, reason: "cash edit", recordedAt: "2038-01-01T00:00:00.000Z" },
    });
    const response = await request("/leagues/7/canonical/corrections/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, correctionMode: "edit_cash", amountMinor: 6000, paymentDate: "2034-09-17", reason: "cash edit", idempotencyKey: "cash-edit-1", requestFingerprint: "q" }),
    });
    expect(response.status).toBe(201);
    expect(mocks.editCash).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 11, leagueId: 7, actorUserId: 1, request: expect.objectContaining({ correctionMode: "edit_cash", amountMinor: 6000, paymentDate: "2034-09-17" }) }));
    const body = await response.json();
    expect(body.data).toMatchObject({ mode: "edit_cash", originalPaymentId: 12, replacementPaymentId: 13, payment: { id: 13, status: "paid", type: "cash" } });
    expect(body.data).not.toHaveProperty("allocations");
  });

  it("routes supported cash deletions to the admin-only league-scoped command", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.deleteCash.mockResolvedValue({
      contractVersion: "canonical-cash-payment-delete/1",
      deleted: true,
      paymentId: 12,
      paymentType: "cash",
      previousStatus: "voided",
      amountMinor: 5000,
      currency: "USD",
      reason: "duplicate record",
      deletedAllocationCount: 2,
      deletedVoidEvidence: true,
      restoredObligationIds: ["obligation-1", "obligation-2"],
    });
    const response = await request("/leagues/7/canonical/cash-payment-deletions/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, reason: "duplicate record", idempotencyKey: "cash-delete-1", requestFingerprint: "q" }),
    });
    expect(response.status).toBe(201);
    expect(mocks.deleteCash).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 11,
      leagueId: 7,
      actorUserId: 1,
      request: expect.objectContaining({ paymentId: 12, reason: "duplicate record", idempotencyKey: "cash-delete-1" }),
    }));
    expect((await response.json()).data).toMatchObject({
      contractVersion: "canonical-cash-payment-delete/1",
      deleted: true,
      paymentId: 12,
      previousStatus: "voided",
      deletedAllocationCount: 2,
      deletedVoidEvidence: true,
      restoredObligationIds: ["obligation-1", "obligation-2"],
    });
  });

  it.each([
    ["user", false],
    ["payment_manager", true],
  ])("denies %s before invoking the cash deletion command", async (role, paymentManager) => {
    mocks.hasAdmin.mockResolvedValue(false);
    mocks.hasPaymentManager.mockResolvedValue(paymentManager);
    const response = await request("/leagues/7/canonical/cash-payment-deletions/1", user(role, 11, 42), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, reason: "duplicate record", idempotencyKey: `cash-delete-denied-${role}`, requestFingerprint: "q" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.deleteCash).not.toHaveBeenCalled();
  });

  it("rejects malformed cash deletion requests and cross-tenant leagues before the command", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    const invalid = await request("/leagues/7/canonical/cash-payment-deletions/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, reason: "  ", idempotencyKey: "cash-delete-invalid", requestFingerprint: "q" }),
    });
    expect(invalid.status).toBe(400);
    expect(mocks.deleteCash).not.toHaveBeenCalled();

    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, payingLineupSize: 3 });
    const crossTenant = await request("/leagues/7/canonical/cash-payment-deletions/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, reason: "duplicate record", idempotencyKey: "cash-delete-cross-tenant", requestFingerprint: "q" }),
    });
    expect(crossTenant.status).toBe(404);
    expect(mocks.deleteCash).not.toHaveBeenCalled();
  });

  it.each([
    ["user", false],
    ["payment_manager", true],
  ])("denies %s before invoking the cash edit command", async (role, paymentManager) => {
    mocks.hasAdmin.mockResolvedValue(false);
    mocks.hasPaymentManager.mockResolvedValue(paymentManager);
    const response = await request("/leagues/7/canonical/corrections/1", user(role, 11, 42), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, correctionMode: "edit_cash", amountMinor: 6000, paymentDate: "2034-09-17", reason: "cash edit", idempotencyKey: `cash-denied-${role}`, requestFingerprint: "q" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.editCash).not.toHaveBeenCalled();
  });

  it("denies a cross-tenant cash edit before invoking the command", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, payingLineupSize: 3 });
    const response = await request("/leagues/7/canonical/corrections/1", user("admin", 11), {
      method: "POST",
      body: JSON.stringify({ paymentId: 12, correctionMode: "edit_cash", amountMinor: 6000, paymentDate: "2034-09-17", reason: "cash edit", idempotencyKey: "cash-cross-tenant", requestFingerprint: "q" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.editCash).not.toHaveBeenCalled();
  });

  it("allows location-scoped manual entries but keeps roster and corrections admin-only", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const payload = { commandKey: "roster-1", requestFingerprint: "fp", lineupSize: 3, slots: [{ slotIndex: 0, occupant: "vacant" }, { slotIndex: 1, occupant: "vacant" }, { slotIndex: 2, occupant: "vacant" }] };
    expect((await request("/leagues/7/roster-payment-responsibility/1/teams/9", user("payment_manager"), { method: "POST", body: JSON.stringify(payload) })).status).toBe(404);
    mocks.manual.mockResolvedValue({
      contractVersion: "canonical-manual-record/2",
      payment: {
        id: 123,
        bowlerId: 42,
        leagueId: 7,
        amount: 1000,
        currency: "USD",
        createdAt: "2035-09-01T12:00:00.000Z",
        status: "paid",
        type: "cash",
      },
      allocations: [],
      records: [],
    });
    const manualResponse = await request("/leagues/7/canonical/manual-record/1", user("payment_manager"), {
      method: "POST",
      body: JSON.stringify({ amountMinor: 1000, payerBowlerId: 42, type: "cash", idempotencyKey: "m-1", requestFingerprint: "q" }),
    });
    expect(manualResponse.status).toBe(201);
    await expect(manualResponse.json()).resolves.toMatchObject({
      data: {
        contractVersion: "canonical-manual-record/2",
        payment: { id: 123, bowlerId: 42, amount: 1000, status: "paid", type: "cash" },
        records: [],
      },
    });
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

  it("quotes single cash/check receipts against their exact method identity for payment managers", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    mocks.quoteManual.mockResolvedValue({ contractVersion: "canonical-manual-record-quote/1", payerBowlerId: 42, amountMinor: 1000, type: "check", checkNumber: "0042", fingerprint: "manual-quote" });

    const response = await request("/leagues/7/canonical/manual-record/quote/1", user("payment_manager"), {
      method: "POST",
      body: JSON.stringify({ amountMinor: 1000, payerBowlerId: 42, type: "check", checkNumber: " 0042 ", notes: "note" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ type: "check", checkNumber: "0042", fingerprint: "manual-quote" });
    expect(mocks.quoteManual).toHaveBeenCalledWith({
      organizationId: 11,
      leagueId: 7,
      request: { amountMinor: 1000, payerBowlerId: 42, type: "check", checkNumber: "0042", notes: "note" },
    });
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

  it("limits historical cash allocation repair to system administrators", async () => {
    process.env.HISTORICAL_PAYMENT_REPAIR_ALLOWLIST = JSON.stringify({ organizationId: 11, leagueId: 7, paymentAmountsMinor: { 41: 3000 } });
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.repairHistoricalCash.mockResolvedValue({
      contractVersion: "canonical-historical-cash-reallocation/1",
      originalPaymentId: 41,
      replacementPaymentId: 42,
      amountMinor: 3000,
      allocationCount: 1,
      replacementPayment: { providerPaymentId: "must-not-leak" },
    });
    const body = {
      paymentId: 41,
      expectedOldAllocationFingerprint: `lvrepaircashalloc:v1:${"a".repeat(64)}`,
      expectedTargetAllocationFingerprint: `lvrepaircashalloc:v1:${"b".repeat(64)}`,
      targetAllocations: [{ obligationId: "00000000-0000-4000-8000-000000000041", amountMinor: 3000 }],
      reason: "Correct historical advance-payment assignment",
      idempotencyKey: testRequestKey("cash-repair"),
      requestFingerprint: `lvrepaircash:v1:${"c".repeat(64)}`,
    };
    const path = "/leagues/7/canonical/historical-cash-reallocation/1";
    const admin = await request(path, user("admin", 11), { method: "POST", body: JSON.stringify(body) });
    expect(admin.status).toBe(404);
    expect(mocks.repairHistoricalCash).not.toHaveBeenCalled();

    const systemAdmin = await request(path, user("system_admin", 11), { method: "POST", body: JSON.stringify(body) });
    expect(systemAdmin.status).toBe(201);
    const result = await systemAdmin.json();
    expect(result).toMatchObject({ data: {
      originalPaymentId: 41,
      replacementPaymentId: 42,
      amountMinor: 3000,
      allocationCount: 1,
    } });
    expect(result.data.replacementPayment).not.toHaveProperty("providerPaymentId");
    expect(mocks.repairHistoricalCash).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, actorUserId: 1, allowlist: { paymentAmountsMinor: { 41: 3000 } }, request: body });
    expect(mocks.repairHistoricalCash).toHaveBeenCalledTimes(1);

  });

  it("requires the scoped maintenance allowlist for Square allocation repair", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.repairHistoricalSquare.mockResolvedValue({ contractVersion: "historical-square-allocation-correction/1", paymentId: 51, amountMinor: 3000 });
    const body = {
      paymentId: 51,
      expectedOldAllocationFingerprint: `lvsquarealloc:v1:${"a".repeat(64)}`,
      expectedTargetAllocationFingerprint: `lvsquarealloc:v1:${"b".repeat(64)}`,
      targetAllocations: [{ obligationId: "00000000-0000-4000-8000-000000000051", amountMinor: 3000 }],
      reason: "Correct historical advance-payment assignment",
      idempotencyKey: testRequestKey("square-repair"),
      requestFingerprint: `lvsquarecorr:v1:${"c".repeat(64)}`,
    };
    const path = "/leagues/7/canonical/historical-square-reallocation/1";
    expect((await request(path, user("system_admin"), { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
    process.env.HISTORICAL_PAYMENT_REPAIR_ALLOWLIST = JSON.stringify({ organizationId: 11, leagueId: 8, paymentAmountsMinor: { 51: 3000 } });
    expect((await request(path, user("system_admin"), { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
    process.env.HISTORICAL_PAYMENT_REPAIR_ALLOWLIST = JSON.stringify({ organizationId: 11, leagueId: 7, paymentAmountsMinor: { 51: 3000 } });
    expect((await request(path, user("org_admin"), { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
    const response = await request(path, user("system_admin"), { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { amountMinor: 3000 } });
    expect(mocks.repairHistoricalSquare).toHaveBeenCalledTimes(1);
    expect(mocks.repairHistoricalSquare).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, actorUserId: 1, allowlist: { paymentAmountsMinor: { 51: 3000 } }, request: body });
  });
});
