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

/** Guidance emails contain no bearer material and do not create credentials. */
export const ACCOUNT_GUIDANCE_NOTICE_TYPES = [
  "account_exists",
  "account_missing",
] as const;
export type AccountGuidanceNoticeType = (typeof ACCOUNT_GUIDANCE_NOTICE_TYPES)[number];

export const ACCOUNT_GUIDANCE_DELIVERY_STATUSES = [
  "pending",
  "processing",
  "retry_scheduled",
  "succeeded",
  "failed",
  "suppressed",
] as const;
export type AccountGuidanceDeliveryStatus = (typeof ACCOUNT_GUIDANCE_DELIVERY_STATUSES)[number];

export const ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS = 4;
export const ACCOUNT_GUIDANCE_DELIVERY_LEASE_MS = 60_000;
export const ACCOUNT_GUIDANCE_DELIVERY_PROVIDER_TIMEOUT_MS = 30_000;
export const ACCOUNT_GUIDANCE_DELIVERY_MAX_RETRY_DELAY_MS = 10 * 60_000;
export const ACCOUNT_GUIDANCE_DELIVERY_COOLDOWN_MS = 5 * 60_000;
export const ACCOUNT_GUIDANCE_DELIVERY_ROLLING_WINDOW_MS = 60 * 60_000;
export const ACCOUNT_GUIDANCE_DELIVERY_ROLLING_CAP = 6;
export const ACCOUNT_GUIDANCE_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ACCOUNT_GUIDANCE_DELIVERY_CLEANUP_BATCH_SIZE = 500;

/**
 * Durable, non-secret account guidance intent. The recipient is retained only
 * long enough to deliver and audit the notice; no reset token or password is
 * stored here. Active rows are unique per normalized recipient so both public
 * endpoints share one cross-tenant cooldown boundary.
 */
export const accountGuidanceDeliveryJobs = pgTable("account_guidance_delivery_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  recipientEmail: text("recipient_email").notNull(),
  noticeType: text("notice_type", { enum: ACCOUNT_GUIDANCE_NOTICE_TYPES }).notNull(),
  organizationId: integer("organization_id")
    .references(() => organizations.id, { onDelete: "set null" }),
  status: text("status", { enum: ACCOUNT_GUIDANCE_DELIVERY_STATUSES })
    .notNull()
    .default("pending"),
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
  statusDueIdx: index("account_guidance_delivery_jobs_status_due_idx")
    .on(table.status, table.nextAttemptAt, table.createdAt),
  recipientIdx: index("account_guidance_delivery_jobs_recipient_idx")
    .on(table.recipientEmail, table.createdAt),
  userIdx: index("account_guidance_delivery_jobs_user_idx").on(table.userId),
  activeRecipientUnique: uniqueIndex("account_guidance_delivery_jobs_active_recipient_unique")
    .on(table.recipientEmail)
    .where(sql`${table.status} IN ('pending', 'processing', 'retry_scheduled')`),
  noticeTypeCheck: check(
    "account_guidance_delivery_jobs_notice_type_check",
    sql`${table.noticeType} IN ('account_exists', 'account_missing')`,
  ),
  statusCheck: check(
    "account_guidance_delivery_jobs_status_check",
    sql`${table.status} IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')`,
  ),
  attemptCheck: check(
    "account_guidance_delivery_jobs_attempt_check",
    sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 4`,
  ),
  lifecycleCheck: check(
    "account_guidance_delivery_jobs_lifecycle_check",
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

export type AccountGuidanceDeliveryJob = typeof accountGuidanceDeliveryJobs.$inferSelect;
export type InsertAccountGuidanceDeliveryJob = typeof accountGuidanceDeliveryJobs.$inferInsert;
