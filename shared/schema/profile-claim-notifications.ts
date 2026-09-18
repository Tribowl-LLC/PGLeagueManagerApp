import { sql } from "drizzle-orm";
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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { identityLinkEvents } from "./identity-link-events";
import { users } from "./users";
import { bowlers } from "./bowlers";
import { organizations } from "./organizations";

export const PROFILE_CLAIM_NOTIFICATION_STATUSES = [
  "pending",
  "processing",
  "retry_scheduled",
  "succeeded",
  "failed",
  "suppressed",
] as const;
export type ProfileClaimNotificationStatus =
  (typeof PROFILE_CLAIM_NOTIFICATION_STATUSES)[number];

export const PROFILE_CLAIM_RECIPIENT_SOURCES = ["roster", "account_fallback"] as const;
export type ProfileClaimRecipientSource = (typeof PROFILE_CLAIM_RECIPIENT_SOURCES)[number];

export const PROFILE_CLAIM_REPORT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS = 4;
export const PROFILE_CLAIM_NOTIFICATION_LEASE_MS = 60_000;
export const PROFILE_CLAIM_NOTIFICATION_MAX_RETRY_DELAY_MS = 10 * 60_000;
export const PROFILE_CLAIM_NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A durable, non-credential notice created by the identity-link transaction.
 * The recipient address is an immutable snapshot: it is deliberately not
 * re-read from the user or bowler after contact backfill or later email edits.
 */
export const profileClaimNotifications = pgTable("profile_claim_notifications", {
  id: serial("id").primaryKey(),
  identityLinkEventId: integer("identity_link_event_id")
    .notNull()
    .references(() => identityLinkEvents.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  bowlerId: integer("bowler_id").references(() => bowlers.id, { onDelete: "set null" }),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  recipientEmail: text("recipient_email").notNull(),
  recipientSource: text("recipient_source").notNull(),
  recipientName: text("recipient_name").notNull(),
  bowlerName: text("bowler_name").notNull(),
  reportTokenHash: text("report_token_hash").notNull(),
  reportTokenExpiresAt: timestamp("report_token_expires_at", { mode: "string" }).notNull(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { mode: "string" }),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  completedAt: timestamp("completed_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  identityLinkEventUnique: uniqueIndex("profile_claim_notifications_event_unique")
    .on(table.identityLinkEventId),
  reportTokenHashUnique: uniqueIndex("profile_claim_notifications_report_token_hash_unique")
    .on(table.reportTokenHash),
  statusDueIdx: index("profile_claim_notifications_status_due_idx")
    .on(table.status, table.nextAttemptAt, table.createdAt),
  userIdx: index("profile_claim_notifications_user_idx").on(table.userId),
  bowlerIdx: index("profile_claim_notifications_bowler_idx").on(table.bowlerId),
  statusCheck: check(
    "profile_claim_notifications_status_check",
    sql`${table.status} IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')`,
  ),
  recipientSourceCheck: check(
    "profile_claim_notifications_recipient_source_check",
    sql`${table.recipientSource} IN ('roster', 'account_fallback')`,
  ),
  attemptCheck: check(
    "profile_claim_notifications_attempt_check",
    sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 4`,
  ),
  lifecycleCheck: check(
    "profile_claim_notifications_lifecycle_check",
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

export const profileClaimReportTokens = pgTable("profile_claim_report_tokens", {
  id: serial("id").primaryKey(),
  notificationId: integer("notification_id")
    .notNull()
    .references(() => profileClaimNotifications.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  usedAt: timestamp("used_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  notificationUnique: uniqueIndex("profile_claim_report_tokens_notification_unique")
    .on(table.notificationId),
  tokenHashUnique: uniqueIndex("profile_claim_report_tokens_hash_unique")
    .on(table.tokenHash),
  notificationIdx: index("profile_claim_report_tokens_notification_idx").on(table.notificationId),
}));

export const IDENTITY_SECURITY_HOLD_STATUSES = ["active", "resolved", "rejected"] as const;
export type IdentitySecurityHoldStatus = (typeof IDENTITY_SECURITY_HOLD_STATUSES)[number];

/** A hold is also the durable audit record for an anonymous report. */
export const identitySecurityHolds = pgTable("identity_security_holds", {
  id: serial("id").primaryKey(),
  notificationId: integer("notification_id")
    .notNull()
    .references(() => profileClaimNotifications.id, { onDelete: "restrict" }),
  reportTokenId: integer("report_token_id")
    .notNull()
    .references(() => profileClaimReportTokens.id, { onDelete: "restrict" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  bowlerId: integer("bowler_id").references(() => bowlers.id, { onDelete: "set null" }),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"),
  reason: text("reason"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  resolution: text("resolution"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { mode: "string" }),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  notificationUnique: uniqueIndex("identity_security_holds_notification_unique").on(table.notificationId),
  activeUserUnique: uniqueIndex("identity_security_holds_active_user_unique")
    .on(table.userId)
    .where(sql`${table.status} = 'active'`),
  statusIdx: index("identity_security_holds_status_idx").on(table.status, table.createdAt),
  userIdx: index("identity_security_holds_user_idx").on(table.userId),
  statusCheck: check(
    "identity_security_holds_status_check",
    sql`${table.status} IN ('active', 'resolved', 'rejected')`,
  ),
}));

export const insertProfileClaimNotificationSchema = createInsertSchema(profileClaimNotifications)
  .extend({
    identityLinkEventId: z.number().int().positive(),
    userId: z.number().int().positive().nullable().optional(),
    bowlerId: z.number().int().positive().nullable().optional(),
    organizationId: z.number().int().positive(),
    recipientEmail: z.string().email(),
    recipientSource: z.enum(PROFILE_CLAIM_RECIPIENT_SOURCES),
    reportTokenHash: z.string().length(64),
    reportTokenExpiresAt: z.union([z.string(), z.date()]).transform((value) =>
      typeof value === "string" ? value : value.toISOString(),
    ),
  })
  .omit({
    id: true,
    status: true,
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

export type ProfileClaimNotification = typeof profileClaimNotifications.$inferSelect;
export type InsertProfileClaimNotification = z.infer<typeof insertProfileClaimNotificationSchema>;
export type ProfileClaimReportToken = typeof profileClaimReportTokens.$inferSelect;
export type IdentitySecurityHold = typeof identitySecurityHolds.$inferSelect;
