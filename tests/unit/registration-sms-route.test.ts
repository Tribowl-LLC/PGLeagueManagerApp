/** Route contract for provider SID reuse after a simulated restart. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const challengeState = vi.hoisted(() => ({
  capability: {
    challengeId: "a".repeat(64),
    organizationId: 5,
    bindingSecret: "b".repeat(64),
    createdAt: Date.now(),
  },
  row: {
    id: "a".repeat(64),
    organizationId: 5,
    existingUserId: null,
    sessionBindingHash: "binding-hash",
    email: "sid-reuse@example.test",
    name: "SID reuse route fixture",
    phone: "+12025550100",
    providerVerificationSid: null as string | null,
    operationLeaseToken: null as string | null,
    operationLeaseExpiresAt: null as string | null,
    operationVersion: 0,
    lastSentAt: null,
    sendCount: 0,
    verificationAttemptCount: 0,
    status: "pending",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    verifiedAt: null,
    setupExpiresAt: null,
    consumedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  leaseCount: 0,
  markedSids: [] as string[],
  adapterSends: 0,
  providerFailure: false,
  persistenceFailure: false,
  recoveryFailure: false,
  existingUser: false,
  logs: [] as Array<{ level: string; message: string; fields: unknown[] }>,
}));

class MockRegistrationChallengeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
class MockRegistrationDeliveryLimitExceededError extends Error {}
class MockRegistrationVerificationAttemptsExceededError extends Error {}
class MockTwilioVerifyError extends Error {
  constructor(public readonly code: "not_configured" | "provider_not_found" | "provider_unavailable") {
    super(code);
  }
}

vi.mock("../../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async () => challengeState.existingUser ? {
      id: 99,
      email: challengeState.row.email,
      password: "existing-password-hash",
      organizationId: challengeState.row.organizationId,
      credentialGeneration: 0,
    } : undefined),
    getUser: vi.fn(async () => undefined),
    getOrganization: vi.fn(async () => ({ id: 5, name: "Test Org", active: true })),
    getActiveOrganizations: vi.fn(async () => []),
  },
}));
vi.mock("../../server/storage/account-action-delivery-jobs", () => ({
  enqueuePasswordResetDelivery: vi.fn(async () => {
    if (challengeState.recoveryFailure) throw new Error("recovery SQL failure with email@example.test");
    return { kind: "enqueued", job: { id: 1 } };
  }),
  enqueueAccountRegistrationDelivery: vi.fn(async () => ({ kind: "enqueued", job: { id: 1 } })),
  resumePendingAccountRegistration: vi.fn(),
}));
vi.mock("../../server/storage/account-guidance-delivery-jobs", () => ({
  enqueueAccountGuidanceNotice: vi.fn(),
}));
vi.mock("../../server/services/account-action-delivery-scheduler.js", () => ({
  notifyAccountActionDeliveryChanged: vi.fn(),
}));
vi.mock("../../server/storage/profile-claim-notifications.js", () => ({
  hasActiveIdentitySecurityHold: vi.fn(async () => false),
}));
vi.mock("../../server/storage/account-action-requests.js", () => ({
  withAccountActionDeliveryLock: vi.fn(),
}));
vi.mock("../../server/storage/registration-verification-challenges.js", () => ({
  createRegistrationChallenge: vi.fn(),
  acquireRegistrationProviderLease: vi.fn(async () => {
    challengeState.leaseCount += 1;
    return {
      row: challengeState.row,
      leaseToken: `lease-${challengeState.leaseCount}`,
    };
  }),
  releaseRegistrationProviderLease: vi.fn(async () => true),
  getRegistrationChallengeForSession: vi.fn(async () => challengeState.row),
  markRegistrationVerificationSent: vi.fn(async (input: { providerVerificationSid: string }) => {
    if (challengeState.persistenceFailure) throw new Error("database SQL failure for +12025550100");
    challengeState.markedSids.push(input.providerVerificationSid);
    challengeState.row.providerVerificationSid = input.providerVerificationSid;
    return challengeState.row;
  }),
  markRegistrationRecoverySent: vi.fn(),
  cancelRegistrationChallenge: vi.fn(),
  recordRegistrationVerificationAttempt: vi.fn(),
  registrationChallengePhase: vi.fn(() => "verify_phone"),
  challengeResendCooldownSeconds: vi.fn(() => 0),
  RegistrationDeliveryLimitExceededError: MockRegistrationDeliveryLimitExceededError,
  RegistrationVerificationAttemptsExceededError: MockRegistrationVerificationAttemptsExceededError,
  RegistrationChallengeError: MockRegistrationChallengeError,
}));
vi.mock("../../server/services/registration-verification.js", () => ({
  completeRegistration: vi.fn(),
  isPasswordValidForRegistration: vi.fn(() => true),
  maskRegistrationPhone: vi.fn((phone: string) => `***${phone.slice(-4)}`),
  normalizeRegistrationPhone: vi.fn((phone: string) => phone),
  RegistrationExistingAccountError: class extends Error {},
  RegistrationPasswordError: class extends Error {},
}));
vi.mock("../../server/services/twilio-verify.js", () => ({
  getTwilioVerifyAdapter: vi.fn(() => ({
    sendSmsVerification: vi.fn(async () => {
      if (challengeState.providerFailure) throw new MockTwilioVerifyError("provider_unavailable");
      challengeState.adapterSends += 1;
      return { sid: "VE-restarted-same-sid" };
    }),
    checkSmsVerification: vi.fn(),
  })),
  TwilioVerifyError: MockTwilioVerifyError,
}));
vi.mock("../../server/logger", () => ({
  createLogger: () => ({
    info: (...fields: unknown[]) => challengeState.logs.push({ level: "info", message: String(fields[0]), fields: fields.slice(1) }),
    warn: (...fields: unknown[]) => challengeState.logs.push({ level: "warn", message: String(fields[0]), fields: fields.slice(1) }),
    error: (...fields: unknown[]) => challengeState.logs.push({ level: "error", message: String(fields[0]), fields: fields.slice(1) }),
    debug: (...fields: unknown[]) => challengeState.logs.push({ level: "debug", message: String(fields[0]), fields: fields.slice(1) }),
  }),
}));
vi.mock("../../server/db.js", () => ({ db: { transaction: vi.fn(), select: vi.fn() } }));
vi.mock("../../server/config", () => ({ env: {}, isDev: true, isProdLike: false, isSingletonOrganizationMode: false }));
vi.mock("../../server/utils/rate-limit-store", () => ({ createSharedRateLimitStore: () => undefined }));
vi.mock("../../server/middleware/csrf", () => ({ csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../server/middleware/subdomain", () => ({ checkUserBelongsToOrg: vi.fn(async () => true) }));
vi.mock("../../server/utils/cache", () => ({ cacheInvalidate: vi.fn() }));
vi.mock("../../server/utils/db-errors", () => ({ isNormalizedUserEmailConflict: () => false }));
vi.mock("../../server/services/identity-link.js", () => ({ linkUserToBowler: vi.fn(), isIdentityLinkError: () => false }));
vi.mock("../../server/services/email.js", () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => "https://test.example",
  getOrgLogoUrl: () => "",
}));
vi.mock("../../server/lib/password", () => ({ hashPassword: vi.fn(async () => "hashed-password") }));
vi.mock("../../server/auth", () => ({ destroyOtherSessionsForUser: vi.fn(async () => 0) }));
vi.mock("passport", () => ({ default: { authenticate: () => (_req: Request, _res: Response, _next: NextFunction) => undefined } }));
vi.mock("express-rate-limit", () => ({ default: () => (_req: Request, _res: Response, next: NextFunction) => next() }));

const { registerAuthRoutes } = await import("../../server/routes/auth");

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: { registrationChallenge: challengeState.capability },
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
  challengeState.capability = {
    challengeId: "a".repeat(64),
    organizationId: 5,
    bindingSecret: "b".repeat(64),
    createdAt: Date.now(),
  };
  challengeState.row.id = "a".repeat(64);
  challengeState.row.sessionBindingHash = "binding-hash";
  challengeState.leaseCount = 0;
  challengeState.markedSids.length = 0;
  challengeState.adapterSends = 0;
  challengeState.providerFailure = false;
  challengeState.persistenceFailure = false;
  challengeState.recoveryFailure = false;
  challengeState.existingUser = false;
  challengeState.logs.length = 0;
  challengeState.row.providerVerificationSid = null;
});

describe("POST /api/auth/registration/send", () => {
  it("passes the same provider SID to a replacement challenge after a restart", async () => {
    const first = await fetch(`${baseUrl}/api/auth/registration/send`, { method: "POST" });
    challengeState.capability = {
      challengeId: "c".repeat(64),
      organizationId: 5,
      bindingSecret: "d".repeat(64),
      createdAt: Date.now(),
    };
    challengeState.row.id = "c".repeat(64);
    challengeState.row.sessionBindingHash = "replacement-binding-hash";
    const second = await fetch(`${baseUrl}/api/auth/registration/send`, { method: "POST" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(challengeState.adapterSends).toBe(2);
    expect(challengeState.markedSids).toEqual(["VE-restarted-same-sid", "VE-restarted-same-sid"]);
    expect((await second.json()).data).toMatchObject({ delivery: "sms", phase: "verify_phone" });
  });

  it("returns retryable persistence failure after provider delivery and logs only safe fields", async () => {
    challengeState.persistenceFailure = true;

    const response = await fetch(`${baseUrl}/api/auth/registration/send`, { method: "POST" });
    const body = await response.json() as { error?: { code?: string } };
    const serializedLogs = JSON.stringify(challengeState.logs);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("RETRYABLE_ERROR");
    expect(challengeState.adapterSends).toBe(1);
    expect(challengeState.logs).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Registration SMS persistence failed",
      fields: [{ stage: "persistence", errorCode: "unknown" }],
    }));
    expect(serializedLogs).not.toContain("database SQL failure");
    expect(serializedLogs).not.toContain(challengeState.row.phone);
    expect(serializedLogs).not.toContain(challengeState.row.email);
  });

  it("returns SMS_UNAVAILABLE for a provider delivery failure and identifies provider stage", async () => {
    challengeState.providerFailure = true;

    const response = await fetch(`${baseUrl}/api/auth/registration/send`, { method: "POST" });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("SMS_UNAVAILABLE");
    expect(challengeState.logs).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "Registration SMS delivery failed",
      fields: [{ stage: "provider", errorCode: "provider_unavailable" }],
    }));
  });

  it("returns a retryable recovery failure with a distinct safe stage", async () => {
    challengeState.existingUser = true;
    challengeState.recoveryFailure = true;

    const response = await fetch(`${baseUrl}/api/auth/registration/send`, { method: "POST" });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("RETRYABLE_ERROR");
    expect(challengeState.logs).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Registration recovery persistence failed",
      fields: [{ stage: "recovery", errorCode: "unknown" }],
    }));
  });
});
