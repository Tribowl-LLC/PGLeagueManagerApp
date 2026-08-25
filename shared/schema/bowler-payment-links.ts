import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { bowlers } from "./bowlers";
import { users } from "./users";
import { organizations } from "./organizations";

/**
 * Adult bowler payment-link table.
 *
 * Two adult bowlers in the same organization can link as "payment
 * partners" so either may pay on the other's behalf using their own
 * saved card / wallet. Rows are stored canonically with
 * `bowlerAId < bowlerBId` so a unique-pair constraint is symmetric.
 *
 * Lifecycle:
 *   - pending  → created by an invite (createdByUserId = inviter's user id)
 *   - accepted → invitee accepts; respondedAt is set
 *   - admin direct-link inserts an already-accepted row
 *
 * organizationId is required (NOT NULL) to keep the multi-tenant
 * org-less data policy honored: any access-control helper denies rows
 * with NULL organizationId, even for system_admin.
 */
export const LINK_STATUSES = ["pending", "accepted"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const bowlerPaymentLinks = pgTable(
  "bowler_payment_links",
  {
    id: serial("id").primaryKey(),
    bowlerAId: integer("bowler_a_id")
      .notNull()
      .references(() => bowlers.id, { onDelete: "cascade" }),
    bowlerBId: integer("bowler_b_id")
      .notNull()
      .references(() => bowlers.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status", { enum: LINK_STATUSES }).notNull().default("pending"),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    invitedAt: timestamp("invited_at", { mode: "string" }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { mode: "string" }),
  },
  (table) => ({
    pairUnique: uniqueIndex("bowler_payment_links_pair_unique_idx").on(
      table.bowlerAId,
      table.bowlerBId,
    ),
    tenantIdentityUnique: uniqueIndex("bowler_payment_links_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    bowlerAIdx: index("bowler_payment_links_a_idx").on(table.bowlerAId),
    bowlerBIdx: index("bowler_payment_links_b_idx").on(table.bowlerBId),
    organizationIdx: index("bowler_payment_links_org_idx").on(table.organizationId),
  }),
);

export const insertBowlerPaymentLinkSchema = createInsertSchema(bowlerPaymentLinks)
  .extend({
    bowlerAId: z.number().int().positive(),
    bowlerBId: z.number().int().positive(),
    organizationId: z.number().int().positive(),
    status: z.enum(LINK_STATUSES).default("pending"),
    createdByUserId: z.number().int().positive().nullable().optional(),
  })
  .omit({ id: true, invitedAt: true, respondedAt: true });

export type BowlerPaymentLink = typeof bowlerPaymentLinks.$inferSelect;
export type InsertBowlerPaymentLink = z.infer<typeof insertBowlerPaymentLinkSchema>;
