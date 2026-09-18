import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { organizations } from "./organizations";
import { users } from "./users";

export const EMAIL_VERIFICATION_STATUSES = ["unknown", "verified"] as const;
export type EmailVerificationStatus = (typeof EMAIL_VERIFICATION_STATUSES)[number];

export const userVerificationProvenance = pgTable("user_verification_provenance", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  emailStatus: text("email_status").notNull().default("unknown"),
  emailVerifiedAt: timestamp("email_verified_at", { mode: "string" }),
  emailVerificationSource: text("email_verification_source"),
  phone: text("phone"),
  phoneVerifiedAt: timestamp("phone_verified_at", { mode: "string" }),
  phoneVerificationSource: text("phone_verification_source"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  userUnique: uniqueIndex("user_verification_provenance_user_unique").on(table.userId),
  orgEmailIdx: index("user_verification_provenance_org_email_idx").on(table.organizationId, table.email),
  statusCheck: check("user_verification_provenance_email_status_check", sql`${table.emailStatus} IN ('unknown', 'verified')`),
}));

export const insertUserVerificationProvenanceSchema = createInsertSchema(userVerificationProvenance).extend({
  email: z.string().email(),
  emailStatus: z.enum(EMAIL_VERIFICATION_STATUSES).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type UserVerificationProvenance = typeof userVerificationProvenance.$inferSelect;
export type InsertUserVerificationProvenance = z.infer<typeof insertUserVerificationProvenanceSchema>;
