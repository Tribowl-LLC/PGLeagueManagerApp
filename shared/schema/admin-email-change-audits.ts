import { pgTable, text, serial, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";
import { emailChangeRequests } from "./email-change-requests";
import { PAYMENT_SYNC_STATUSES } from "./bowlers";

// Audit trail for `PATCH /api/account/profile/:id` when a system_admin
// initiates an email change for *another* user (task #325). Self-serve
// edits (`actorUserId === targetUserId`) do NOT write a row here — the
// PATCH already logs those at INFO and they aren't an after-the-fact
// concern. The row is written in the same DB transaction as the
// `email_change_requests` insert so the two cannot disagree.
//
// Stored emails are masked at the call site (see `maskEmail`) so the
// table never holds the full address — enough context for triage,
// nothing extra to leak. The `sentAt` timestamp matches when the
// confirmation token was issued.
export const adminEmailChangeAudits = pgTable("admin_email_change_audits", {
  id: serial("id").primaryKey(),
  // The system admin who initiated the change. `restrict` so the audit
  // row survives a user-soft-delete; the FK guarantees the admin row
  // existed at the time of the action.
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  // The user whose login email is being rerouted.
  targetUserId: integer("target_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  // Both stored already-masked (e.g. "j***@example.com").
  oldEmailMasked: text("old_email_masked").notNull(),
  newEmailMasked: text("new_email_masked").notNull(),
  /** Required explanation when an administrator waives old-mailbox proof. */
  reason: text("reason"),
  oldMailboxWaived: boolean("old_mailbox_waived").notNull().default(false),
  // Link back to the specific email-change request row this audit was
  // written for (task #487). Lets the `/confirm-email-change` handler
  // update the *exact* audit row when the target user finally clicks
  // the link, instead of guessing by `targetUserId` (which would be
  // ambiguous when an admin supersedes their own pending request with
  // a second one before the first is confirmed). Nullable so older
  // audit rows written before this column existed remain valid;
  // `set null` on delete so a future cleanup of `email_change_requests`
  // (e.g. expiring rows) doesn't cascade-delete audit history.
  emailChangeRequestId: integer("email_change_request_id")
    .references(() => emailChangeRequests.id, { onDelete: "set null" }),
  // Result of the deferred payment-provider sync that runs when the
  // target user confirms the change (task #487). NULL means "target
  // hasn't confirmed yet" or "this row predates the column"; once
  // confirmed it carries one of `PAYMENT_SYNC_STATUSES` so the admin
  // history UI can flag `pending_retry` for manual follow-up.
  postConfirmPaymentSyncStatus: text("post_confirm_payment_sync_status"),
  // When the target user confirmed the change. Mirrors when the
  // `postConfirmPaymentSyncStatus` value was written, so the admin UI
  // can show "Confirmed at ..." next to the badge.
  postConfirmedAt: timestamp("post_confirmed_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("admin_email_change_audits_created_at_idx").on(table.createdAt),
  targetIdx: index("admin_email_change_audits_target_idx").on(table.targetUserId),
  // Lookup index for the confirm handler's UPDATE-by-request-id path.
  emailChangeRequestIdx: index("admin_email_change_audits_request_idx").on(table.emailChangeRequestId),
}));

export const insertAdminEmailChangeAuditSchema = createInsertSchema(adminEmailChangeAudits)
  .extend({
    actorUserId: z.number().int().positive(),
    targetUserId: z.number().int().positive(),
    oldEmailMasked: z.string().min(1),
    newEmailMasked: z.string().min(1),
    reason: z.string().max(500).nullable().optional(),
    oldMailboxWaived: z.boolean().optional(),
    // Optional + nullable — the helper passes it for newly-written
    // rows; the column also tolerates null for legacy rows.
    emailChangeRequestId: z.number().int().positive().nullable().optional(),
    // Defensive enum guard so a stray string can never sneak into the
    // column from an in-process caller. The column is also writable
    // by the `/confirm-email-change` UPDATE path, which already
    // narrows to `PaymentSyncStatus` at the call site.
    postConfirmPaymentSyncStatus: z.enum(PAYMENT_SYNC_STATUSES).nullable().optional(),
  })
  .omit({ id: true, createdAt: true, postConfirmedAt: true });

export type AdminEmailChangeAudit = typeof adminEmailChangeAudits.$inferSelect;
export type InsertAdminEmailChangeAudit = z.infer<typeof insertAdminEmailChangeAuditSchema>;
