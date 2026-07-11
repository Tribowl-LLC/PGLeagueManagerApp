import { pgTable, serial, integer, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { bowlers } from "./bowlers";
import { payments } from "./payments";

export const REGISTRATION_QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "yes_no",
  "number",
] as const;
export type RegistrationQuestionType = (typeof REGISTRATION_QUESTION_TYPES)[number];

export const REGISTRATION_STATUSES = [
  "pending",
  "paid",
  "free",
  "cancelled",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const leagueRegistrationQuestions = pgTable(
  "league_registration_questions",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    type: text("type", { enum: REGISTRATION_QUESTION_TYPES }).notNull(),
    required: boolean("required").notNull().default(false),
    options: text("options").array().notNull().default(sql`'{}'`),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (table) => ({
    leagueIdx: index("league_reg_questions_league_idx").on(table.leagueId),
  }),
);

export const leagueRegistrations = pgTable(
  "league_registrations",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id),
    bowlerId: integer("bowler_id")
      .notNull()
      .references(() => bowlers.id, { onDelete: "cascade" }),
    paymentId: integer("payment_id").references(() => payments.id, { onDelete: "set null" }),
    status: text("status", { enum: REGISTRATION_STATUSES }).notNull().default("pending"),
    source: text("source").notNull().default("embed"),
    answers: jsonb("answers").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => ({
    leagueIdx: index("league_registrations_league_idx").on(table.leagueId),
    orgIdx: index("league_registrations_org_idx").on(table.organizationId),
    bowlerIdx: index("league_registrations_bowler_idx").on(table.bowlerId),
  }),
);

export const insertRegistrationQuestionSchema = createInsertSchema(leagueRegistrationQuestions)
  .extend({
    leagueId: z.number().int().positive(),
    label: z.string().min(1, "Label is required").max(200),
    type: z.enum(REGISTRATION_QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(100)).default([]),
    displayOrder: z.number().int().min(0).default(0),
  })
  .omit({ id: true });

export const updateRegistrationQuestionSchema = z
  .object({
    label: z.string().min(1).max(200),
    type: z.enum(REGISTRATION_QUESTION_TYPES),
    required: z.boolean(),
    options: z.array(z.string().min(1).max(100)),
    displayOrder: z.number().int().min(0),
  })
  .partial();

export const insertLeagueRegistrationSchema = createInsertSchema(leagueRegistrations)
  .extend({
    leagueId: z.number().int().positive(),
    organizationId: z.number().int().positive(),
    bowlerId: z.number().int().positive(),
    paymentId: z.number().int().positive().nullable().optional(),
    status: z.enum(REGISTRATION_STATUSES).default("pending"),
    source: z.string().default("embed"),
    answers: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .omit({ id: true, createdAt: true });

export type LeagueRegistrationQuestion = typeof leagueRegistrationQuestions.$inferSelect;
export type InsertLeagueRegistrationQuestion = z.infer<typeof insertRegistrationQuestionSchema>;
export type UpdateLeagueRegistrationQuestion = z.infer<typeof updateRegistrationQuestionSchema>;
export type LeagueRegistration = typeof leagueRegistrations.$inferSelect;
export type InsertLeagueRegistration = z.infer<typeof insertLeagueRegistrationSchema>;
