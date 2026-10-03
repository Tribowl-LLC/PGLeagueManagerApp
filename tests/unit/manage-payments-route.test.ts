import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
  hasAdmin: vi.fn(),
  hasMembership: vi.fn(),
  configuredOrganization: vi.fn(),
  readSnapshot: vi.fn(),
  readSeasonSnapshot: vi.fn(),
  saveWorksheet: vi.fn(),
  adminWriteLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("../../server/utils/access-control.js", () => ({
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasAccessToLeague: vi.fn(),
}));
vi.mock("../../server/middleware/organization.js", () => ({
  hasConfiguredOrganizationMembership: (...args: unknown[]) => mocks.hasMembership(...args),
}));
vi.mock("../../server/middleware/rate-limit.js", () => ({
  adminWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => mocks.adminWriteLimiter(_req, _res, next),
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
  isManagePaymentsWorksheetReadAborted: (error: unknown) => error instanceof Error && error.name === "ManagePaymentsWorksheetReadAborted",
  readManagePaymentsSeasonSnapshot: (...args: unknown[]) => mocks.readSeasonSnapshot(...args),
  readManagePaymentsWorksheetSnapshot: (...args: unknown[]) => mocks.readSnapshot(...args),
}));
vi.mock("../../server/services/manage-payments-worksheet-write.js", () => ({
  ManagePaymentsWorksheetWriteError: class extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "ManagePaymentsWorksheetWriteError";
    }
  },
  saveManagePaymentsWorksheet: (...args: unknown[]) => mocks.saveWorksheet(...args),
}));

const { default: router } = await import("../../server/routes/manage-payments.js");
const { ManagePaymentsWorksheetReadError } = await import("../../server/services/manage-payments-worksheet-read.js");
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
  mocks.readSeasonSnapshot.mockResolvedValue({ contractVersion: 1, snapshotsByOccurrence: {} });
  mocks.saveWorksheet.mockResolvedValue({ snapshot: { contractVersion: 1, teams: [] }, replayed: false });
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

async function post(path: string, body: unknown, currentUser?: ReturnType<typeof user>, organizationContext?: number) {
  return fetch(`${baseUrl}/api/financials${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(currentUser ? { "x-test-user": JSON.stringify(currentUser) } : {}),
      ...(organizationContext === undefined ? {} : { "x-test-org-context": String(organizationContext) }),
    },
    body: JSON.stringify(body),
  });
}

const saveRequest = {
  occurrenceId: "5f9e975a-6c9b-4c75-aa42-4a44a36ae013",
  expectedRevision: 0,
  expectedStateFingerprint: `lvmanagepayments:v1:${"a".repeat(64)}`,
  idempotencyKey: "weekly-save-key-0001",
  changedRows: [],
};

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
    const readInput = mocks.readSnapshot.mock.calls[0]?.[0] as { organizationId: number; leagueId: number; occurrenceId: string; signal: AbortSignal };
    expect(readInput).toMatchObject({ organizationId: 12, leagueId: 7, occurrenceId: valid });
    expect(readInput.signal).toBeInstanceOf(AbortSignal);
    expect(invalid.status).toBe(400);
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("signals the worksheet reader when an in-flight GET is abandoned", async () => {
    let readSignal: AbortSignal | undefined;
    mocks.readSnapshot.mockImplementation((input: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      readSignal = input.signal;
      const rejectAborted = () => reject(Object.assign(new Error("aborted"), { name: "ManagePaymentsWorksheetReadAborted" }));
      if (input.signal.aborted) rejectAborted();
      else input.signal.addEventListener("abort", rejectAborted, { once: true });
    }));
    const requestController = new AbortController();
    const pendingResponse = fetch(`${baseUrl}/api/financials/leagues/7/manage-payments/1`, {
      signal: requestController.signal,
      headers: {
        "x-test-user": JSON.stringify(user("org_admin", 12)),
        "x-test-org-context": "12",
      },
    });
    await vi.waitFor(() => expect(readSignal).toBeInstanceOf(AbortSignal));

    requestController.abort();

    await expect(pendingResponse).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
  });

  it("returns a deliberate safe response until the league ledger has been adopted", async () => {
    mocks.readSnapshot.mockRejectedValue(new ManagePaymentsWorksheetReadError("ledger_not_adopted", "not adopted"));

    const response = await get("/leagues/7/manage-payments/1", user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string } };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false, error: { code: "WEEKLY_PAYMENT_LEDGER_NOT_ADOPTED" } });
  });
});

describe("Manage Payments season read route", () => {
  it("requires configured organization admin access and hides foreign leagues", async () => {
    const anonymous = await get("/leagues/7/manage-payments/1/season");
    const manager = await get("/leagues/7/manage-payments/1/season", user("payment_manager", 12), 12);
    const mismatched = await get("/leagues/7/manage-payments/1/season", user("org_admin", 12), 99);
    mocks.hasAdmin.mockResolvedValue(false);
    const foreign = await get("/leagues/7/manage-payments/1/season", user("org_admin", 12), 12);

    expect(anonymous.status).toBe(401);
    expect(manager.status).toBe(403);
    expect(mismatched.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(mocks.readSeasonSnapshot).not.toHaveBeenCalled();
  });

  it("loads the complete season once with the resolved organization and an abort signal", async () => {
    const response = await get("/leagues/7/manage-payments/1/season?organizationId=99", user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; data: { contractVersion: number } };
    const readInput = mocks.readSeasonSnapshot.mock.calls[0]?.[0] as { organizationId: number; leagueId: number; signal: AbortSignal };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { contractVersion: 1 } });
    expect(mocks.readSeasonSnapshot).toHaveBeenCalledTimes(1);
    expect(readInput).toMatchObject({ organizationId: 12, leagueId: 7 });
    expect(readInput.signal).toBeInstanceOf(AbortSignal);
  });

  it("signals the season reader when an in-flight request is abandoned", async () => {
    let readSignal: AbortSignal | undefined;
    mocks.readSeasonSnapshot.mockImplementation((input: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      readSignal = input.signal;
      const rejectAborted = () => reject(Object.assign(new Error("aborted"), { name: "ManagePaymentsWorksheetReadAborted" }));
      if (input.signal.aborted) rejectAborted();
      else input.signal.addEventListener("abort", rejectAborted, { once: true });
    }));
    const requestController = new AbortController();
    const pendingResponse = fetch(`${baseUrl}/api/financials/leagues/7/manage-payments/1/season`, {
      signal: requestController.signal,
      headers: {
        "x-test-user": JSON.stringify(user("org_admin", 12)),
        "x-test-org-context": "12",
      },
    });
    await vi.waitFor(() => expect(readSignal).toBeInstanceOf(AbortSignal));

    requestController.abort();

    await expect(pendingResponse).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
  });
});

describe("Manage Payments worksheet save route", () => {
  it("allows an organization administrator to confirm a week with no row edits", async () => {
    const response = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);

    expect(response.status).toBe(200);
    expect(mocks.saveWorksheet).toHaveBeenCalledWith({
      organizationId: 12,
      leagueId: 7,
      actorUserId: 1,
      request: saveRequest,
    });
    expect(mocks.adminWriteLimiter).toHaveBeenCalledTimes(1);
  });

  it("denies payment managers and forged organization context before write", async () => {
    const manager = await post("/leagues/7/manage-payments/1", saveRequest, user("payment_manager", 12), 12);
    const forgedSystemScope = await post("/leagues/7/manage-payments/1?organizationId=99", saveRequest, user("system_admin", null), 99);

    expect(manager.status).toBe(403);
    expect(forgedSystemScope.status).toBe(403);
    expect(mocks.saveWorksheet).not.toHaveBeenCalled();
  });

  it("rejects malformed save payloads before calling the writer", async () => {
    const response = await post("/leagues/7/manage-payments/1", { ...saveRequest, expectedRevision: -1 }, user("org_admin", 12), 12);

    expect(response.status).toBe(400);
    expect(mocks.saveWorksheet).not.toHaveBeenCalled();
  });
});
