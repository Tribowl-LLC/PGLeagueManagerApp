import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlers,
  users,
  type User,
} from "@shared/schema";
import { cacheInvalidate } from "../utils/cache.js";
import { notifyPaymentSyncRetryChanged } from "./payment-sync-retry-scheduler.js";
import {
  consumeRegistrationChallenge,
  getRegistrationChallengeForSession,
  type RegistrationChallengeExecutor,
  type RegistrationChallengeCapability,
  RegistrationChallengeError,
  redactRegistrationChallengePii,
} from "../storage/registration-verification-challenges.js";
import type { RegistrationVerificationChallenge } from "@shared/schema";
import { linkUserToBowler, isIdentityLinkError } from "./identity-link.js";
import { hashPassword } from "../lib/password.js";
import { passwordSchema } from "@shared/password-validation";
import { recordRegistrationVerificationProvenance } from "./verification-provenance.js";
import { isNormalizedUserEmailConflict } from "../utils/db-errors.js";

export const REGISTRATION_PHONE_COUNTRIES: readonly CountryCode[] = ["US", "CA"];

export function normalizeRegistrationPhone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parsePhoneNumberFromString(value.trim(), "US");
  if (!parsed || !parsed.isValid() || !parsed.country || !REGISTRATION_PHONE_COUNTRIES.includes(parsed.country)) {
    return undefined;
  }
  return parsed.number;
}

export function maskRegistrationPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "•••";
}

export function isPasswordValidForRegistration(value: unknown): value is string {
  return passwordSchema.safeParse(value).success;
}

export class RegistrationExistingAccountError extends Error {
  readonly email?: string;

  constructor(email?: string) {
    super("An account already exists for this email address");
    this.name = "RegistrationExistingAccountError";
    this.email = email;
  }
}

export class RegistrationPasswordError extends Error {
  constructor() {
    super("Password does not meet the registration requirements");
    this.name = "RegistrationPasswordError";
  }
}

export interface CompleteRegistrationResult {
  user: User;
  linked: boolean;
  challenge: RegistrationVerificationChallenge;
}

/**
 * Consume the verified capability, create the ordinary user, and perform the
 * email-based roster link in one DB transaction. Passport login is purposely
 * left to the route after this function resolves (after commit).
 */
export async function completeRegistration(
  input: RegistrationChallengeCapability & { password: string },
  executor: RegistrationChallengeExecutor = db,
): Promise<CompleteRegistrationResult> {
  if (!isPasswordValidForRegistration(input.password)) throw new RegistrationPasswordError();

  const run = async (tx: RegistrationChallengeExecutor): Promise<CompleteRegistrationResult> => {
    const candidate = await getRegistrationChallengeForSession(
      input.bindingSecret,
      input.challengeId,
      input.organizationId,
      tx,
    );
    if (!candidate) throw new RegistrationChallengeError("NOT_FOUND");
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.email})) = ${candidate.email}`)
      .for("update");
    if (existing) throw new RegistrationExistingAccountError(candidate.email);

    const challenge = await consumeRegistrationChallenge({
      challengeId: input.challengeId,
      bindingSecret: input.bindingSecret,
      organizationId: input.organizationId,
    }, tx);
    let created: User | undefined;
    try {
      [created] = await tx
        .insert(users)
        .values({
          email: challenge.email,
          name: challenge.name,
          phone: challenge.phone,
          password: await hashPassword(input.password),
          role: "user",
          organizationId: challenge.organizationId,
          bowlerId: null,
        })
        .returning();
    } catch (error) {
      // The pre-insert lookup closes the ordinary path, while the database
      // unique index closes the race where another request claims the email
      // between that lookup and this insert. Convert only the two known user
      // email conflicts so unrelated failures still roll back and surface as
      // server errors.
      if (isNormalizedUserEmailConflict(error)) {
        throw new RegistrationExistingAccountError(challenge.email);
      }
      throw error;
    }
    if (!created) throw new Error("Failed to create registration user");
    await recordRegistrationVerificationProvenance({
      userId: created.id,
      organizationId: challenge.organizationId,
      email: challenge.email,
      phone: challenge.phone,
    }, tx);

    let linked = false;
    const matchingProfiles = await tx
      .select({ id: bowlers.id })
      .from(bowlers)
      .where(and(
        eq(bowlers.organizationId, challenge.organizationId),
        sql`lower(btrim(${bowlers.email})) = ${challenge.email}`,
      ))
      .limit(2);
    if (matchingProfiles.length === 1) {
      try {
        await linkUserToBowler({
          organizationId: challenge.organizationId,
          userId: created.id,
          bowlerId: matchingProfiles[0].id,
          actorUserId: created.id,
          source: "auth.registration.sms_otp",
          reason: "verified_phone_registration_email_match",
          eventType: "link",
          requireEmailMatch: true,
        }, tx);
        linked = true;
      } catch (error) {
        // Identity-link deliberately rejects races, duplicate email profiles,
        // and an already-claimed bowler. Registration still succeeds; the
        // account remains available for an administrator claim flow.
        if (!isIdentityLinkError(error)
          || !["BOWLER_TAKEN", "ALREADY_LINKED", "EMAIL_MISMATCH"].includes(error.code)) {
          throw error;
        }
      }
    }
    await redactRegistrationChallengePii(challenge.id, tx);
    return { user: created, linked, challenge };
  };

  const result = executor === db ? await db.transaction(run) : await run(executor);
  cacheInvalidate(`user:${result.user.id}`);
  if (result.linked) {
    cacheInvalidate("bowlers:");
    notifyPaymentSyncRetryChanged();
  }
  return result;
}

// Keep a type-level reference in this module so callers can narrow challenge
// storage errors without importing implementation details from routes.
export type RegistrationChallengeStorageError = RegistrationChallengeError;
