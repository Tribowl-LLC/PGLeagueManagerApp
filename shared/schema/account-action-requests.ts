import { pgTable, text, serial, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";
import { organizations } from "./organizations";

/**
 * Short-lived bearer credentials used by onboarding and password recovery.
 * The raw token is intentionally not a column: callers receive it only from
 * `issueAccountAction`, while this table stores its SHA-256 digest.
 */
export const ACCOUNT_ACTION_TYPES = ["account_invite", "password_reset"] as const;
export type AccountActionType = (typeof ACCOUNT_ACTION_TYPES)[number];

export const ACCOUNT_ACTION_STATUSES = ["pending", "consumed", "superseded", "revoked", "expired"] as const;
export type AccountActionStatus = (typeof ACCOUNT_ACTION_STATUSES)[number];

export const ACCOUNT_ACTION_DELIVERY_STATUSES = ["not_attempted", "sent", "failed"] as const;
export type AccountActionDeliveryStatus = (typeof ACCOUNT_ACTION_DELIVERY_STATUSES)[number];

export const accountActionRequests = pgTable("account_action_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Tenant context is snapshotted at issuance so audit/operations tooling
  // retains the originating scope even if the user later moves orgs.
  organizationId: integer("organization_id")
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  action: text("action", { enum: ACCOUNT_ACTION_TYPES }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  status: text("status", { enum: ACCOUNT_ACTION_STATUSES }).notNull().default("pending"),
  deliveryStatus: text("delivery_status", { enum: ACCOUNT_ACTION_DELIVERY_STATUSES })
    .notNull()
    .default("not_attempted"),
  deliveryAttemptedAt: timestamp("delivery_attempted_at", { mode: "string" }),
  deliveredAt: timestamp("delivered_at", { mode: "string" }),
  consumedAt: timestamp("consumed_at", { mode: "string" }),
  supersededAt: timestamp("superseded_at", { mode: "string" }),
  revokedAt: timestamp("revoked_at", { mode: "string" }),
  expiredAt: timestamp("expired_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index("account_action_requests_user_idx").on(table.userId),
  pendingUserActionUnique: uniqueIndex("account_action_requests_pending_user_action_unique")
    .on(table.userId, table.action)
    .where(sql`${table.status} = 'pending'`),
  actionCheck: check(
    "account_action_requests_action_check",
    sql`${table.action} IN ('account_invite', 'password_reset')`,
  ),
  statusCheck: check(
    "account_action_requests_status_check",
    sql`${table.status} IN ('pending', 'consumed', 'superseded', 'revoked', 'expired')`,
  ),
  deliveryStatusCheck: check(
    "account_action_requests_delivery_status_check",
    sql`${table.deliveryStatus} IN ('not_attempted', 'sent', 'failed')`,
  ),
  lifecycleCheck: check(
    "account_action_requests_lifecycle_check",
    sql`(
      ${table.status} = 'pending'
      AND ${table.consumedAt} IS NULL
      AND ${table.supersededAt} IS NULL
      AND ${table.revokedAt} IS NULL
      AND ${table.expiredAt} IS NULL
    ) OR (
      ${table.status} = 'consumed'
      AND ${table.consumedAt} IS NOT NULL
      AND ${table.supersededAt} IS NULL
      AND ${table.revokedAt} IS NULL
      AND ${table.expiredAt} IS NULL
    ) OR (
      ${table.status} = 'superseded'
      AND ${table.consumedAt} IS NULL
      AND ${table.supersededAt} IS NOT NULL
      AND ${table.revokedAt} IS NULL
      AND ${table.expiredAt} IS NULL
    ) OR (
      ${table.status} = 'revoked'
      AND ${table.consumedAt} IS NULL
      AND ${table.supersededAt} IS NULL
      AND ${table.revokedAt} IS NOT NULL
      AND ${table.expiredAt} IS NULL
    ) OR (
      ${table.status} = 'expired'
      AND ${table.consumedAt} IS NULL
      AND ${table.supersededAt} IS NULL
      AND ${table.revokedAt} IS NULL
      AND ${table.expiredAt} IS NOT NULL
    )`,
  ),
  deliveryTimestampCheck: check(
    "account_action_requests_delivery_timestamp_check",
    sql`${table.deliveryStatus} <> 'sent' OR ${table.deliveredAt} IS NOT NULL`,
  ),
}));

const baseInsertSchema = createInsertSchema(accountActionRequests);

// Internal callers should use the storage issue helper, which generates and
// hashes the token. This schema is retained for typed DB fixtures/migrations
// and deliberately does not expose a raw-token field.
export const insertAccountActionRequestSchema = baseInsertSchema
  .extend({
    action: z.enum(ACCOUNT_ACTION_TYPES),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    organizationId: z.number().int().positive().nullable().optional(),
    createdByUserId: z.number().int().positive().nullable().optional(),
    expiresAt: z.union([z.string(), z.date()]).transform((value) =>
      typeof value === "string" ? value : value.toISOString(),
    ),
    status: z.enum(ACCOUNT_ACTION_STATUSES).optional().default("pending"),
    deliveryStatus: z.enum(ACCOUNT_ACTION_DELIVERY_STATUSES).optional().default("not_attempted"),
  })
  .omit({
    id: true,
    createdAt: true,
    deliveryAttemptedAt: true,
    deliveredAt: true,
    consumedAt: true,
    supersededAt: true,
    revokedAt: true,
    expiredAt: true,
  });

export type AccountActionRequest = typeof accountActionRequests.$inferSelect;
export type InsertAccountActionRequest = z.infer<typeof insertAccountActionRequestSchema>;
