import {
  pgTable,
  integer,
  text,
  timestamp,
  index,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * A registration challenge is the durable, server-side state for the
 * anonymous SMS registration flow.  The OTP itself is deliberately absent:
 * Twilio Verify is the authority for both issuing and checking codes.
 */
export const REGISTRATION_VERIFICATION_CHALLENGE_STATUSES = [
  "pending",
  "verified",
  "consumed",
  "expired",
  "replaced",
  "cancelled",
  "failed",
] as const;
export type RegistrationVerificationChallengeStatus =
  (typeof REGISTRATION_VERIFICATION_CHALLENGE_STATUSES)[number];

export const registrationVerificationChallenges = pgTable(
  "registration_verification_challenges",
  {
    /** Opaque capability identifier; never use a sequential browser-visible ID. */
    id: text("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Existing-account reference for the recovery branch; never exposed to the browser. */
    existingUserId: integer("existing_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    /** HMAC(session id), never the raw session identifier. */
    sessionBindingHash: text("session_binding_hash").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    /** Twilio Verify SID; no OTP or provider secret is persisted. */
    providerVerificationSid: text("provider_verification_sid"),
    /** Fencing token for a provider call made outside the DB transaction. */
    operationLeaseToken: text("operation_lease_token"),
    operationLeaseExpiresAt: timestamp("operation_lease_expires_at", { mode: "string" }),
    operationVersion: integer("operation_version").notNull().default(0),
    lastSentAt: timestamp("last_sent_at", { mode: "string" }),
    sendCount: integer("send_count").notNull().default(0),
    verificationAttemptCount: integer("verification_attempt_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    /** The ten-minute window starts when this challenge is first issued. */
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    verifiedAt: timestamp("verified_at", { mode: "string" }),
    /** A verified challenge gets a separate, fifteen-minute setup window. */
    setupExpiresAt: timestamp("setup_expires_at", { mode: "string" }),
    consumedAt: timestamp("consumed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => ({
    sessionBindingIdx: index("registration_verification_challenges_session_idx")
      .on(table.sessionBindingHash, table.createdAt),
    phoneCreatedIdx: index("registration_verification_challenges_phone_created_idx")
      .on(table.phone, table.createdAt),
    organizationStatusIdx: index("registration_verification_challenges_org_status_idx")
      .on(table.organizationId, table.status, table.createdAt),
    existingUserIdx: index("registration_verification_challenges_existing_user_idx")
      .on(table.existingUserId, table.createdAt),
    providerSidUnique: uniqueIndex("registration_verification_challenges_provider_sid_unique")
      .on(table.providerVerificationSid)
      .where(sql`${table.providerVerificationSid} IS NOT NULL`),
    statusCheck: check(
      "registration_verification_challenges_status_check",
      sql`${table.status} IN ('pending', 'verified', 'consumed', 'expired', 'replaced', 'cancelled', 'failed')`,
    ),
    setupExpiryCheck: check(
      "registration_verification_challenges_setup_expiry_check",
      sql`${table.status} <> 'verified' OR ${table.setupExpiresAt} IS NOT NULL`,
    ),
  }),
);

export const insertRegistrationVerificationChallengeSchema = createInsertSchema(
  registrationVerificationChallenges,
).extend({
  status: z.enum(REGISTRATION_VERIFICATION_CHALLENGE_STATUSES).optional(),
  expiresAt: z.union([z.string(), z.date()]).transform((v) =>
    typeof v === "string" ? v : v.toISOString(),
  ),
  verifiedAt: z.union([z.string(), z.date()]).nullable().optional().transform((v) =>
    v instanceof Date ? v.toISOString() : v,
  ),
  setupExpiresAt: z.union([z.string(), z.date()]).nullable().optional().transform((v) =>
    v instanceof Date ? v.toISOString() : v,
  ),
  consumedAt: z.union([z.string(), z.date()]).nullable().optional().transform((v) =>
    v instanceof Date ? v.toISOString() : v,
  ),
}).omit({ id: true, createdAt: true, updatedAt: true });

type RegistrationVerificationChallengeRow =
  typeof registrationVerificationChallenges.$inferSelect;
// The column is additive and older fixtures/rows may not expose it while a
// rolling deployment is in progress. Keep the application-facing type
// tolerant until every writer has been migrated.
export type RegistrationVerificationChallenge = Omit<RegistrationVerificationChallengeRow, "updatedAt"> & {
  updatedAt?: string | null;
};
export type InsertRegistrationVerificationChallenge = z.infer<
  typeof insertRegistrationVerificationChallengeSchema
>;
