/**
 * Route-level contract tests for the shared account-action validator.
 *
 * These tests use a small in-process Express app so the landing-page route
 * and the password-submission route execute the same production handler while
 * storage and session/email side effects remain deterministic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
  getAccountActionByToken: vi.fn(async (_token: string): Promise<unknown> => undefined),
  consumeAccountActionAndSetPassword: vi.fn(async (_input: unknown): Promise<unknown> => undefined),
  getBowlerByEmail: vi.fn(async (_email: string, _organizationId?: number): Promise<unknown> => undefined),
  isBowlerLinked: vi.fn(async (_bowlerId: number) => false),
  destroyOtherSessionsForUser: vi.fn(async (_userId: number, _keepSid: null) => 0),
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  linkUserToBowler: vi.fn(async (_input: unknown, _executor?: unknown): Promise<unknown> => undefined),
  sendPasswordChangedNotification: vi.fn(async (_email: string, _name: string, _details: unknown) => true),
  logs: [] as Array<{ message: string; args: unknown[] }>,
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getAccountActionByToken: (token: string) => mocks.getAccountActionByToken(token),
    consumeAccountActionAndSetPassword: (input: unknown) => mocks.consumeAccountActionAndSetPassword(input),
    getBowlerByEmail: (email: string, organizationId: number) => mocks.getBowlerByEmail(email, organizationId),
    getBowlerByEmailSystemAdmin: (email: string) => mocks.getBowlerByEmail(email),
    isBowlerLinked: (bowlerId: number) => mocks.isBowlerLinked(bowlerId),
    setUserOrganization: vi.fn(async () => undefined),
  },
}));

vi.mock("../../server/storage/account-action-requests.js", () => ({
  withAccountActionDeliveryLock: vi.fn(),
}));

vi.mock("../../server/logger", () => ({
  createLogger: () => ({
    info: (message: string, ...args: unknown[]) => mocks.logs.push({ message, args }),
    warn: (message: string, ...args: unknown[]) => mocks.logs.push({ message, args }),
    error: (message: string, ...args: unknown[]) => mocks.logs.push({ message, args }),
    debug: (message: string, ...args: unknown[]) => mocks.logs.push({ message, args }),
  }),
}));

vi.mock("../../server/lib/password", () => ({
  hashPassword: (password: string) => mocks.hashPassword(password),
}));

vi.mock("../../server/auth", () => ({
  destroyOtherSessionsForUser: (userId: number, keepSid: null) => mocks.destroyOtherSessionsForUser(userId, keepSid),
}));

vi.mock("../../server/db.js", () => ({
  db: { transaction: vi.fn() },
}));

vi.mock("../../server/config", () => ({ isDev: true, env: {} }));
vi.mock("../../server/utils/rate-limit-store", () => ({ createSharedRateLimitStore: () => undefined }));
vi.mock("express-rate-limit", () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../../server/middleware/csrf", () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../../server/middleware/subdomain", () => ({
  checkUserBelongsToOrg: vi.fn(async () => true),
}));
vi.mock("../../server/utils/cache", () => ({ cacheInvalidate: vi.fn() }));
vi.mock("../../server/utils/db-errors", () => ({ isNormalizedUserEmailConflict: () => false }));
vi.mock("../../server/services/bowler-phone-sync", () => ({ syncUserPhoneToBowler: vi.fn() }));
vi.mock("../../server/services/bowler-resync", () => ({ fireBowlerExternalResync: vi.fn() }));
vi.mock("../../server/services/identity-link.js", () => ({
  linkUserToBowler: (input: unknown, executor?: unknown) => mocks.linkUserToBowler(input, executor),
  isIdentityLinkError: () => false,
}));

vi.mock("../../server/services/email.js", () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  getBaseUrl: () => "https://test.example",
  getOrgLogoUrl: () => "",
  sendPasswordChangedNotification: (email: string, name: string, details: unknown) => mocks.sendPasswordChangedNotification(email, name, details),
  sendPasswordResetFallbackEmail: vi.fn(async () => true),
}));

vi.mock("passport", () => ({
  default: {
    authenticate: () => (_req: Request, _res: Response, _next: NextFunction) => undefined,
  },
}));

const { registerAuthRoutes } = await import("../../server/routes/auth");

let server: Server;
let baseUrl: string;
let loginCalls = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "login", {
      value: (_user: unknown, callback: (error: unknown) => void) => {
        loginCalls += 1;
        callback(null);
      },
    });
    next();
  });
  registerAuthRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  mocks.logs.length = 0;
  loginCalls = 0;
  mocks.getAccountActionByToken.mockReset();
  mocks.consumeAccountActionAndSetPassword.mockReset();
  mocks.getBowlerByEmail.mockReset();
  mocks.getBowlerByEmail.mockResolvedValue(undefined);
  mocks.isBowlerLinked.mockReset();
  mocks.isBowlerLinked.mockResolvedValue(false);
  mocks.destroyOtherSessionsForUser.mockReset();
  mocks.destroyOtherSessionsForUser.mockResolvedValue(0);
  mocks.hashPassword.mockClear();
  mocks.linkUserToBowler.mockReset();
  mocks.sendPasswordChangedNotification.mockReset();
  mocks.sendPasswordChangedNotification.mockResolvedValue(true);
});

function actionRecord(
  action: "account_invite" | "password_reset" | string,
  status: "pending" | "consumed" | "superseded" | "revoked" | "expired" = "pending",
  expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
) {
  return {
    request: { id: 42, action, status, expiresAt },
    user: {
      id: 7,
      email: "reset-user@example.com",
      name: "Reset User",
      role: "user",
      organizationId: 1,
      bowlerId: null,
      locationId: null,
      phone: null,
      avatar: null,
      preferredLanguage: null,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
    },
  };
}

async function getValidate(token = "valid-token") {
  const response = await fetch(`${baseUrl}/api/auth/validate-invite?token=${encodeURIComponent(token)}`);
  return { response, body: await response.json() as { success: boolean; data?: unknown; error?: { code: string } } };
}

async function postPassword(token = "valid-token") {
  const response = await fetch(`${baseUrl}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "StrongPassword!2026" }),
  });
  return { response, body: await response.json() as { success: boolean; data?: unknown; error?: { code: string } } };
}

describe("account-action route eligibility", () => {
  it.each(["account_invite", "password_reset"] as const)(
    "validates %s actions and returns only a masked email plus action",
    async (action) => {
      mocks.getAccountActionByToken.mockResolvedValue(actionRecord(action));

      const first = await getValidate();
      const second = await getValidate();

      expect(first.response.status).toBe(200);
      expect(first.body).toEqual({
        success: true,
        data: { email: "r***@example.com", action },
      });
      expect(second.body).toEqual(first.body);
      expect(mocks.getAccountActionByToken).toHaveBeenCalledTimes(2);
      expect(mocks.consumeAccountActionAndSetPassword).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["expired", "TOKEN_EXPIRED"],
    ["consumed", "TOKEN_USED"],
    ["superseded", "TOKEN_SUPERSEDED"],
    ["revoked", "TOKEN_REVOKED"],
  ] as const)("returns a deliberate code for %s actions", async (status, code) => {
    mocks.getAccountActionByToken.mockResolvedValue(actionRecord("password_reset", status));

    const { response, body } = await getValidate();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: { code } });
    expect(body).not.toHaveProperty("data");
  });

  it("rejects unknown and overlong tokens without looking up an account", async () => {
    mocks.getAccountActionByToken.mockResolvedValue(undefined);

    const unknown = await getValidate("unknown-token");
    const overlong = await getValidate("x".repeat(257));

    expect(unknown.body).toMatchObject({ success: false, error: { code: "INVALID_TOKEN" } });
    expect(overlong.body).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(mocks.getAccountActionByToken).toHaveBeenCalledTimes(1);
  });

  it("rejects an action with an unsupported purpose", async () => {
    mocks.getAccountActionByToken.mockResolvedValue(actionRecord("email_change"));

    const { response, body } = await getValidate();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: { code: "INVALID_TOKEN" } });
    expect(body).not.toHaveProperty("data");
  });

  it("allows password resets but keeps the caller on the normal login path", async () => {
    const record = actionRecord("password_reset");
    mocks.getAccountActionByToken.mockResolvedValue(record);
    mocks.consumeAccountActionAndSetPassword.mockResolvedValue(record);

    const { response, body } = await postPassword();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { message: "Password set successfully. Please log in." },
    });
    expect(mocks.consumeAccountActionAndSetPassword).toHaveBeenCalledTimes(1);
    expect(mocks.linkUserToBowler).not.toHaveBeenCalled();
    expect(loginCalls).toBe(0);
    expect(mocks.logs.some(({ message, args }) =>
      message === "Account action consumption"
      && JSON.stringify(args).includes('"actionId":42')
      && JSON.stringify(args).includes('password_changed'))).toBe(true);
  });

  it("preserves invitation auto-login behavior", async () => {
    const record = actionRecord("account_invite");
    mocks.getAccountActionByToken.mockResolvedValue(record);
    mocks.consumeAccountActionAndSetPassword.mockResolvedValue(record);
    mocks.getBowlerByEmail.mockResolvedValue({ id: 99, organizationId: 1 });
    mocks.linkUserToBowler.mockResolvedValue({
      user: { ...record.user, bowlerId: 99 },
    });

    const response = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-invitation": "1" },
      body: JSON.stringify({ token: "invite-token", password: "StrongPassword!2026" }),
    });
    expect(response.status).toBe(200);
    // The shared harness invokes req.login for invitation actions; this
    // assertion is pinned through the successful sanitized user response.
    expect(await response.json()).toMatchObject({ success: true, data: { id: 7, bowlerId: 99 } });
    expect(loginCalls).toBe(1);
  });
});
