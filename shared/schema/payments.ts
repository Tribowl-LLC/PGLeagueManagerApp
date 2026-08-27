import { pgTable, text, serial, integer, boolean, timestamp, index, uniqueIndex, uuid, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { PAYMENT_STATUSES, PAYMENT_TYPES, positiveIntSchema, dateSchema } from "./constants";
import { bowlers } from "./bowlers";
import { leagues } from "./leagues";
import { users } from "./users";
import { organizations } from "./organizations";
import { paymentOperations } from "./payment-operations";

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  bowlerId: integer("bowler_id")
    .notNull(),
  leagueId: integer("league_id")
    .notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status", { enum: PAYMENT_STATUSES }).notNull().default('paid'),
  type: text("type", { enum: PAYMENT_TYPES }).notNull(),
  checkNumber: text("check_number"),
  providerPaymentId: text("provider_payment_id"),
  idempotencyKey: text("idempotency_key").unique(),
  squareRefundId: text("square_refund_id"),
  refundReason: text("refund_reason"),
  refundedAt: timestamp("refunded_at", { mode: "string" }),
  // Provider-side dispute / chargeback identifier.
  // so the admin UI can correlate the row back to the dispute on the
  // provider dashboard. Distinct from `squareRefundId` because a
  // dispute and a refund are independent provider artifacts.
  disputeId: text("dispute_id"),
  // Wall-clock timestamp the dispute webhook was processed. Renders
  // alongside `refundedAt` in the payment-history timeline.
  disputedAt: timestamp("disputed_at", { mode: "string" }),
  // Square auto-emails a hosted receipt to `buyerEmailAddress` whenever a
  // CreatePayment / RefundPayment includes one. We persist the URL +
  // human-readable receipt number Square returns so we can render a
  // "View receipt" link in the UI without a second API round-trip, and
  // so Resend Receipt has something concrete to email out.
  receiptUrl: text("receipt_url"),
  receiptNumber: text("receipt_number"),
  // True when a paid card row was created without a buyer email — i.e.
  // Square never auto-emailed the bowler a receipt at charge time.
  // Surfaces as a "no receipt sent" badge in admin UI + as a notice on
  // the refund dialog (refunds inherit the original payment's email).
  receiptEmailMissing: boolean("receipt_email_missing").notNull().default(false),
  notes: text("notes"),
  // Records the user.id of the human who initiated the charge when an
  // adult bowler pays on behalf of a linked payment partner. NULL for
  // legacy / admin-entered / webhook-driven rows.
  paidByUserId: integer("paid_by_user_id").references(() => users.id, { onDelete: 'set null' }),
  // One payment row is one real tender/provider transaction. A successful
  // roster operation links to exactly one parent; its child obligations are
  // recorded in payment_allocations.
  paymentOperationId: uuid("payment_operation_id"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  idBowlerLeagueUnique: uniqueIndex("payments_id_bowler_league_unique")
    .on(table.id, table.bowlerId, table.leagueId),
  idLeagueUnique: uniqueIndex("payments_id_league_unique")
    .on(table.id, table.leagueId),
  tenantIdentityUnique: uniqueIndex("payments_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  leagueTenantFk: foreignKey({
    name: "payments_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "payments_bowler_tenant_fk",
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  bowlerIdx: index("payments_bowler_idx").on(table.bowlerId),
  leagueIdx: index("payments_league_idx").on(table.leagueId),
  paidByUserIdx: index("payments_paid_by_user_idx").on(table.paidByUserId),
  paymentOperationUnique: uniqueIndex("payments_operation_unique")
    .on(table.paymentOperationId)
    .where(sql`${table.paymentOperationId} IS NOT NULL`),
  paymentOperationTenantFk: foreignKey({
    name: "payments_payment_operation_tenant_fk",
    columns: [table.paymentOperationId, table.organizationId, table.leagueId],
    foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId],
  }).onDelete("restrict"),
  amountCheck: check("payments_amount_check", sql`${table.amount} > 0`),
  currencyCheck: check("payments_currency_check", sql`${table.currency} = 'USD'`),
}));

const basePaymentSchema = createInsertSchema(payments);

export const insertPaymentSchema = basePaymentSchema.extend({
  bowlerId: positiveIntSchema,
  leagueId: positiveIntSchema,
  amount: positiveIntSchema,
  currency: z.literal("USD").default("USD"),
  status: z.enum(PAYMENT_STATUSES).default("paid"),
  type: z.enum(PAYMENT_TYPES),
  checkNumber: z.string().optional(),
  providerPaymentId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  receiptUrl: z.string().optional(),
  receiptNumber: z.string().optional(),
  receiptEmailMissing: z.boolean().optional().default(false),
  notes: z.string().optional(),
  storeCard: z.boolean().optional(),
  paidByUserId: z.number().int().positive().nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  organizationId: true,
  // Operation linkage is an internal, token-fenced finalization concern and
  // must never be accepted from ordinary payment API payloads.
  paymentOperationId: true,
});

export const updatePaymentSchema = z.object({
  amount: positiveIntSchema,
  status: z.enum(PAYMENT_STATUSES),
  type: z.enum(PAYMENT_TYPES),
  checkNumber: z.string().nullable(),
  providerPaymentId: z.string().nullable(),
  squareRefundId: z.string().nullable(),
  refundReason: z.string().nullable(),
  refundedAt: dateSchema.nullable(),
  disputeId: z.string().nullable(),
  disputedAt: dateSchema.nullable(),
  receiptUrl: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  receiptEmailMissing: z.boolean(),
  notes: z.string().nullable(),
  paidByUserId: z.number().int().positive().nullable(),
}).partial();

export type Payment = typeof payments.$inferSelect;
export type InsertPaymentInput = z.input<typeof insertPaymentSchema>;
export type InsertPayment = z.output<typeof insertPaymentSchema>;
export type UpdatePayment = z.infer<typeof updatePaymentSchema>;
