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
    const serviceModule = await import("../../server/services/canonical-payment-report.js");
    mocks.readReport.mockRejectedValue(new serviceModule.CanonicalPaymentReportIncompatibilityError());
    const response = await get("/payments?leagueId=7", user("org_admin", 11));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("FINANCIAL_EVIDENCE_INCOMPATIBLE");
  });
});
