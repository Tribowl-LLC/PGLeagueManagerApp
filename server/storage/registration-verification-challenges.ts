import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../config";
import {
  registrationVerificationChallenges,
  type RegistrationVerificationChallenge,
  type RegistrationVerificationChallengeStatus,
} from "@shared/schema";

export type RegistrationChallengeExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REGISTRATION_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const REGISTRATION_SETUP_TTL_MS = 15 * 60 * 1000;
export const REGISTRATION_RESEND_DELAYS_MS = [
  30 * 1000,
  60 * 1000,
  120 * 1000,
  300 * 1000,
] as const;
export const REGISTRATION_MAX_VERIFICATION_ATTEMPTS = 5;
export const REGISTRATION_PHONE_VERIFICATION_ATTEMPT_LIMIT = 10;
export const REGISTRATION_PHONE_DELIVERY_LIMIT = 5;
export const REGISTRATION_EMAIL_DELIVERY_LIMIT = 5;
export const REGISTRATION_PROVIDER_LEASE_MS = 30 * 1000;

export type RegistrationChallengeCapability = {
  challengeId: string;
  organizationId: number;
  bindingSecret: string;
};

export type RegistrationProviderLease = {
  row: RegistrationVerificationChallenge;
  leaseToken: string;
};

export class RegistrationChallengeError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "EXPIRED"
      | "REPLACED"
      | "CANCELLED"
      | "CONSUMED"
      | "NOT_VERIFIED"
      | "SETUP_EXPIRED"
      | "RESEND_COOLDOWN"
      | "PROVIDER_BUSY"
      | "PROVIDER_LEASE_LOST"
      | "ORG_MISMATCH"
      | "SESSION_MISMATCH",
  ) {
    super(code);
    this.name = "RegistrationChallengeError";
  }
}

export class RegistrationVerificationAttemptsExceededError extends Error {
  constructor() {
    super("Registration verification attempts exceeded");
    this.name = "RegistrationVerificationAttemptsExceededError";
  }
}

export class RegistrationDeliveryLimitExceededError extends Error {
  constructor() {
    super("Registration delivery limit exceeded");
    this.name = "RegistrationDeliveryLimitExceededError";
  }
}

/** Never persist the raw registration capability secret. */
export function registrationSessionBindingHash(bindingSecret: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(bindingSecret, "utf8")
    .digest("hex");
}

function statusOf(row: RegistrationVerificationChallenge): RegistrationVerificationChallengeStatus {
  return row.status as RegistrationVerificationChallengeStatus;
}

function isExpired(value: string | null | undefined, now = Date.now()): boolean {
  return value !== null && value !== undefined && Date.parse(value) <= now;
}

async function lockSessionBinding(
  executor: RegistrationChallengeExecutor,
  bindingHash: string,
): Promise<void> {
  // Serialize concurrent submissions for one browser capability while
  // allowing unrelated registrations to proceed on other sessions.
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${bindingHash}))`);
}

async function lockPhone(
  executor: RegistrationChallengeExecutor,
  phone: string,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'registration-phone:' + phone}))`);
}

async function lockEmail(
  executor: RegistrationChallengeExecutor,
  email: string,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'registration-email:' + email}))`);
}

function resendDelayMs(sendCount: number): number {
  if (sendCount <= 0) return 0;
  const index = Math.min(sendCount - 1, REGISTRATION_RESEND_DELAYS_MS.length - 1);
  return REGISTRATION_RESEND_DELAYS_MS[index] ?? REGISTRATION_RESEND_DELAYS_MS[0];
}

function providerLeaseActive(row: RegistrationVerificationChallenge, now = Date.now()): boolean {
  return Boolean(
    row.operationLeaseToken
    && row.operationLeaseExpiresAt
    && Date.parse(row.operationLeaseExpiresAt) > now,
  );
}

export async function createRegistrationChallenge(input: {
  bindingSecret: string;
  organizationId: number;
  existingUserId?: number | null;
  email: string;
  name: string;
  phone: string;
  now?: Date;
}, executor: RegistrationChallengeExecutor = db): Promise<RegistrationVerificationChallenge> {
  const now = input.now ?? new Date();
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  return executor === db
    ? db.transaction(async (tx) => createChallengeInTransaction(tx, input, bindingHash, now))
    : createChallengeInTransaction(executor, input, bindingHash, now);
}

async function createChallengeInTransaction(
  tx: RegistrationChallengeExecutor,
  input: Omit<Parameters<typeof createRegistrationChallenge>[0], "now">,
  bindingHash: string,
  now: Date,
): Promise<RegistrationVerificationChallenge> {
  await lockSessionBinding(tx, bindingHash);
  await tx.update(registrationVerificationChallenges).set({
    email: "[redacted]",
    name: "[redacted]",
    phone: "[redacted]",
  }).where(sql`${registrationVerificationChallenges.createdAt} < now() - interval '24 hours'`);
  const [current] = await tx
    .select()
    .from(registrationVerificationChallenges)
    .where(eq(registrationVerificationChallenges.sessionBindingHash, bindingHash))
    .orderBy(desc(registrationVerificationChallenges.createdAt), desc(registrationVerificationChallenges.id))
    .limit(1);
  if (current && (statusOf(current) === "pending" || statusOf(current) === "verified") && !isExpired(current.expiresAt, now.getTime())) {
    await tx
      .update(registrationVerificationChallenges)
      .set({ status: "replaced" })
      .where(eq(registrationVerificationChallenges.id, current.id));
  }
  const [created] = await tx
    .insert(registrationVerificationChallenges)
    .values({
      id: randomBytes(32).toString("hex"),
      organizationId: input.organizationId,
      existingUserId: input.existingUserId ?? null,
      sessionBindingHash: bindingHash,
      email: input.email,
      name: input.name,
      phone: input.phone,
      status: "pending",
      expiresAt: new Date(now.getTime() + REGISTRATION_CHALLENGE_TTL_MS).toISOString(),
    })
    .returning();
  if (!created) throw new Error("Failed to create registration verification challenge");
  return created;
}

/**
 * Reserve exactly one outbound Twilio operation for a challenge. The lease is
 * written in a short transaction, then the provider call happens after the
 * transaction has committed. The token fences stale provider responses after
 * resend, cancellation, supersession, or lease expiry.
 */
export async function acquireRegistrationProviderLease(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  operation: "send" | "verify";
}, executor: RegistrationChallengeExecutor = db): Promise<RegistrationProviderLease> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const run = async (tx: RegistrationChallengeExecutor): Promise<RegistrationProviderLease> => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx.select().from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      )).limit(1).for("update");
    if (!row) throw new RegistrationChallengeError("NOT_FOUND");
    const status = statusOf(row);
    if (status === "replaced") throw new RegistrationChallengeError("REPLACED");
    if (status === "cancelled") throw new RegistrationChallengeError("CANCELLED");
    if (status === "consumed") throw new RegistrationChallengeError("CONSUMED");
    if (status !== "pending") throw new RegistrationChallengeError("NOT_VERIFIED");
    if (isExpired(row.expiresAt)) {
      await tx.update(registrationVerificationChallenges).set({ status: "expired" })
        .where(eq(registrationVerificationChallenges.id, row.id));
      throw new RegistrationChallengeError("EXPIRED");
    }
    if (providerLeaseActive(row)) throw new RegistrationChallengeError("PROVIDER_BUSY");
    if (input.operation === "send" && row.lastSentAt
      && Date.parse(row.lastSentAt) + resendDelayMs(row.sendCount) > Date.now()) {
      throw new RegistrationChallengeError("RESEND_COOLDOWN");
    }
    if (input.operation === "send") {
      // The delivery cap is a reservation, not a post-provider observation.
      // Lock both normalized keys in a fixed order and increment this
      // challenge's request count in the same short transaction that grants
      // the provider lease. The Twilio call still happens after commit, so
      // no database transaction is held over the network operation, while
      // concurrent sessions cannot both pass the cap check.
      await lockPhone(tx, row.phone);
      await lockEmail(tx, row.email);
      const phoneWindow = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const emailWindow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [phoneRequests] = await tx.select({
        total: sql<number>`coalesce(sum(${registrationVerificationChallenges.sendCount}), 0)`,
      }).from(registrationVerificationChallenges).where(and(
        eq(registrationVerificationChallenges.phone, row.phone),
        sql`${registrationVerificationChallenges.lastSentAt} >= ${phoneWindow}`,
      ));
      const [emailRequests] = await tx.select({
        total: sql<number>`coalesce(sum(${registrationVerificationChallenges.sendCount}), 0)`,
      }).from(registrationVerificationChallenges).where(and(
        eq(registrationVerificationChallenges.email, row.email),
        sql`${registrationVerificationChallenges.lastSentAt} >= ${emailWindow}`,
      ));
      if (
        Number(phoneRequests?.total ?? 0) >= REGISTRATION_PHONE_DELIVERY_LIMIT
        || Number(emailRequests?.total ?? 0) >= REGISTRATION_EMAIL_DELIVERY_LIMIT
      ) {
        throw new RegistrationDeliveryLimitExceededError();
      }
    }
    if (input.operation === "verify") {
      if (!row.providerVerificationSid) throw new RegistrationChallengeError("NOT_VERIFIED");
      await lockPhone(tx, row.phone);
      const phoneWindow = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const [phoneAttempts] = await tx.select({
        total: sql<number>`coalesce(sum(${registrationVerificationChallenges.verificationAttemptCount}), 0)`,
      }).from(registrationVerificationChallenges).where(and(
        eq(registrationVerificationChallenges.phone, row.phone),
        sql`${registrationVerificationChallenges.createdAt} >= ${phoneWindow}`,
      ));
      if (Number(phoneAttempts?.total ?? 0) >= REGISTRATION_PHONE_VERIFICATION_ATTEMPT_LIMIT
        || row.verificationAttemptCount >= REGISTRATION_MAX_VERIFICATION_ATTEMPTS) {
        throw new RegistrationVerificationAttemptsExceededError();
      }
    }
    const leaseToken = randomBytes(32).toString("hex");
    const leaseStartedAt = new Date().toISOString();
    const [leased] = await tx.update(registrationVerificationChallenges).set({
      operationLeaseToken: leaseToken,
      operationLeaseExpiresAt: new Date(Date.now() + REGISTRATION_PROVIDER_LEASE_MS).toISOString(),
      operationVersion: sql`${registrationVerificationChallenges.operationVersion} + 1`,
      ...(input.operation === "send" ? {
        // Reserve the request before the provider call. A provider timeout
        // remains counted because repeating it automatically is unsafe.
        lastSentAt: leaseStartedAt,
        sendCount: sql`${registrationVerificationChallenges.sendCount} + 1`,
      } : {}),
      updatedAt: leaseStartedAt,
    }).where(eq(registrationVerificationChallenges.id, row.id)).returning();
    if (!leased) throw new Error("Failed to acquire registration provider lease");
    return { row: leased, leaseToken };
  };
  return executor === db ? db.transaction(run) : run(executor);
}

export async function releaseRegistrationProviderLease(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  leaseToken: string;
}, executor: RegistrationChallengeExecutor = db): Promise<boolean> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const run = async (tx: RegistrationChallengeExecutor): Promise<boolean> => {
    await lockSessionBinding(tx, bindingHash);
    const [released] = await tx.update(registrationVerificationChallenges).set({
      operationLeaseToken: null,
      operationLeaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(registrationVerificationChallenges.id, input.challengeId),
      eq(registrationVerificationChallenges.organizationId, input.organizationId),
      eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      eq(registrationVerificationChallenges.operationLeaseToken, input.leaseToken),
    )).returning({ id: registrationVerificationChallenges.id });
    return Boolean(released);
  };
  return executor === db ? db.transaction(run) : run(executor);
}

export async function redactRegistrationChallengePii(
  challengeId: string,
  executor: RegistrationChallengeExecutor,
): Promise<void> {
  await executor.update(registrationVerificationChallenges).set({
    email: "[redacted]",
    name: "[redacted]",
    phone: "[redacted]",
    updatedAt: new Date().toISOString(),
  }).where(eq(registrationVerificationChallenges.id, challengeId));
}

export async function getRegistrationChallengeForSession(
  bindingSecret: string,
  challengeId: string,
  organizationId: number,
  executor: RegistrationChallengeExecutor = db,
): Promise<RegistrationVerificationChallenge | undefined> {
  const bindingHash = registrationSessionBindingHash(bindingSecret);
  const [row] = await executor
    .select()
    .from(registrationVerificationChallenges)
    .where(and(
      eq(registrationVerificationChallenges.id, challengeId),
      eq(registrationVerificationChallenges.organizationId, organizationId),
      eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
    ))
    .limit(1);
  return row;
}

export async function markRegistrationVerificationSent(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  leaseToken: string;
  providerVerificationSid: string;
}, executor: RegistrationChallengeExecutor = db): Promise<RegistrationVerificationChallenge> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const run = async (tx: RegistrationChallengeExecutor) => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx
      .select()
      .from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      ))
      .for("update");
    if (!row) throw new RegistrationChallengeError("NOT_FOUND");
    if (statusOf(row) === "replaced") throw new RegistrationChallengeError("REPLACED");
    if (statusOf(row) === "cancelled") throw new RegistrationChallengeError("CANCELLED");
    if (statusOf(row) === "consumed") throw new RegistrationChallengeError("CONSUMED");
    if (isExpired(row.expiresAt)) {
      await tx.update(registrationVerificationChallenges)
        .set({ status: "expired" })
        .where(eq(registrationVerificationChallenges.id, row.id));
      throw new RegistrationChallengeError("EXPIRED");
    }
    if (!row.operationLeaseToken || row.operationLeaseToken !== input.leaseToken
      || !row.operationLeaseExpiresAt || Date.parse(row.operationLeaseExpiresAt) <= Date.now()) {
      throw new RegistrationChallengeError("PROVIDER_LEASE_LOST");
    }
    const [updated] = await tx
      .update(registrationVerificationChallenges)
      .set({
        providerVerificationSid: input.providerVerificationSid,
        operationLeaseToken: null,
        operationLeaseExpiresAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(registrationVerificationChallenges.id, row.id),
        eq(registrationVerificationChallenges.operationLeaseToken, input.leaseToken),
      ))
      .returning();
    if (!updated) throw new Error("Failed to record registration verification delivery");
    return updated;
  };
  return executor === db ? db.transaction(run) : run(executor);
}

/** Record an existing-account recovery delivery without persisting a Twilio SID. */
export async function markRegistrationRecoverySent(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  leaseToken: string;
}, executor: RegistrationChallengeExecutor = db): Promise<RegistrationVerificationChallenge> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const run = async (tx: RegistrationChallengeExecutor) => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx.select().from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      ))
      .limit(1)
      .for("update");
    if (!row) throw new RegistrationChallengeError("NOT_FOUND");
    if (statusOf(row) === "replaced") throw new RegistrationChallengeError("REPLACED");
    if (statusOf(row) === "cancelled") throw new RegistrationChallengeError("CANCELLED");
    if (statusOf(row) === "consumed") throw new RegistrationChallengeError("CONSUMED");
    if (isExpired(row.expiresAt)) {
      await tx.update(registrationVerificationChallenges)
        .set({ status: "expired" })
        .where(eq(registrationVerificationChallenges.id, row.id));
      throw new RegistrationChallengeError("EXPIRED");
    }
    if (!row.operationLeaseToken || row.operationLeaseToken !== input.leaseToken
      || !row.operationLeaseExpiresAt || Date.parse(row.operationLeaseExpiresAt) <= Date.now()) {
      throw new RegistrationChallengeError("PROVIDER_LEASE_LOST");
    }
    const [updated] = await tx.update(registrationVerificationChallenges).set({
      operationLeaseToken: null,
      operationLeaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(registrationVerificationChallenges.id, row.id),
      eq(registrationVerificationChallenges.operationLeaseToken, input.leaseToken),
    )).returning();
    if (!updated) throw new Error("Failed to record registration recovery delivery");
    return updated;
  };
  return executor === db ? db.transaction(run) : run(executor);
}

export async function recordRegistrationVerificationAttempt(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  leaseToken: string;
  now?: Date;
}, executor: RegistrationChallengeExecutor = db): Promise<number> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const now = input.now ?? new Date();
  const run = async (tx: RegistrationChallengeExecutor) => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx
      .select()
      .from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      ))
      .for("update");
    if (!row) throw new RegistrationChallengeError("NOT_FOUND");
    if (statusOf(row) === "replaced") throw new RegistrationChallengeError("REPLACED");
    if (statusOf(row) === "cancelled") throw new RegistrationChallengeError("CANCELLED");
    if (statusOf(row) === "consumed") throw new RegistrationChallengeError("CONSUMED");
    if (statusOf(row) === "verified") return row.verificationAttemptCount;
    if (!row.operationLeaseToken || row.operationLeaseToken !== input.leaseToken
      || !row.operationLeaseExpiresAt || Date.parse(row.operationLeaseExpiresAt) <= now.getTime()) {
      throw new RegistrationChallengeError("PROVIDER_LEASE_LOST");
    }
    await lockPhone(tx, row.phone);
    const phoneWindow = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const [phoneAttempts] = await tx.select({
      total: sql<number>`coalesce(sum(${registrationVerificationChallenges.verificationAttemptCount}), 0)`,
    }).from(registrationVerificationChallenges).where(and(
      eq(registrationVerificationChallenges.phone, row.phone),
      sql`${registrationVerificationChallenges.createdAt} >= ${phoneWindow}`,
    ));
    if (Number(phoneAttempts?.total ?? 0) >= REGISTRATION_PHONE_VERIFICATION_ATTEMPT_LIMIT) {
      throw new RegistrationVerificationAttemptsExceededError();
    }
    if (isExpired(row.expiresAt, now.getTime())) {
      await tx.update(registrationVerificationChallenges)
        .set({ status: "expired" })
        .where(eq(registrationVerificationChallenges.id, row.id));
      throw new RegistrationChallengeError("EXPIRED");
    }
    if (row.verificationAttemptCount >= REGISTRATION_MAX_VERIFICATION_ATTEMPTS) {
      throw new RegistrationVerificationAttemptsExceededError();
    }
    const [updated] = await tx
      .update(registrationVerificationChallenges)
      .set({
        verificationAttemptCount: sql`${registrationVerificationChallenges.verificationAttemptCount} + 1`,
        operationLeaseToken: null,
        operationLeaseExpiresAt: null,
        updatedAt: now.toISOString(),
      })
      .where(and(
        eq(registrationVerificationChallenges.id, row.id),
        eq(registrationVerificationChallenges.operationLeaseToken, input.leaseToken),
      ))
      .returning({ verificationAttemptCount: registrationVerificationChallenges.verificationAttemptCount });
    if (!updated) throw new Error("Failed to record registration verification attempt");
    return updated.verificationAttemptCount;
  };
  return executor === db ? db.transaction(run) : run(executor);
}

export async function markRegistrationChallengeVerified(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
  leaseToken: string;
  expectedProviderVerificationSid: string;
  now?: Date;
}, executor: RegistrationChallengeExecutor = db): Promise<RegistrationVerificationChallenge> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const now = input.now ?? new Date();
  const run = async (tx: RegistrationChallengeExecutor) => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx
      .select()
      .from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      ))
      .for("update");
    if (!row) throw new RegistrationChallengeError("NOT_FOUND");
    if (statusOf(row) === "verified") return row;
    if (statusOf(row) === "replaced") throw new RegistrationChallengeError("REPLACED");
    if (statusOf(row) === "cancelled") throw new RegistrationChallengeError("CANCELLED");
    if (statusOf(row) === "consumed") throw new RegistrationChallengeError("CONSUMED");
    if (isExpired(row.expiresAt, now.getTime())) {
      await tx.update(registrationVerificationChallenges)
        .set({ status: "expired" })
        .where(eq(registrationVerificationChallenges.id, row.id));
      throw new RegistrationChallengeError("EXPIRED");
    }
    if (row.providerVerificationSid !== input.expectedProviderVerificationSid
      || !row.operationLeaseToken
      || row.operationLeaseToken !== input.leaseToken
      || !row.operationLeaseExpiresAt
      || Date.parse(row.operationLeaseExpiresAt) <= now.getTime()) {
      throw new RegistrationChallengeError("PROVIDER_LEASE_LOST");
    }
    const [updated] = await tx
      .update(registrationVerificationChallenges)
      .set({
        status: "verified",
        verifiedAt: now.toISOString(),
        setupExpiresAt: new Date(now.getTime() + REGISTRATION_SETUP_TTL_MS).toISOString(),
        operationLeaseToken: null,
        operationLeaseExpiresAt: null,
        updatedAt: now.toISOString(),
      })
      .where(and(
        eq(registrationVerificationChallenges.id, row.id),
        eq(registrationVerificationChallenges.operationLeaseToken, input.leaseToken),
        eq(registrationVerificationChallenges.providerVerificationSid, input.expectedProviderVerificationSid),
      ))
      .returning();
    if (!updated) throw new Error("Failed to mark registration challenge verified");
    return updated;
  };
  return executor === db ? db.transaction(run) : run(executor);
}

/**
 * Lock and consume the setup capability. Call this inside the same
 * transaction that creates the user and writes any identity-link event.
 */
export async function consumeRegistrationChallenge(
  input: { challengeId: string; bindingSecret: string; organizationId: number; now?: Date },
  executor: RegistrationChallengeExecutor,
): Promise<RegistrationVerificationChallenge> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const now = input.now ?? new Date();
  await lockSessionBinding(executor, bindingHash);
  const [row] = await executor
    .select()
    .from(registrationVerificationChallenges)
    .where(and(
      eq(registrationVerificationChallenges.id, input.challengeId),
      eq(registrationVerificationChallenges.organizationId, input.organizationId),
      eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
    ))
    .for("update");
  if (!row) throw new RegistrationChallengeError("NOT_FOUND");
  const status = statusOf(row);
  if (status === "replaced") throw new RegistrationChallengeError("REPLACED");
  if (status === "cancelled") throw new RegistrationChallengeError("CANCELLED");
  if (status === "consumed") throw new RegistrationChallengeError("CONSUMED");
  if (status !== "verified") throw new RegistrationChallengeError("NOT_VERIFIED");
  if (isExpired(row.setupExpiresAt, now.getTime())) throw new RegistrationChallengeError("SETUP_EXPIRED");
  const [consumed] = await executor
    .update(registrationVerificationChallenges)
    .set({ status: "consumed", consumedAt: now.toISOString() })
    .where(eq(registrationVerificationChallenges.id, row.id))
    .returning();
  if (!consumed) throw new Error("Failed to consume registration challenge");
  return consumed;
}

/** Cancel the active anonymous capability when the user abandons/corrects it. */
export async function cancelRegistrationChallenge(input: {
  challengeId: string;
  bindingSecret: string;
  organizationId: number;
}, executor: RegistrationChallengeExecutor = db): Promise<void> {
  const bindingHash = registrationSessionBindingHash(input.bindingSecret);
  const run = async (tx: RegistrationChallengeExecutor) => {
    await lockSessionBinding(tx, bindingHash);
    const [row] = await tx.select({
      id: registrationVerificationChallenges.id,
      status: registrationVerificationChallenges.status,
    }).from(registrationVerificationChallenges)
      .where(and(
        eq(registrationVerificationChallenges.id, input.challengeId),
        eq(registrationVerificationChallenges.organizationId, input.organizationId),
        eq(registrationVerificationChallenges.sessionBindingHash, bindingHash),
      ))
      .limit(1)
      .for("update");
    if (!row) return;
    if (row.status === "pending" || row.status === "verified") {
      await tx.update(registrationVerificationChallenges).set({
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      }).where(eq(registrationVerificationChallenges.id, row.id));
    }
  };
  if (executor === db) await db.transaction(run);
  else await run(executor);
}

export function registrationChallengePhase(
  row: RegistrationVerificationChallenge | undefined,
): "verify_phone" | "set_password" | "complete" | "expired" | "missing" {
  if (!row) return "missing";
  const status = statusOf(row);
  if (status === "pending") return isExpired(row.expiresAt) ? "expired" : "verify_phone";
  if (status === "verified") return isExpired(row.setupExpiresAt) ? "expired" : "set_password";
  if (status === "consumed") return "complete";
  return "expired";
}

export function challengeResendCooldownSeconds(
  row: RegistrationVerificationChallenge | undefined,
  now = Date.now(),
): number {
  // The initial delivery is allowed immediately. Subsequent sends use an
  // increasing delay (30s, 60s, 120s, then 300s); this value never changes
  // the ten-minute verification expiry.
  if (!row) return 0;
  if (!row.lastSentAt) return 0;
  const next = Date.parse(row.lastSentAt) + resendDelayMs(row.sendCount);
  return Math.max(0, Math.ceil((next - now) / 1000));
}
