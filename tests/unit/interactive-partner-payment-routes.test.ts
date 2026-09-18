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
    requireOrganizationAccess: vi.fn(),
    canPay: vi.fn(),
    readDue: vi.fn(),
    quote: vi.fn(),
    charge: vi.fn(),
    participants: vi.fn(),
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
  requireOrganizationAccess: (...args: unknown[]) => mocks.requireOrganizationAccess(...args),
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
vi.mock("../../server/services/interactive-partner-payment.js", () => ({
  chargeInteractivePartnerPayments: (...args: unknown[]) => mocks.charge(...args),
  quoteInteractivePartnerPayments: (...args: unknown[]) => mocks.quote(...args),
  readInteractivePaymentParticipants: (...args: unknown[]) => mocks.participants(...args),
}));

const router = (await import("../../server/routes/roster-payments.js")).default;
let server: Server;
let baseUrl: string;

function user(role: string, organizationId = 11, bowlerId: number | null = null) {
  return { id: 1, role, organizationId, bowlerId };
}

function recipient(bowlerId = 42) {
  return { bowlerId, weeks: 1, fullBalance: false };
}

async function request(path: string, currentUser: ReturnType<typeof user> | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (currentUser) headers.set("x-test-user", JSON.stringify(currentUser));
  return fetch(`${baseUrl}/api/financials${path}`, { ...init, headers });
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
  mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 11, paymentMode: "weekly" });
  mocks.hasAccess.mockResolvedValue(true);
  mocks.hasAdmin.mockResolvedValue(false);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.requireOrganizationAccess.mockReturnValue(true);
  mocks.canPay.mockResolvedValue({ allowed: true });
});

describe("interactive partner payment v3 route boundaries", () => {
  it("derives payer and tenant scope from the authenticated request, rejecting client spoof fields", async () => {
    const spoofed = await request("/leagues/7/interactive-payment-quote/3", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ recipients: [recipient()], payerBowlerId: 999, organizationId: 999 }),
    });
    expect(spoofed.status).toBe(400);
    expect(mocks.quote).not.toHaveBeenCalled();

    mocks.quote.mockResolvedValue({
      contractVersion: "interactive-payment-quote/3",
      organizationId: 11,
      leagueId: 7,
      payerBowlerId: 42,
      currency: "USD",
      amountMinor: 1_000,
      fingerprint: "quote-fingerprint",
      recipients: [{ bowlerId: 42, name: "Payer", role: "self", weeks: 1, fullBalance: false, subtotalMinor: 1_000, coveredWeeks: ["Week 1"], allocations: [] }],
      allocations: [],
    });
    const response = await request("/leagues/7/interactive-payment-quote/3", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ recipients: [recipient()] }),
    });
    expect(response.status).toBe(200);
    expect(mocks.quote).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42, recipients: [recipient()] });
  });

  it.each([
    ["unauthenticated", undefined],
    ["unlinked account", user("user", 11, null)],
    ["payment manager", user("payment_manager", 11, 42)],
  ] as const)("denies %s card charges before the partner service", async (_label, currentUser) => {
    const response = await request("/leagues/7/interactive-payment-charge/3", currentUser, {
      method: "POST",
      body: JSON.stringify({
        recipients: [recipient()],
        sourceId: "cnon:route-boundary",
        sourceKind: "new_card",
        idempotencyKey: "route-boundary-charge-key",
        requestFingerprint: "quote-fingerprint",
      }),
    });
    expect(response.status).toBe(404);
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("rejects cross-league and cross-organization access through authorizedLeague", async () => {
    mocks.getLeague.mockResolvedValue({ id: 8, organizationId: 11, paymentMode: "weekly" });
    mocks.hasAccess.mockResolvedValue(false);
    const crossLeague = await request("/leagues/8/interactive-payment-quote/3", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ recipients: [recipient()] }),
    });
    expect(crossLeague.status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();

    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, paymentMode: "weekly" });
    const crossOrganization = await request("/leagues/7/interactive-payment-charge/3", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({
        recipients: [recipient()],
        sourceId: "cnon:route-boundary",
        idempotencyKey: "route-boundary-cross-org",
        requestFingerprint: "quote-fingerprint",
      }),
    });
    expect(crossOrganization.status).toBe(404);
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed or duplicate recipient selections", async () => {
    const invalidBodies = [
      { recipients: [{ bowlerId: 42, weeks: 0, fullBalance: false }] },
      { recipients: [recipient(), recipient()] },
    ];
    for (const body of invalidBodies) {
      const quote = await request("/leagues/7/interactive-payment-quote/3", user("user", 11, 42), { method: "POST", body: JSON.stringify(body) });
      expect(quote.status).toBe(400);
      const charge = await request("/leagues/7/interactive-payment-charge/3", user("user", 11, 42), {
        method: "POST",
        body: JSON.stringify({ ...body, sourceId: "cnon:route-boundary", idempotencyKey: "route-boundary-invalid-key", requestFingerprint: "quote-fingerprint" }),
      });
      expect(charge.status).toBe(400);
    }
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("projects safe quote and charge responses without provider, source, or partner-evidence internals", async () => {
    mocks.quote.mockResolvedValue({
      contractVersion: "interactive-payment-quote/3",
      organizationId: 11,
      leagueId: 7,
      payerBowlerId: 42,
      currency: "USD",
      amountMinor: 2_000,
      fingerprint: "quote-fingerprint",
      sourceId: "cnon:raw-source",
      encryptedSourceId: "ciphertext-source",
      providerPaymentId: "sq-provider-secret",
      partnerEvidence: [{ recipientBowlerId: 43, role: "partner", paymentLinkId: 123, linkFingerprint: "lvpartnerlink:v1:secret" }],
      recipients: [{
        bowlerId: 43,
        name: "Partner",
        role: "partner",
        weeks: 2,
        fullBalance: false,
        subtotalMinor: 2_000,
        coveredWeeks: ["Week 1", "Week 2"],
        allocations: [{ obligationId: "obligation-secret", amountMinor: 2_000, occurrenceId: "occurrence-secret", occurrenceLocalDate: "2039-01-01", plannedOrdinal: 1, label: "Week 1" }],
      }],
      allocations: [{ allocationIndex: 0, bowlerId: 43, amountMinor: 2_000, obligationId: "obligation-secret", responsibilityId: "responsibility-secret", responsibilityVersion: 4, paidByUserId: 1, notes: "secret" }],
    });
    const quoteResponse = await request("/leagues/7/interactive-payment-quote/3", user("user", 11, 42), { method: "POST", body: JSON.stringify({ recipients: [recipient(43)] }) });
    expect(quoteResponse.status).toBe(200);
    const quoteData = (await quoteResponse.json()).data as Record<string, unknown>;
    expect(quoteData).toMatchObject({ contractVersion: "interactive-payment-quote/3", amountMinor: 2_000, fingerprint: "quote-fingerprint" });
    for (const key of ["sourceId", "encryptedSourceId", "providerPaymentId", "partnerEvidence"]) expect(quoteData).not.toHaveProperty(key);
    expect((quoteData.recipients as Array<Record<string, unknown>>)[0]).not.toHaveProperty("linkFingerprint");
    expect((quoteData.allocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("paidByUserId");
    expect((quoteData.allocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("notes");

    mocks.charge.mockResolvedValue({
      contractVersion: "interactive-payment-charge/3",
      organizationId: 11,
      leagueId: 7,
      payerBowlerId: 42,
      currency: "USD",
      amountMinor: 2_000,
      fingerprint: "quote-fingerprint",
      operationId: "operation-secret",
      status: "succeeded",
      providerPaymentId: "sq-provider-secret",
      sourceId: "cnon:raw-source",
      encryptedSourceId: "ciphertext-source",
      partnerEvidence: [{ recipientBowlerId: 43, paymentLinkId: 123, linkFingerprint: "lvpartnerlink:v1:secret" }],
      payment: { id: 12, bowlerId: 42, leagueId: 7, amount: 2_000, providerPaymentId: "sq-provider-secret", sourceId: "cnon:raw-source" },
      allocations: [{ allocationIndex: 0, bowlerId: 43, amountMinor: 2_000, obligationId: "obligation-secret", responsibilityId: "responsibility-secret", paidByUserId: 1, notes: "secret" }],
    });
    const chargeResponse = await request("/leagues/7/interactive-payment-charge/3", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ recipients: [recipient(43)], sourceId: "cnon:route-boundary", idempotencyKey: "route-boundary-safe-key", requestFingerprint: "quote-fingerprint" }),
    });
    expect(chargeResponse.status).toBe(201);
    const chargeData = (await chargeResponse.json()).data as Record<string, unknown>;
    expect(chargeData).toMatchObject({ contractVersion: "interactive-payment-charge/3", operationId: "operation-secret", status: "succeeded" });
    for (const key of ["sourceId", "encryptedSourceId", "providerPaymentId", "partnerEvidence"]) expect(chargeData).not.toHaveProperty(key);
    expect((chargeData.payment as Record<string, unknown>)).not.toHaveProperty("providerPaymentId");
    expect((chargeData.payment as Record<string, unknown>)).not.toHaveProperty("sourceId");
    expect((chargeData.allocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("paidByUserId");
    expect((chargeData.allocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("notes");
  });
});
