import { createServer, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acknowledgePaymentDispute: vi.fn(),
  countUnacknowledgedPaymentDisputes: vi.fn(),
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
  DisputeAcknowledgementError: class DisputeAcknowledgementError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
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
  mocks.countUnacknowledgedPaymentDisputes.mockResolvedValue(0);
  mocks.acknowledgePaymentDispute.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    paymentDisputeId: "11111111-1111-4111-8111-111111111111",
    providerVersion: 3,
    acknowledgedByUserId: 7,
    acknowledgedByRole: "org_admin",
    acknowledgedAt: "2034-03-08T00:00:00.000Z",
    created: true,
  });
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

  it("counts only within the authenticated organization context", async () => {
    currentUser = { id: 7, role: "org_admin", organizationId: 11 };
    mocks.countUnacknowledgedPaymentDisputes.mockResolvedValue(4);
    const response = await fetch(`${baseUrl}/api/payment-disputes/unacknowledged-count?organizationId=999`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { count: 4 } });
    expect(mocks.countUnacknowledgedPaymentDisputes).toHaveBeenCalledWith(11);
  });

  it("acknowledges an exact dispute version in the authenticated tenant", async () => {
    currentUser = { id: 7, role: "org_admin", organizationId: 11 };
    const disputeId = "11111111-1111-4111-8111-111111111111";
    const response = await fetch(`${baseUrl}/api/payment-disputes/${disputeId}/acknowledgements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: 999, providerVersion: 3 }),
    });
    expect(response.status).toBe(200);
    expect(mocks.acknowledgePaymentDispute).toHaveBeenCalledWith({
      organizationId: 11,
      paymentDisputeId: disputeId,
      providerVersion: 3,
      actor: { userId: 7, role: "org_admin" },
    });
  });

  it("requires explicit tenant selection for system-admin acknowledgement", async () => {
    currentUser = { id: 8, role: "system_admin", organizationId: null };
    const disputeId = "11111111-1111-4111-8111-111111111111";
    const missing = await fetch(`${baseUrl}/api/payment-disputes/${disputeId}/acknowledgements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerVersion: 3 }),
    });
    expect(missing.status).toBe(400);
    expect(mocks.acknowledgePaymentDispute).not.toHaveBeenCalled();

    const selected = await fetch(`${baseUrl}/api/payment-disputes/${disputeId}/acknowledgements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: 22, providerVersion: 3 }),
    });
    expect(selected.status).toBe(200);
    expect(mocks.acknowledgePaymentDispute).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 22,
      actor: { userId: 8, role: "system_admin" },
    }));
  });

  it("returns a stale-version conflict without weakening the tenant boundary", async () => {
    const { DisputeAcknowledgementError } = await import("../../server/storage/payment-dispute-operations");
    currentUser = { id: 7, role: "org_admin", organizationId: 11 };
    mocks.acknowledgePaymentDispute.mockRejectedValue(
      new DisputeAcknowledgementError("DISPUTE_VERSION_CHANGED"),
    );
    const response = await fetch(
      `${baseUrl}/api/payment-disputes/11111111-1111-4111-8111-111111111111/acknowledgements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerVersion: 2 }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "DISPUTE_VERSION_CHANGED" },
    });
  });
});
