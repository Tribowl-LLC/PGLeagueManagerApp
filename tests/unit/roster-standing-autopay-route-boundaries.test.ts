import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => {
  class MockStandingAutopayError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
  }
  class MockStandingAutopayReplay extends MockStandingAutopayError {
    constructor(public readonly result: unknown) { super("IDEMPOTENCY_REPLAY", "The command was already applied", 200); }
  }
  return {
    getLeague: vi.fn(),
    hasAccess: vi.fn(),
    quote: vi.fn(),
    paymentWriteLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
    MockStandingAutopayError,
    MockStandingAutopayReplay,
  };
});

vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args) } }));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAccessToLeague: (...args: unknown[]) => mocks.hasAccess(...args),
  hasAdminAccessToLeague: vi.fn(),
  hasPaymentManagerAccessToLeague: vi.fn(),
}));
vi.mock("../../server/middleware/rate-limit.js", () => ({ paymentWriteLimiter: mocks.paymentWriteLimiter }));
vi.mock("../../server/services/roster-standing-autopay.js", () => ({
  activateStandingAutopayConsent: vi.fn(),
  quoteStandingAutopay: (...args: unknown[]) => mocks.quote(...args),
  readStandingAutopayConsent: vi.fn(),
  revokeStandingAutopayConsent: vi.fn(),
  StandingAutopayError: mocks.MockStandingAutopayError,
  StandingAutopayReplay: mocks.MockStandingAutopayReplay,
}));

const router = (await import("../../server/routes/roster-standing-autopay.js")).default;
let server: Server;
let baseUrl: string;

async function request(organizationId: number) {
  return fetch(`${baseUrl}/api/financials/leagues/7/standing-autopay/1/quote`, {
    headers: { "x-test-user": JSON.stringify({ id: 1, role: "user", organizationId, bowlerId: 42 }) },
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
  mocks.getLeague.mockResolvedValue({ id: 7, organizationId: 11 });
  mocks.hasAccess.mockResolvedValue(true);
  mocks.quote.mockResolvedValue({ contractVersion: "standing-autopay-quote/1", cutoffAt: "2030-01-10T00:30:00.000Z" });
});

describe("standing automatic-payment quote read boundary", () => {
  it("serves the authenticated payer quote without consuming the payment-write limiter", async () => {
    const response = await request(11);
    expect(response.status).toBe(200);
    expect(mocks.quote).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7, payerBowlerId: 42 });
    expect(mocks.paymentWriteLimiter).not.toHaveBeenCalled();
  });

  it("does not disclose a quote across tenant boundaries", async () => {
    const response = await request(22);
    expect(response.status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.paymentWriteLimiter).not.toHaveBeenCalled();
  });
});
