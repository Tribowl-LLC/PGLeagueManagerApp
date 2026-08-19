import { pgTable, text, serial, integer, timestamp, index, jsonb, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "./users";
import { bowlers } from "./bowlers";
import { organizations } from "./organizations";

/**
 * Identity-link mutations are intentionally represented as an append-only
 * event stream. The snapshots below are identity-safe: they contain only
 * fields needed to explain which roster row was involved, never email,
 * phone, invite tokens, passwords, or provider credentials.
 */
export const IDENTITY_LINK_EVENT_TYPES = [
  "link",
  "unlink",
  "admin_assignment",
  "replacement",
  "access_cleanup",
] as const;
export type IdentityLinkEventType = (typeof IDENTITY_LINK_EVENT_TYPES)[number];

export interface IdentityLinkBowlerSnapshot {
  id: number;
  name: string;
  organizationId: number;
  active: boolean;
}

export const identityLinkEvents = pgTable("identity_link_events", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  actorUserId: integer("actor_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  // Immutable subject identifier retained even after the live user row is
  // deleted. `userId` remains a nullable FK for convenient joins.
  subjectUserId: integer("subject_user_id").notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "set null" }),
  // `bowlerId` is the primary/current bowler involved in the event. The
  // explicit old/new IDs preserve unlink and replacement semantics without
  // forcing consumers to infer them from the snapshots.
  bowlerId: integer("bowler_id")
    .references(() => bowlers.id, { onDelete: "set null" }),
  oldBowlerId: integer("old_bowler_id")
    .references(() => bowlers.id, { onDelete: "set null" }),
  newBowlerId: integer("new_bowler_id")
    .references(() => bowlers.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  oldBowlerSnapshot: jsonb("old_bowler_snapshot").$type<IdentityLinkBowlerSnapshot | null>(),
  newBowlerSnapshot: jsonb("new_bowler_snapshot").$type<IdentityLinkBowlerSnapshot | null>(),
  reason: text("reason"),
  source: text("source"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationCreatedAtIdx: index("identity_link_events_org_created_at_idx")
    .on(table.organizationId, table.createdAt),
  userIdx: index("identity_link_events_user_idx").on(table.userId),
  subjectUserIdx: index("identity_link_events_subject_user_idx").on(table.subjectUserId),
  bowlerIdx: index("identity_link_events_bowler_idx").on(table.bowlerId),
  eventTypeCheck: check(
    "identity_link_events_event_type_check",
    sql`${table.eventType} IN ('link', 'unlink', 'admin_assignment', 'replacement', 'access_cleanup')`,
  ),
}));

export const insertIdentityLinkEventSchema = createInsertSchema(identityLinkEvents)
  .extend({
    organizationId: z.number().int().positive(),
    actorUserId: z.number().int().positive().nullable().optional(),
    subjectUserId: z.number().int().positive(),
    userId: z.number().int().positive().nullable().optional(),
    bowlerId: z.number().int().positive().nullable().optional(),
    oldBowlerId: z.number().int().positive().nullable().optional(),
    newBowlerId: z.number().int().positive().nullable().optional(),
    eventType: z.enum(IDENTITY_LINK_EVENT_TYPES),
    oldBowlerSnapshot: z.custom<IdentityLinkBowlerSnapshot | null>().nullable().optional(),
    newBowlerSnapshot: z.custom<IdentityLinkBowlerSnapshot | null>().nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
    source: z.string().max(128).nullable().optional(),
  })
  .omit({ id: true, createdAt: true });

export type IdentityLinkEvent = typeof identityLinkEvents.$inferSelect;
export type InsertIdentityLinkEvent = z.infer<typeof insertIdentityLinkEventSchema>;
