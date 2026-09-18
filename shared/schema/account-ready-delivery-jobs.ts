import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { bowlers } from "./bowlers";
import { identityLinkEvents } from "./identity-link-events";
import { organizations } from "./organizations";
import { users } from "./users";

/** Durable, noncredential delivery intent for the automatic account-ready email. */
export const ACCOUNT_READY_DELIVERY_JOB_STATUSES = [
  "pending",
  "processing",
  "retry_scheduled",
  "succeeded",
  "failed",
  "suppressed",
] as const;
export type AccountReadyDeliveryJobStatus =
  (typeof ACCOUNT_READY_DELIVERY_JOB_STATUSES)[number];

export const ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS = 4;
export const ACCOUNT_READY_DELIVERY_LEASE_MS = 60_000;
export const ACCOUNT_READY_DELIVERY_PROVIDER_TIMEOUT_MS = 30_000;
export const ACCOUNT_READY_DELIVERY_MAX_RETRY_DELAY_MS = 10 * 60_000;
export const ACCOUNT_READY_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ACCOUNT_READY_DELIVERY_CLEANUP_BATCH_SIZE = 500;

export const accountReadyDeliveryJobs = pgTable("account_ready_delivery_jobs", {
  id: serial("id").primaryKey(),
  identityLinkEventId: integer("identity_link_event_id")
    .notNull()
    .references(() => identityLinkEvents.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bowlerId: integer("bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: text("status", { enum: ACCOUNT_READY_DELIVERY_JOB_STATUSES })
    .notNull()
    .default("pending"),
  // Explicit administrator resends must remain standalone even when the
  // profile-claim notice targets the same mailbox.  This durable flag keeps
  // that intent across worker restarts and retry scheduling.
  standaloneDeliveryRequested: boolean("standalone_delivery_requested")
    .notNull()
    .default(false),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { mode: "string" }),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  identityLinkEventUnique: uniqueIndex("account_ready_delivery_jobs_identity_link_event_unique")
    .on(table.identityLinkEventId),
  statusDueIdx: index("account_ready_delivery_jobs_status_due_idx")
    .on(table.status, table.nextAttemptAt, table.createdAt),
  userIdx: index("account_ready_delivery_jobs_user_idx").on(table.userId),
  bowlerIdx: index("account_ready_delivery_jobs_bowler_idx").on(table.bowlerId),
  statusCheck: check(
    "account_ready_delivery_jobs_status_check",
    sql`${table.status} IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')`,
  ),
  attemptCheck: check(
    "account_ready_delivery_jobs_attempt_check",
    sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 4`,
  ),
  lifecycleCheck: check(
    "account_ready_delivery_jobs_lifecycle_check",
    sql`(
      ${table.status} IN ('pending', 'retry_scheduled')
      AND ${table.completedAt} IS NULL
      AND ${table.leaseOwner} IS NULL
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
    ) OR (
      ${table.status} = 'processing'
      AND ${table.completedAt} IS NULL
      AND ${table.leaseOwner} IS NOT NULL
      AND ${table.leaseToken} IS NOT NULL
      AND ${table.leaseExpiresAt} IS NOT NULL
    ) OR (
      ${table.status} IN ('succeeded', 'failed', 'suppressed')
      AND ${table.completedAt} IS NOT NULL
      AND ${table.leaseOwner} IS NULL
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
    )`,
  ),
}));

export const insertAccountReadyDeliveryJobSchema = createInsertSchema(accountReadyDeliveryJobs)
  .extend({
    identityLinkEventId: z.number().int().positive(),
    userId: z.number().int().positive(),
    bowlerId: z.number().int().positive(),
    organizationId: z.number().int().positive(),
    expiresAt: z.union([z.string(), z.date()]).transform((value) =>
      typeof value === "string" ? value : value.toISOString(),
    ),
  })
  .omit({
    id: true,
    status: true,
    standaloneDeliveryRequested: true,
    attemptCount: true,
    nextAttemptAt: true,
    lastAttemptAt: true,
    leaseOwner: true,
    leaseToken: true,
    leaseExpiresAt: true,
    providerMessageId: true,
    lastErrorCode: true,
    completedAt: true,
    createdAt: true,
    updatedAt: true,
  });

export type AccountReadyDeliveryJob = typeof accountReadyDeliveryJobs.$inferSelect;
export type InsertAccountReadyDeliveryJob = z.infer<typeof insertAccountReadyDeliveryJobSchema>;
