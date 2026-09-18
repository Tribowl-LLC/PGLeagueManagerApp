import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { normalizeAccountEmail } from "../storage/users.js";
import { userVerificationProvenance, type UserVerificationProvenance } from "@shared/schema";

export type VerificationProvenanceExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getUserVerificationProvenance(
  userId: number,
  executor: VerificationProvenanceExecutor = db,
): Promise<UserVerificationProvenance | undefined> {
  const [row] = await executor.select().from(userVerificationProvenance)
    .where(eq(userVerificationProvenance.userId, userId)).limit(1);
  return row;
}

export async function recordRegistrationVerificationProvenance(input: {
  userId: number;
  organizationId: number;
  email: string;
  phone: string;
}, executor: VerificationProvenanceExecutor): Promise<UserVerificationProvenance> {
  const [row] = await executor.insert(userVerificationProvenance).values({
    userId: input.userId,
    organizationId: input.organizationId,
    email: normalizeAccountEmail(input.email),
    emailStatus: "unknown",
    phone: input.phone,
    phoneVerifiedAt: new Date().toISOString(),
    phoneVerificationSource: "registration.sms_otp",
  }).returning();
  if (!row) throw new Error("Failed to record registration verification provenance");
  return row;
}

export async function markEmailProvenanceVerified(input: {
  userId: number;
  organizationId: number;
  oldEmail: string;
  newEmail: string;
  source: string;
}, executor: VerificationProvenanceExecutor): Promise<UserVerificationProvenance> {
  const normalizedOld = normalizeAccountEmail(input.oldEmail);
  const normalizedNew = normalizeAccountEmail(input.newEmail);
  const existing = await getUserVerificationProvenance(input.userId, executor);
  if (existing && normalizeAccountEmail(existing.email) !== normalizedOld) {
    throw new Error("Email verification provenance is stale");
  }
  if (existing) {
    const [updated] = await executor.update(userVerificationProvenance).set({
      email: normalizedNew,
      emailStatus: "verified",
      emailVerifiedAt: new Date().toISOString(),
      emailVerificationSource: input.source,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(userVerificationProvenance.userId, input.userId),
      eq(userVerificationProvenance.organizationId, input.organizationId),
      eq(userVerificationProvenance.email, normalizedOld),
    )).returning();
    if (!updated) throw new Error("Failed to update email verification provenance");
    return updated;
  }
  const [created] = await executor.insert(userVerificationProvenance).values({
    userId: input.userId,
    organizationId: input.organizationId,
    email: normalizedNew,
    emailStatus: "verified",
    emailVerifiedAt: new Date().toISOString(),
    emailVerificationSource: input.source,
  }).returning();
  if (!created) throw new Error("Failed to create email verification provenance");
  return created;
}

/** A later phone edit must not inherit proof of the phone used at signup. */
export async function resetPhoneVerificationProvenance(input: {
  userId: number;
  phone: string | null;
}, executor: VerificationProvenanceExecutor = db): Promise<void> {
  await executor.update(userVerificationProvenance).set({
    phone: input.phone,
    phoneVerifiedAt: null,
    phoneVerificationSource: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(userVerificationProvenance.userId, input.userId));
}
