import { pgTable, text, serial, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { emailSchema } from "./constants";
import { users } from "./users";

export const emailChangeRequests = pgTable("email_change_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  newEmail: text("new_email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  /** Strong-flow snapshot/proofs; legacy rows retain nulls and cannot satisfy the new flow. */
  oldEmail: text("old_email"),
  oldEmailTokenHash: text("old_email_token_hash").unique(),
  oldEmailTokenExpiresAt: timestamp("old_email_token_expires_at", { mode: "string" }),
  oldEmailApprovedAt: timestamp("old_email_approved_at", { mode: "string" }),
  newEmailConfirmedAt: timestamp("new_email_confirmed_at", { mode: "string" }),
  reauthenticatedAt: timestamp("reauthenticated_at", { mode: "string" }),
  credentialGeneration: integer("credential_generation"),
  flowVersion: integer("flow_version").notNull().default(1),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { mode: "string" }),
}, (table) => ({
  userIdx: index("email_change_requests_user_idx").on(table.userId),
  oldTokenIdx: index("email_change_requests_old_token_idx").on(table.oldEmailTokenHash),
  flowVersionCheck: check("email_change_requests_flow_version_check", sql`${table.flowVersion} IN (1, 2)`),
}));

export const insertEmailChangeRequestSchema = createInsertSchema(emailChangeRequests)
  .extend({
    newEmail: emailSchema,
    tokenHash: z.string().min(1),
    expiresAt: z.union([z.string(), z.date()]).transform((v) =>
      typeof v === "string" ? v : v.toISOString(),
    ),
  })
  .omit({ id: true, createdAt: true, consumedAt: true });

export type EmailChangeRequest = typeof emailChangeRequests.$inferSelect;
export type InsertEmailChangeRequest = z.infer<typeof insertEmailChangeRequestSchema>;
