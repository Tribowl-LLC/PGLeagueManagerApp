import { describe, expect, it } from "vitest";

// This suite exercises the pure registration boundary without booting an app
// or connecting to a database. The imported services still initialize their
// normal configuration, so provide deterministic local-only values first.
process.env.DATABASE_URL ??= "postgres://registration-verification.invalid/test";
process.env.SESSION_SECRET ??= "registration-verification-local-session-secret";
process.env.FIELD_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const {
  maskRegistrationPhone,
  normalizeRegistrationPhone,
} = await import("../../server/services/registration-verification.js");
const {
  registrationSessionBindingHash,
  registrationChallengePhase,
  challengeResendCooldownSeconds,
} = await import("../../server/storage/registration-verification-challenges.js");

describe("SMS registration verification boundaries", () => {
  it("accepts only valid US/Canadian numbers and emits E.164", () => {
    expect(normalizeRegistrationPhone("(415) 555-0132")).toBe("+14155550132");
    expect(normalizeRegistrationPhone("+1 416 555 0132")).toBe("+14165550132");
    expect(normalizeRegistrationPhone("+44 20 7946 0958")).toBeUndefined();
    expect(normalizeRegistrationPhone("not-a-phone")).toBeUndefined();
  });

  it("masks the phone without exposing its provider or challenge data", () => {
    expect(maskRegistrationPhone("+14155550132")).toBe("••• ••• 0132");
  });

  it("binds the capability to a keyed session hash", () => {
    expect(registrationSessionBindingHash("session-a")).toBe(registrationSessionBindingHash("session-a"));
    expect(registrationSessionBindingHash("session-a")).not.toBe(registrationSessionBindingHash("session-b"));
  });

  it("does not treat a pending challenge as a setup capability", () => {
    const now = new Date().toISOString();
    expect(registrationChallengePhase({
      id: "a".repeat(64),
      organizationId: 1,
      existingUserId: null,
      sessionBindingHash: "hash",
      email: "new@example.com",
      name: "New User",
      phone: "+14155550132",
      providerVerificationSid: null,
      operationLeaseToken: null,
      operationLeaseExpiresAt: null,
      operationVersion: 0,
      lastSentAt: null,
      sendCount: 0,
      verificationAttemptCount: 0,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verifiedAt: null,
      setupExpiresAt: null,
      consumedAt: null,
      createdAt: now,
    })).toBe("verify_phone");
  });

  it("allows the initial send and applies increasing resend delays", () => {
    const now = Date.now();
    const base = {
      id: "b".repeat(64),
      organizationId: 1,
      existingUserId: null,
      sessionBindingHash: "hash",
      email: "new@example.com",
      name: "New User",
      phone: "+14155550132",
      providerVerificationSid: "VE123",
      operationLeaseToken: null,
      operationLeaseExpiresAt: null,
      operationVersion: 0,
      verificationAttemptCount: 0,
      status: "pending" as const,
      expiresAt: new Date(now + 60_000).toISOString(),
      verifiedAt: null,
      setupExpiresAt: null,
      consumedAt: null,
      createdAt: new Date(now).toISOString(),
    };
    expect(challengeResendCooldownSeconds({ ...base, lastSentAt: null, sendCount: 0 }, now)).toBe(0);
    expect(challengeResendCooldownSeconds({ ...base, lastSentAt: new Date(now).toISOString(), sendCount: 1 }, now)).toBe(30);
    expect(challengeResendCooldownSeconds({ ...base, lastSentAt: new Date(now).toISOString(), sendCount: 2 }, now)).toBe(60);
    expect(challengeResendCooldownSeconds({ ...base, lastSentAt: new Date(now).toISOString(), sendCount: 4 }, now)).toBe(300);
  });
});
