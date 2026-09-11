import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { organizations } from "./organizations";
import { accountActionRequests } from "./account-action-requests";

/** Durable states for the account-action delivery intent queue. */
export const ACCOUNT_ACTION_DELIVERY_JOB_STATUSES = [
  "pending",
  "processing",
  "retry_scheduled",
  "succeeded",
  "failed",
  "suppressed",
] as const;
export type AccountActionDeliveryJobStatus =
  (typeof ACCOUNT_ACTION_DELIVERY_JOB_STATUSES)[number];

/** A provider call is never retried forever. */
export const ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS = 4;
/** Lease is longer than the finite provider-call timeout in the worker. */
export const ACCOUNT_ACTION_DELIVERY_LEASE_MS = 60_000;
export const ACCOUNT_ACTION_DELIVERY_PROVIDER_TIMEOUT_MS = 30_000;
export const ACCOUNT_ACTION_DELIVERY_MAX_RETRY_DELAY_MS = 10 * 60_000;

/**
 * A non-secret intent to deliver a recovery action. This table intentionally
 * contains no recipient address and no bearer material. The worker resolves
 * the current user/email immediately before creating the action token.
 */
export const accountActionDeliveryJobs = pgTable("account_action_delivery_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id")
    .references(() => organizations.id, { onDelete: "cascade" }),
  action: text("action", { enum: ["password_reset", "account_registration"] }).notNull().default("password_reset"),
  /** Snapshot taken when the public request enqueues the intent. */
  credentialGeneration: integer("credential_generation").notNull().default(0),
  /** Recovery intents must not mint a link after their original one-hour window. */
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  status: text("status", { enum: ACCOUNT_ACTION_DELIVERY_JOB_STATUSES })
    .notNull()
    .default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { mode: "string" }),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  /** Most recently dispatched action, if a token was created. */
  actionRequestId: integer("action_request_id")
    .references(() => accountActionRequests.id, { onDelete: "set null" }),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  completedAt: timestamp("completed_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  statusDueIdx: index("account_action_delivery_jobs_status_due_idx")
    .on(table.status, table.nextAttemptAt, table.createdAt),
  userIdx: index("account_action_delivery_jobs_user_idx").on(table.userId),
  actionRequestIdx: index("account_action_delivery_jobs_action_request_idx")
    .on(table.actionRequestId),
  activeUserActionUnique: uniqueIndex("account_action_delivery_jobs_active_user_action_unique")
    .on(table.userId, table.action)
    .where(sql`${table.status} IN ('pending', 'processing', 'retry_scheduled')`),
  actionCheck: check(
    "account_action_delivery_jobs_action_check",
    sql`${table.action} IN ('password_reset', 'account_registration')`,
  ),
  statusCheck: check(
    "account_action_delivery_jobs_status_check",
    sql`${table.status} IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')`,
  ),
  attemptCheck: check(
    "account_action_delivery_jobs_attempt_check",
    // Keep the bound as a literal: Drizzle's migration generator cannot
    // serialize a parameter placeholder inside a CHECK constraint.
    sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 4`,
  ),
  lifecycleCheck: check(
    "account_action_delivery_jobs_lifecycle_check",
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

export type AccountActionDeliveryJob = typeof accountActionDeliveryJobs.$inferSelect;
export type InsertAccountActionDeliveryJob = typeof accountActionDeliveryJobs.$inferInsert;
