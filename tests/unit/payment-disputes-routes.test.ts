import { createServer, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPaymentDisputes: vi.fn(),
  listPaymentDisputeNotifications: vi.fn(),
  listPendingPaymentDisputeEvents: vi.fn(),
  listPaymentDisputeReplayAudits: vi.fn(),
  replayPendingPaymentDisputeEvent: vi.fn(),
}));

vi.mock("../../server/middleware/rate-limit", () => ({
  adminWriteLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../server/storage/payment-dispute-operations", () => ({
  ...mocks,
  DisputeReplayError: class DisputeReplayError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  InvalidDisputeCursorError: class InvalidDisputeCursorError extends Error {},
  isPaymentDisputeState: (value: string) => value === "WON" || value === "EVIDENCE_REQUIRED",
}));

import { requireOrgAdmin } from "../../server/middleware/auth";
import paymentDisputesRouter from "../../server/routes/payment-disputes";

type TestUser = {
  id: number;
  role: "user" | "org_admin" | "system_admin";
  organizationId: number | null;
};

let server: Server;
let baseUrl = "";
let currentUser: TestUser | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      user: currentUser,
      isAuthenticated: () => currentUser !== null,
    });
    next();
  });
  app.use("/api/payment-disputes", requireOrgAdmin, paymentDisputesRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  const empty = { items: [], nextCursor: null };
  mocks.listPaymentDisputes.mockResolvedValue(empty);
  mocks.listPaymentDisputeNotifications.mockResolvedValue(empty);
  mocks.listPendingPaymentDisputeEvents.mockResolvedValue(empty);
  mocks.listPaymentDisputeReplayAudits.mockResolvedValue(empty);
  mocks.replayPendingPaymentDisputeEvent.mockResolvedValue({
    acknowledged: true,
    terminal: true,
    businessStateChanged: true,
    status: "processed",
    code: null,
  });
});

describe("payment dispute operator route tenant boundary", () => {
  it("forces an organization admin to the authenticated tenant", async () => {
    currentUser = { id: 7, role: "org_admin", organizationId: 11 };
    const response = await fetch(`${baseUrl}/api/payment-disputes?organizationId=999&limit=10`);
    expect(response.status).toBe(200);
    expect(mocks.listPaymentDisputes).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 11,
      limit: 10,
    }));
  });

  it("requires a system administrator to select one tenant explicitly", async () => {
    currentUser = { id: 8, role: "system_admin", organizationId: null };
    const missing = await fetch(`${baseUrl}/api/payment-disputes`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      success: false,
      error: { code: "ORGANIZATION_REQUIRED" },
    });
    expect(mocks.listPaymentDisputes).not.toHaveBeenCalled();

    const selected = await fetch(`${baseUrl}/api/payment-disputes?organizationId=22`);
    expect(selected.status).toBe(200);
    expect(mocks.listPaymentDisputes).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 22 }));
  });

  it("denies a non-admin before any dispute storage query", async () => {
    currentUser = { id: 9, role: "user", organizationId: 11 };
    const response = await fetch(`${baseUrl}/api/payment-disputes`);
    expect(response.status).toBe(403);
    expect(mocks.listPaymentDisputes).not.toHaveBeenCalled();
  });

  it("scopes an explicit replay to the operator tenant and actor identity", async () => {
    currentUser = { id: 7, role: "org_admin", organizationId: 11 };
    const eventId = "11111111-1111-4111-8111-111111111111";
    const response = await fetch(`${baseUrl}/api/payment-disputes/pending-events/${eventId}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: 999 }),
    });
    expect(response.status).toBe(200);
    expect(mocks.replayPendingPaymentDisputeEvent).toHaveBeenCalledWith({
      organizationId: 11,
      eventId,
      actor: { userId: 7, role: "org_admin" },
    });
  });
});
