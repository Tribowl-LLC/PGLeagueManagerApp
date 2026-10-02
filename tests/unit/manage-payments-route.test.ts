import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
  hasAdmin: vi.fn(),
  hasMembership: vi.fn(),
  configuredOrganization: vi.fn(),
  readSnapshot: vi.fn(),
}));

vi.mock("../../server/utils/access-control.js", () => ({
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasAccessToLeague: vi.fn(),
}));
vi.mock("../../server/middleware/organization.js", () => ({
  hasConfiguredOrganizationMembership: (...args: unknown[]) => mocks.hasMembership(...args),
}));
vi.mock("../../server/services/single-tenant-context.js", () => ({
  configuredOrganizationId: () => mocks.configuredOrganization(),
}));
vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: vi.fn() } }));
vi.mock("../../server/services/manage-payments-worksheet-read.js", () => ({
  ManagePaymentsWorksheetReadError: class extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "ManagePaymentsWorksheetReadError";
    }
  },
  readManagePaymentsWorksheetSnapshot: (...args: unknown[]) => mocks.readSnapshot(...args),
}));

const { default: router } = await import("../../server/routes/manage-payments.js");
const { ManagePaymentsWorksheetReadError } = await import("../../server/services/manage-payments-worksheet-read.js");
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const raw = req.header("x-test-user");
    if (raw) Object.defineProperty(req, "user", { value: JSON.parse(raw), configurable: true });
    const rawOrganizationContext = req.header("x-test-org-context");
    if (rawOrganizationContext) {
      Object.defineProperty(req, "organizationContextId", { value: Number(rawOrganizationContext), configurable: true });
    }
    next();
  });
  app.use("/api/financials", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configuredOrganization.mockReturnValue(12);
  mocks.hasMembership.mockReturnValue(true);
  mocks.hasAdmin.mockResolvedValue(true);
  mocks.readSnapshot.mockResolvedValue({ contractVersion: 1, teams: [] });
});

function user(role: string, organizationId: number | null) {
  return { id: 1, role, organizationId };
}

async function get(path: string, currentUser?: ReturnType<typeof user>, organizationContext?: number) {
  return fetch(`${baseUrl}/api/financials${path}`, {
    headers: {
      ...(currentUser ? { "x-test-user": JSON.stringify(currentUser) } : {}),
      ...(organizationContext === undefined ? {} : { "x-test-org-context": String(organizationContext) }),
    },
  });
}

describe("Manage Payments worksheet read route", () => {
  it("requires authentication and rejects payment managers", async () => {
    const anonymous = await get("/leagues/7/manage-payments/1");
    const manager = await get("/leagues/7/manage-payments/1", user("payment_manager", 12));

    expect(anonymous.status).toBe(401);
    expect(manager.status).toBe(403);
    expect(mocks.hasMembership).not.toHaveBeenCalled();
    expect(mocks.hasAdmin).not.toHaveBeenCalled();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when the resolved business context is absent or mismatched", async () => {
    const absent = await get("/leagues/7/manage-payments/1", user("org_admin", 12));
    const forgedSystemScope = await get("/leagues/7/manage-payments/1?organizationId=99", user("system_admin", null));
    const mismatched = await get("/leagues/7/manage-payments/1", user("org_admin", 12), 99);

    expect(absent.status).toBe(403);
    expect(forgedSystemScope.status).toBe(403);
    expect(mismatched.status).toBe(403);
    expect(mocks.hasMembership).not.toHaveBeenCalled();
    expect(mocks.hasAdmin).not.toHaveBeenCalled();
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("denies cross-organization leagues and does not call the read service", async () => {
    mocks.hasAdmin.mockResolvedValue(false);

    const response = await get("/leagues/7/manage-payments/1", user("org_admin", 12), 12);

    expect(response.status).toBe(404);
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("ignores forged organization query ids and validates canonical week ids", async () => {
    const valid = "b8cc77db-79b5-4515-95c6-5482c56c3835";
    const response = await get(`/leagues/7/manage-payments/1?organizationId=99&occurrenceId=${valid}`, user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; data: { contractVersion: number } };
    const invalid = await get("/leagues/7/manage-payments/1?occurrenceId=not-a-uuid", user("org_admin", 12), 12);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { contractVersion: 1 } });
    expect(mocks.hasMembership).toHaveBeenCalledWith(user("org_admin", 12), 12);
    expect(mocks.readSnapshot).toHaveBeenCalledWith({ organizationId: 12, leagueId: 7, occurrenceId: valid });
    expect(invalid.status).toBe(400);
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns a deliberate safe response until the league ledger has been adopted", async () => {
    mocks.readSnapshot.mockRejectedValue(new ManagePaymentsWorksheetReadError("ledger_not_adopted", "not adopted"));

    const response = await get("/leagues/7/manage-payments/1", user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string } };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false, error: { code: "WEEKLY_PAYMENT_LEDGER_NOT_ADOPTED" } });
  });
});
