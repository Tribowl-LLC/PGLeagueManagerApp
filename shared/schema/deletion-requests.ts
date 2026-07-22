import { pgTable, text, serial, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { emailSchema } from "./constants";
import { users } from "./users";

export const DELETION_REQUEST_STATUSES = ["pending", "completed", "rejected"] as const;
export type DeletionRequestStatus = typeof DELETION_REQUEST_STATUSES[number];

export const deletionRequests = pgTable("deletion_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  status: text("status").notNull().default("pending"),
  adminNote: text("admin_note"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { mode: "string" }),
  // JSON-serialized audit summary of the automated account-data deletion
  // performed when an admin executes the request (see
  // server/services/account-deletion.ts). Null until execution runs.
  executionSummary: text("execution_summary"),
  // Task #349: when false, `executeAccountDeletion` will NOT send the
  // SendGrid post-deletion confirmation email to the requester (e.g.
  // for harassment victims who do not want any further contact at the
  // address being scrubbed, or jurisdictions that disallow follow-up
  // mail). Defaults to true so requests submitted before the form was
  // updated continue to receive the confirmation email.
  notifyOnCompletion: boolean("notify_on_completion").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("deletion_requests_status_idx").on(table.status),
  emailIdx: index("deletion_requests_email_idx").on(table.email),
  createdAtIdx: index("deletion_requests_created_at_idx").on(table.createdAt),
}));

const baseInsert = createInsertSchema(deletionRequests);
export const insertDeletionRequestSchema = baseInsert.extend({
  email: emailSchema,
  reason: z.string().max(2000).nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  notifyOnCompletion: z.boolean().default(true),
}).omit({ id: true, createdAt: true, status: true, adminNote: true, reviewedBy: true, reviewedAt: true, executionSummary: true });

export const updateDeletionRequestStatusSchema = z.object({
  status: z.enum(["completed", "rejected"]),
  adminNote: z.string().max(2000).nullable().optional(),
});

// Body for POST /api/system-admin/deletion-requests/:id/execute. The
// `confirm` field is a redundant safety token the UI must send so the
// destructive call cannot be made by an accidental empty POST.
export const executeDeletionRequestSchema = z.object({
  confirm: z.literal("DELETE"),
  adminNote: z.string().max(2000).nullable().optional(),
});

export interface DeletionExecutionSummary {
  executedAt: string;
  executedBy: number;
  email: string;
  user: { deleted: boolean; userId: number | null; reason?: string };
  bowlers: Array<{
    bowlerId: number;
    anonymized: boolean;
    hadPaymentCustomerId: boolean;
    reason?: string;
  }>;
  paymentProvider: Array<{
    locationId: number;
    providerName: string;
    customerId: string;
    deleted: boolean;
    error?: string;
  }>;
  emailChangeRequestsDeleted: number;
  // Task #349: outcome of the post-deletion confirmation email so the
  // admin history view can distinguish "user opted out" from "we
  // tried but SendGrid failed" without consulting the server logs.
  // Optional on the type so older audit summaries (written before
  // task #349) parse cleanly — the admin panel falls back to a
  // neutral "unknown" pill in that case.
  confirmationEmail?: {
    // True iff `executeAccountDeletion` actually called sendgrid AND
    // the helper returned true. False covers both "user opted out"
    // and "send attempted but failed"; use `suppressedByUser` and
    // `error` to disambiguate.
    sent: boolean;
    // True when the requester explicitly turned off the confirmation
    // email on the public deletion-request form. When true, no send
    // attempt was made.
    suppressedByUser: boolean;
    // Set when an attempt was made but the helper returned false or
    // threw — captures the SendGrid error for the audit trail.
    error?: string;
  };
}

export type DeletionRequest = typeof deletionRequests.$inferSelect;
export type InsertDeletionRequest = z.infer<typeof insertDeletionRequestSchema>;
export type UpdateDeletionRequestStatus = z.infer<typeof updateDeletionRequestStatusSchema>;
export type ExecuteDeletionRequestInput = z.infer<typeof executeDeletionRequestSchema>;
