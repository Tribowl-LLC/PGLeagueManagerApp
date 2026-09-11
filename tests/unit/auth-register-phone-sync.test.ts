/**
 * Registration no longer links or synchronizes roster data at initial sign
 * up. Email ownership is proved later by the account-registration action;
 * only that completion transaction may attempt the bounded identity link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("../../server/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockGetUserByEmail = vi.fn<(email: string) => Promise<unknown>>();
const mockCreateUser = vi.fn<(data: unknown, tx?: unknown) => Promise<unknown>>();
const mockEnqueueRegistration = vi.fn(async () => ({
  kind: "enqueued" as const,
  job: { id: 123 },
}));
const mockIdentityLink = vi.fn();

vi.mock("../../server/storage", () => ({
  storage: {
    getUserByEmail: (email: string) => mockGetUserByEmail(email),
    createUser: (data: unknown, tx?: unknown) => mockCreateUser(data, tx),
    getLeagues: vi.fn(async (organizationId: number) => [
      { id: 10, name: "Public League", organizationId, active: true, allowPublicSignup: true },
    ]),
    getUser: vi.fn(async () => undefined),
    getOrganization: vi.fn(async () => undefined),
    getBowlerByEmail: vi.fn(async () => undefined),
    getBowlerByEmailSystemAdmin: vi.fn(async () => undefined),
    getBowlerLeagues: vi.fn(async () => []),
    getLeague: vi.fn(async () => undefined),
    setUserOrganization: vi.fn(async () => undefined),
    updateUser: vi.fn(async () => undefined),
    clearUserInviteToken: vi.fn(async () => undefined),
    invalidatePendingEmailChangeRequestsForUser: vi.fn(async () => 0),
    setUserInviteToken: vi.fn(async () => undefined),
    getUserByInviteToken: vi.fn(async () => undefined),
  },
}));

vi.mock("../../server/storage/account-action-delivery-jobs", () => ({
  enqueueAccountRegistrationDelivery: (...args: unknown[]) => mockEnqueueRegistration(...args as []),
  enqueuePasswordResetDelivery: vi.fn(async () => ({ kind: "enqueued", job: { id: 456 } })),
  getNextPasswordResetDeliveryAt: vi.fn(async () => null),
}));

vi.mock("../../server/db", () => ({
  db: {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    select: vi.fn(),
  },
}));

vi.mock("../../server/services/identity-link.js", () => ({
  linkUserToBowler: (...args: unknown[]) => mockIdentityLink(...args),
  isIdentityLinkError: () => false,
}));
vi.mock("../../server/services/identity-link", () => ({
  linkUserToBowler: (...args: unknown[]) => mockIdentityLink(...args),
  isIdentityLinkError: () => false,
}));
vi.mock("../../server/services/email", () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => "https://test.example",
  getOrgLogoUrl: () => "",
}));
vi.mock("../../server/services/email.js", () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => "https://test.example",
  getOrgLogoUrl: () => "",
}));
vi.mock("../../server/auth", () => ({
  destroyOtherSessionsForUser: vi.fn(async () => 0),
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  safeTokenCompare: () => true,
}));
vi.mock("../../server/lib/password", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  safeTokenCompare: () => true,
}));
vi.mock("../../server/middleware/subdomain", () => ({ checkUserBelongsToOrg: vi.fn(async () => true) }));
vi.mock("../../server/middleware/csrf", () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("express-rate-limit", () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));
vi.mock("passport", () => ({
  default: {
    authenticate: () => (_req: Request, _res: Response, _next: NextFunction) => undefined,
    initialize: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    session: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  },
}));
vi.mock("../../server/utils/rate-limit-store", () => ({ createSharedRateLimitStore: () => undefined }));
vi.mock("../../server/config", () => ({ isDev: true, env: {} }));

const { registerAuthRoutes } = await import("../../server/routes/auth");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: {},
      login: (_user: unknown, callback: (error: unknown) => void) => callback(null),
      subdomainOrg: { id: 5, name: "Test Org" },
    });
    next();
  });
  registerAuthRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(undefined);
  mockCreateUser.mockResolvedValue({
    id: 99,
    email: "newbie@example.com",
    name: "New Bie",
    phone: "5559876",
    role: "user",
    organizationId: 5,
    bowlerId: null,
    credentialGeneration: 0,
  });
});

describe("POST /api/auth/register — email-first boundaries", () => {
  it("creates a pending account and queues delivery without a password or roster mutation", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "newbie@example.com",
        name: "New Bie",
        phone: "5559876",
        leagueId: "10",
        organizationId: "5",
      }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual(expect.objectContaining({ status: "pending" }));
    expect(mockCreateUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "newbie@example.com",
      password: expect.stringContaining("hashed:"),
      bowlerId: null,
    }), expect.anything());
    expect(mockEnqueueRegistration).toHaveBeenCalledWith(expect.objectContaining({
      userId: 99,
      organizationId: 5,
      credentialGeneration: 0,
    }), expect.anything());
    expect(mockIdentityLink).not.toHaveBeenCalled();
  });

  it("uses the same generic acknowledgement for an existing account and does not enqueue or mutate it", async () => {
    mockGetUserByEmail.mockResolvedValue({
      id: 401,
      email: "existing@example.com",
      role: "org_admin",
      phone: "5550000",
    });
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: " existing@example.com ",
        name: "Changed Name",
        phone: "5559999",
        leagueId: "10",
        organizationId: "5",
      }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual(expect.objectContaining({ status: "pending" }));
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockEnqueueRegistration).not.toHaveBeenCalled();
    expect(mockIdentityLink).not.toHaveBeenCalled();
  });
});
