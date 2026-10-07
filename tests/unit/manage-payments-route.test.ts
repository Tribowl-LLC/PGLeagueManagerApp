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
  captureException: vi.fn(),
  logError: vi.fn(),
  adminWriteLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("../../server/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mocks.logError(...args),
    debug: vi.fn(),
    captureException: (...args: unknown[]) => mocks.captureException(...args),
  }),
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
const { ManagePaymentsWorksheetWriteError } = await import("../../server/services/manage-payments-worksheet-write.js");
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
  mocks.captureException.mockReset();
  mocks.logError.mockReset();
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

  it("captures unexpected wrapped database errors without exposing SQL or request details", async () => {
    const wrapped = Object.assign(new Error("Failed query: UPDATE payments SET amount = 27000 WHERE id = 20429; params: private@example.test"), {
      name: "DrizzleQueryError",
    });
    wrapped.cause = Object.assign(new Error("LV_WEEKLY_LEDGER_INVARIANT: funding_application_identity"), {
      name: "DatabaseError",
      code: "PWL01",
      constraint: "owned_payment_funding_ledger_guard",
    });
    mocks.saveWorksheet.mockRejectedValue(wrapped);

    const response = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string; message: string } };
    const reported = mocks.captureException.mock.calls[0]?.[0] as Error;
    const diagnosticOutput = `${reported?.message}\n${reported?.stack}\n${JSON.stringify(mocks.logError.mock.calls)}\n${JSON.stringify(body)}`;

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unable to save weekly payments" },
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(reported).toBeInstanceOf(Error);
    expect(reported.name).toBe("ManagePaymentsSaveError");
    expect(reported.message).toBe("Unexpected weekly payment worksheet save failure");
    expect(reported.cause).toBeUndefined();
    expect(diagnosticOutput).not.toContain("Failed query:");
    expect(diagnosticOutput).not.toContain("private@example.test");
    expect(diagnosticOutput).not.toContain("27000");
    expect(diagnosticOutput).not.toContain("20429");
    expect(mocks.logError).toHaveBeenCalledWith("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: "PWL01",
      errorConstraint: "owned_payment_funding_ledger_guard",
      errorKind: "DrizzleQueryError",
      invariant: "funding_application_identity",
    });
  });

  it("bounds diagnostic traversal when each cause access creates a fresh object", async () => {
    let causeReads = 0;
    const makeFreshCause = (): object => {
      const next = {};
      Object.defineProperty(next, "cause", {
        get: () => {
          causeReads += 1;
          if (causeReads > 64) throw new Error("diagnostic traversal did not stop");
          return makeFreshCause();
        },
      });
      return next;
    };
    const wrapped = Object.assign(new Error("private failure detail"), {
      name: "DatabaseError",
      code: "PWL01",
      constraint: "owned_payment_funding_ledger_guard",
    });
    Object.defineProperty(wrapped, "cause", { get: makeFreshCause });
    mocks.saveWorksheet.mockRejectedValue(wrapped);

    const response = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unable to save weekly payments" },
    });
    expect(causeReads).toBeLessThan(32);
    expect(mocks.logError).toHaveBeenCalledWith("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: "PWL01",
      errorConstraint: "owned_payment_funding_ledger_guard",
      errorKind: "DatabaseError",
      invariant: "unknown",
    });
  });

  it("does not read a cause beyond the diagnostic depth limit", async () => {
    const chain = Array.from({ length: 40 }, (_, index) => {
      const entry: Record<string, unknown> = {};
      if (index === 0) Object.assign(entry, { name: "PostgresError", message: "private failure detail" });
      if (index === 32) Object.assign(entry, { code: "PWL01", constraint: "owned_payment_funding_ledger_guard" });
      return entry;
    });
    let causeReads = 0;
    chain.forEach((entry, index) => {
      Object.defineProperty(entry, "cause", {
        get: () => {
          causeReads += 1;
          return chain[index + 1];
        },
      });
    });
    const rootCause = chain[0];
    if (rootCause === undefined) throw new Error("Expected a synthetic error chain root");
    mocks.saveWorksheet.mockRejectedValue(rootCause);

    const response = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unable to save weekly payments" },
    });
    expect(causeReads).toBe(31);
    expect(mocks.logError).toHaveBeenCalledWith("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: "unknown",
      errorConstraint: "unknown",
      errorKind: "PostgresError",
      invariant: "unknown",
    });
  });

  it("omits malformed database diagnostics and keeps handled conflicts out of error reporting", async () => {
    const malformedInvariant = Object.assign(new Error("LV_WEEKLY_LEDGER_INVARIANT: invalid_token with extra detail"), {
      name: "ZodError",
      code: "PWL01; SELECT secret",
      constraint: "bad constraint with details",
    });
    malformedInvariant.cause = malformedInvariant;
    mocks.saveWorksheet.mockRejectedValueOnce(malformedInvariant);

    const unexpected = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const unexpectedBody = await unexpected.json() as { error: { message: string } };

    expect(unexpected.status).toBe(500);
    expect(unexpectedBody.error.message).toBe("Unable to save weekly payments");
    expect(mocks.logError).toHaveBeenCalledWith("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: "unknown",
      errorConstraint: "unknown",
      errorKind: "ZodError",
      invariant: "unknown",
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("invalid_token");

    mocks.captureException.mockClear();
    mocks.logError.mockClear();
    const inaccessible = new Error();
    Object.defineProperties(inaccessible, {
      name: { get: () => { throw new Error("raw name getter detail"); } },
      message: { get: () => { throw new Error("raw message getter detail"); } },
      code: { get: () => { throw new Error("raw code getter detail"); } },
      constraint: { get: () => { throw new Error("raw constraint getter detail"); } },
      cause: { get: () => { throw new Error("raw cause getter detail"); } },
    });
    mocks.saveWorksheet.mockRejectedValueOnce(inaccessible);

    const inaccessibleFailure = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);

    expect(inaccessibleFailure.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: "unknown",
      errorConstraint: "unknown",
      errorKind: "unknown",
      invariant: "unknown",
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("getter detail");

    mocks.captureException.mockClear();
    mocks.logError.mockClear();
    mocks.saveWorksheet.mockRejectedValueOnce(new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "Receipt changed"));

    const conflict = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const conflictBody = await conflict.json() as { error: { code: string } };

    expect(conflict.status).toBe(409);
    expect(conflictBody.error.code).toBe("MANUAL_RECEIPT_CONFLICT");
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("preserves the generic 500 response if server error reporting itself throws", async () => {
    mocks.saveWorksheet.mockRejectedValue(new Error("secret raw exception"));
    mocks.captureException.mockImplementation(() => { throw new Error("reporter failure"); });
    mocks.logError.mockImplementation(() => { throw new Error("logger failure"); });

    const response = await post("/leagues/7/manage-payments/1", saveRequest, user("org_admin", 12), 12);
    const body = await response.json() as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unable to save weekly payments" },
    });
  });
});
