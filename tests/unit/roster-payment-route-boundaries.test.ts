import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
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
}));

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
  RosterPaymentError: class extends Error {},
  RosterPaymentReplay: class extends Error {},
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
  mocks.quote.mockResolvedValue({ obligations: [{ id: "00000000-0000-4000-8000-000000000001", payerBowlerId: 42 }], amountMinor: 1000, currency: "USD", fingerprint: "quote" });
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
      body: JSON.stringify({ obligationIds: ["00000000-0000-4000-8000-000000000001"] }),
    });
    expect(response.status).toBe(404);
    expect(mocks.quote).toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("allows location-scoped manual entries but keeps roster and corrections admin-only", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const payload = { commandKey: "roster-1", requestFingerprint: "fp", lineupSize: 3, slots: [{ slotIndex: 0, occupant: "vacant" }, { slotIndex: 1, occupant: "vacant" }, { slotIndex: 2, occupant: "vacant" }] };
    expect((await request("/leagues/7/roster-payment-responsibility/1/teams/9", user("payment_manager"), { method: "POST", body: JSON.stringify(payload) })).status).toBe(404);
    mocks.manual.mockResolvedValue({ records: [] });
    expect((await request("/leagues/7/canonical/manual-record/1", user("payment_manager"), { method: "POST", body: JSON.stringify({ obligationIds: ["00000000-0000-4000-8000-000000000001"], type: "cash", idempotencyKey: "m-1", requestFingerprint: "q" }) })).status).toBe(201);
    expect((await request("/leagues/7/canonical/corrections/1", user("payment_manager"), { method: "POST", body: JSON.stringify({ allocationId: "00000000-0000-4000-8000-000000000001", reason: "duplicate", idempotencyKey: "c-1", requestFingerprint: "q" }) })).status).toBe(404);
    expect(mocks.saveRoster).not.toHaveBeenCalled();
    expect(mocks.manual).toHaveBeenCalled();
    expect(mocks.correct).not.toHaveBeenCalled();
  });

  it("keeps payment-manager card charges out of the cash/check-only boundary", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const response = await request("/leagues/7/interactive-obligation-charge/2", user("payment_manager"), {
      method: "POST",
      body: JSON.stringify({
        obligationIds: ["00000000-0000-4000-8000-000000000001"],
        allocations: [{ obligationId: "00000000-0000-4000-8000-000000000001", amountMinor: 1000 }],
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

  it("keeps request-key recovery bound to the authenticated league and actor", async () => {
    mocks.recoverByRequestKey.mockResolvedValue({ id: "operation-1", status: "succeeded" });
    const response = await request("/leagues/7/interactive-obligation-charge/2/recover-by-request-key", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ requestKey: "request-key-123456" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.recoverByRequestKey).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, requestKey: "request-key-123456", actorUserId: 1 });

    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, payingLineupSize: 3 });
    expect((await request("/leagues/7/interactive-obligation-charge/2/recover-by-request-key", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ requestKey: "request-key-123456" }),
    })).status).toBe(404);
    expect(mocks.recoverByRequestKey).toHaveBeenCalledTimes(1);
  });
});
