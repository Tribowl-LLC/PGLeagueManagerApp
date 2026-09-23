import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => {
  class MockCreditError extends Error {
    constructor(public readonly code: string, public readonly status = 409) { super("rotating credit error"); }
  }
  class MockRefundError extends Error {
    constructor(public readonly code: string, public readonly status = 409) { super("rotating credit refund error"); }
  }
  return {
    getLeague: vi.fn(),
    getTeam: vi.fn(),
    getBowler: vi.fn(),
    getBowlerLeagues: vi.fn(),
    getOperation: vi.fn(),
    hasAccess: vi.fn(),
    hasAdmin: vi.fn(),
    hasPaymentManager: vi.fn(),
    requireOrganizationAccess: vi.fn(),
    canPay: vi.fn(),
    readBalance: vi.fn(),
    listFundedMembers: vi.fn(),
    quote: vi.fn(),
    charge: vi.fn(),
    manualQuote: vi.fn(),
    manualRecord: vi.fn(),
    refundQuote: vi.fn(),
    refundRecord: vi.fn(),
    recoverByKey: vi.fn(),
    recoverById: vi.fn(),
    CreditError: MockCreditError,
    RefundError: MockRefundError,
  };
});

vi.mock("../../server/storage/index.js", () => ({ storage: {
  getLeague: (...args: unknown[]) => mocks.getLeague(...args),
  getTeam: (...args: unknown[]) => mocks.getTeam(...args),
  getBowler: (...args: unknown[]) => mocks.getBowler(...args),
  getBowlerLeagues: (...args: unknown[]) => mocks.getBowlerLeagues(...args),
  getPaymentOperationForOrganization: (...args: unknown[]) => mocks.getOperation(...args),
} }));
vi.mock("../../server/storage", () => ({ storage: {
  getLeague: (...args: unknown[]) => mocks.getLeague(...args),
  getTeam: (...args: unknown[]) => mocks.getTeam(...args),
  getBowler: (...args: unknown[]) => mocks.getBowler(...args),
  getBowlerLeagues: (...args: unknown[]) => mocks.getBowlerLeagues(...args),
  getPaymentOperationForOrganization: (...args: unknown[]) => mocks.getOperation(...args),
} }));
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
vi.mock("../../server/services/rotating-credit.js", () => ({
  RotatingCreditError: mocks.CreditError,
  readRotatingCreditBalance: (...args: unknown[]) => mocks.readBalance(...args),
  listRotatingCreditFundedMembersForTeam: (...args: unknown[]) => mocks.listFundedMembers(...args),
  quoteRotatingCreditPurchase: (...args: unknown[]) => mocks.quote(...args),
  chargeRotatingCreditPurchase: (...args: unknown[]) => mocks.charge(...args),
  quoteRotatingCreditManualFunding: (...args: unknown[]) => mocks.manualQuote(...args),
  recordRotatingCreditManualFunding: (...args: unknown[]) => mocks.manualRecord(...args),
  recoverRotatingCreditChargeByRequestKey: (...args: unknown[]) => mocks.recoverByKey(...args),
  recoverRotatingCreditChargeOperation: (...args: unknown[]) => mocks.recoverById(...args),
}));
vi.mock("../../server/services/rotating-credit-refund.js", () => ({
  RotatingCreditRefundError: mocks.RefundError,
  quoteRotatingCreditRefund: (...args: unknown[]) => mocks.refundQuote(...args),
  recordRotatingCreditRefund: (...args: unknown[]) => mocks.refundRecord(...args),
}));

const router = (await import("../../server/routes/rotating-credit.js")).default;
let server: Server;
let baseUrl: string;

function user(role: string, organizationId = 11, bowlerId: number | null = 42) {
  return { id: 7, role, organizationId, bowlerId };
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
  mocks.getTeam.mockResolvedValue({ id: 14, leagueId: 7 });
  mocks.getBowler.mockResolvedValue({ id: 42, organizationId: 11 });
  mocks.getBowlerLeagues.mockResolvedValue([{ bowlerId: 42, leagueId: 7, active: true }]);
  mocks.listFundedMembers.mockResolvedValue([]);
  mocks.getOperation.mockResolvedValue(undefined);
  mocks.hasAccess.mockResolvedValue(true);
  mocks.hasAdmin.mockResolvedValue(false);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.requireOrganizationAccess.mockImplementation((req: { user?: { organizationId?: number } }, organizationId: number) => req.user?.organizationId === organizationId);
  mocks.canPay.mockResolvedValue({ allowed: true });
});

describe("rotating credit route authorization", () => {
  it("denies a foreign organization before reading or quoting personal credit", async () => {
    mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 22, paymentMode: "weekly" });
    const response = await request("/leagues/7/rotating-credit/1", user("user", 11, 42));
    expect(response.status).toBe(404);
    expect(mocks.readBalance).not.toHaveBeenCalled();
  });

  it("denies a user who cannot pay for the authenticated bowler", async () => {
    mocks.canPay.mockResolvedValue({ allowed: false, reason: "not_linked" });
    const response = await request("/leagues/7/rotating-credit/quote/1", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ shareCount: 1 }),
    });
    expect(response.status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("allows a payment manager to self-pay when linked to an eligible bowler", async () => {
    mocks.quote.mockResolvedValue({ contractVersion: "rotating-credit-quote/1" });
    const response = await request("/leagues/7/rotating-credit/quote/1", user("payment_manager", 11, 42), {
      method: "POST",
      body: JSON.stringify({ shareCount: 1 }),
    });
    expect(response.status).toBe(200);
    expect(mocks.canPay).toHaveBeenCalledWith(expect.anything(), 42);
    expect(mocks.quote).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, bowlerId: 42, shareCount: 1 });
  });

  it("does not accept a client-selected bowler for self-service credit", async () => {
    const response = await request("/leagues/7/rotating-credit/quote/1", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ shareCount: 1, bowlerId: 99 }),
    });
    expect(response.status).toBe(400);
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("returns an eligibility denial for an unassigned member instead of creating credit", async () => {
    mocks.quote.mockRejectedValue(new mocks.CreditError("ROTATING_CREDIT_NOT_ELIGIBLE", 403));
    const response = await request("/leagues/7/rotating-credit/quote/1", user("user", 11, 42), {
      method: "POST",
      body: JSON.stringify({ shareCount: 1 }),
    });
    expect(response.status).toBe(403);
    expect(mocks.quote).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, bowlerId: 42, shareCount: 1 });
  });

  it("limits operation recovery to the authorizing user and tenant", async () => {
    mocks.getOperation.mockResolvedValue({ id: "f39b793e-63cd-4db7-befd-5c24c88bcb56", leagueId: 7, authorizingUserId: 8 });
    const response = await request("/leagues/7/rotating-credit/operations/f39b793e-63cd-4db7-befd-5c24c88bcb56/recover/1", user("user", 11, 42), { method: "POST" });
    expect(response.status).toBe(404);
    expect(mocks.recoverById).not.toHaveBeenCalled();
  });

  it("restricts the staff balance endpoint to managers authorized for the league", async () => {
    const response = await request("/leagues/7/rotating-credit/admin/42/1", user("payment_manager", 11, null));
    expect(response.status).toBe(404);
    expect(mocks.getBowler).not.toHaveBeenCalled();
    expect(mocks.readBalance).not.toHaveBeenCalled();
  });

  it("does not expose a balance for a bowler owned by another organization", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.getBowler.mockResolvedValue({ id: 42, organizationId: 22 });
    const response = await request("/leagues/7/rotating-credit/admin/42/1", user("org_admin", 11, null));
    expect(response.status).toBe(404);
    expect(mocks.getBowlerLeagues).not.toHaveBeenCalled();
    expect(mocks.readBalance).not.toHaveBeenCalled();
  });

  it("allows staff to read a former member's scoped funded balance", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    mocks.getBowlerLeagues.mockResolvedValue([]);
    mocks.readBalance.mockResolvedValue({
      contractVersion: "rotating-credit-balance/1",
      organizationId: 11,
      leagueId: 7,
      bowlerId: 42,
      eligibleForCredit: false,
      shareAmountMinor: null,
      currency: "USD",
      fundedMinor: 2_500,
      availableMinor: 2_500,
      appliedMinor: 0,
      refundedMinor: 0,
      refundHeldMinor: 0,
      reviewHeldMinor: 0,
      lots: [{ fundingId: "b27bb3f2-542f-46ef-8f1d-1908f27ab839" }],
      applications: [],
    });
    const response = await request("/leagues/7/rotating-credit/admin/42/1", user("payment_manager", 11, null));
    expect(response.status).toBe(200);
    expect(mocks.readBalance).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, bowlerId: 42 });
    expect((await response.json()).data.eligibleForCredit).toBe(false);
  });

  it("lists only same-team funded rotation history for authorized staff", async () => {
    mocks.hasPaymentManager.mockResolvedValue(true);
    const members = [{ bowlerId: 42, name: "Former Member", activeRotationMember: false }];
    mocks.listFundedMembers.mockResolvedValue(members);
    const response = await request("/leagues/7/rotating-credit/admin/teams/14/members/1", user("payment_manager", 11, null));
    expect(response.status).toBe(200);
    expect(mocks.listFundedMembers).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, teamId: 14 });
    expect((await response.json()).data.members).toEqual(members);
  });

  it("rejects a team that is not in the authorized league", async () => {
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.getTeam.mockResolvedValue({ id: 14, leagueId: 8 });
    const response = await request("/leagues/7/rotating-credit/admin/teams/14/members/1", user("org_admin", 11, null));
    expect(response.status).toBe(404);
    expect(mocks.listFundedMembers).not.toHaveBeenCalled();
  });
});
