import { pgTable, text, serial, integer, boolean, timestamp, index, foreignKey, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { positiveIntSchema, dateSchema } from "./constants";
import { leagues } from "./leagues";
import { leagueOccurrences } from "./canonical-occurrences";
import { bowlers } from "./bowlers";
import { teams } from "./teams";

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: 'cascade' }),
  weekNumber: integer("week_number").notNull(),
  gameNumber: integer("game_number").notNull(),
  date: timestamp("date", { mode: "string" }).notNull(),
  occurrenceId: uuid("occurrence_id"),
}, (table) => ({
  leagueGameIdx: index("league_game_idx").on(table.leagueId, table.weekNumber, table.gameNumber),
  dateIdx: index("game_date_idx").on(table.date),
  occurrenceIdx: index("games_occurrence_idx").on(table.occurrenceId),
  occurrenceLeagueFk: foreignKey({
    name: "games_occurrence_league_fk",
    columns: [table.occurrenceId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
}));

export const scores = pgTable("scores", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id")
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  bowlerId: integer("bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: 'cascade' }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  score: integer("score").notNull(),
  handicap: integer("handicap").notNull(),
  average: integer("average").notNull(),
  position: integer("position").notNull(),
  isVacant: boolean("is_vacant").notNull().default(false),
  isAbsent: boolean("is_absent").notNull().default(false),
  isSub: boolean("is_sub").notNull().default(false),
  laneNumber: integer("lane_number").notNull(),
  frames: text().array().notNull().default(sql`'{}'`),
  splits: text().array().notNull().default(sql`'{}'`),
  notes: text().array().notNull().default(sql`'{}'`),
}, (table) => ({
  gameScoreIdx: index("game_score_idx").on(table.gameId, table.teamId, table.position),
  bowlerScoreIdx: index("bowler_score_idx").on(table.bowlerId),
  laneNumberIdx: index("lane_number_idx").on(table.laneNumber),
}));

const baseGameSchema = createInsertSchema(games);
const baseScoreSchema = createInsertSchema(scores);

const frameRegex = /^([0-9FX]|[0-9]\/|-)+$/;

export const insertGameSchema = baseGameSchema.extend({
  leagueId: positiveIntSchema,
  weekNumber: positiveIntSchema,
  gameNumber: z.number().int().min(1).max(3),
  date: dateSchema,
}).omit({ id: true, occurrenceId: true });

export const insertScoreSchema = baseScoreSchema.extend({
  gameId: positiveIntSchema,
  bowlerId: positiveIntSchema,
  teamId: positiveIntSchema,
  score: z.number().int().min(0).max(300),
  handicap: z.number().int().min(0).max(300),
  average: z.number().int().min(0).max(300),
  position: z.number().int().min(1).max(4),
  isVacant: z.boolean().default(false),
  isAbsent: z.boolean().default(false),
  isSub: z.boolean().default(false),
  laneNumber: positiveIntSchema,
  frames: z.array(z.string().regex(frameRegex, "Invalid frame notation")).default([]),
  splits: z.array(z.string().regex(/^[0-9-]+$/, "Invalid split notation")).default([]),
  notes: z.array(z.string().max(500)).default([]),
}).omit({ id: true });

export const updateGameSchema = z.object({
  leagueId: positiveIntSchema,
  weekNumber: positiveIntSchema,
  gameNumber: z.number().int().min(1).max(3),
  date: dateSchema,
}).partial();

export const updateScoreSchema = z.object({
  gameId: positiveIntSchema,
  bowlerId: positiveIntSchema,
  teamId: positiveIntSchema,
  score: z.number().int().min(0).max(300),
  handicap: z.number().int().min(0).max(300),
  average: z.number().int().min(0).max(300),
  position: z.number().int().min(1).max(4),
  isVacant: z.boolean(),
  isAbsent: z.boolean(),
  isSub: z.boolean(),
  laneNumber: positiveIntSchema,
  frames: z.array(z.string().regex(frameRegex, "Invalid frame notation")),
  splits: z.array(z.string().regex(/^[0-9-]+$/, "Invalid split notation")),
  notes: z.array(z.string().max(500)),
}).partial();

export type Game = typeof games.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;
export type UpdateGame = z.infer<typeof updateGameSchema>;

export type Score = typeof scores.$inferSelect;
export type InsertScore = z.infer<typeof insertScoreSchema>;
export type UpdateScore = z.infer<typeof updateScoreSchema>;
