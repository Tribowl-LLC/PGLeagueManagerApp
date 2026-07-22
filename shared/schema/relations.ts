import { relations } from "drizzle-orm";
import { organizations } from "./organizations";
import { locations } from "./locations";
import { leagues } from "./leagues";
import { teams } from "./teams";
import { bowlers, bowlerLeagues } from "./bowlers";
import { payments, paymentSchedules } from "./payments";
import { users } from "./users";
import { games, scores } from "./games";

export const organizationRelations = relations(organizations, ({ many }) => ({
  leagues: many(leagues),
  users: many(users),
  locations: many(locations),
}));

export const locationRelations = relations(locations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [locations.organizationId],
    references: [organizations.id],
  }),
  leagues: many(leagues),
}));

export const leagueRelations = relations(leagues, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [leagues.organizationId],
    references: [organizations.id],
  }),
  location: one(locations, {
    fields: [leagues.locationId],
    references: [locations.id],
  }),
  previousSeason: one(leagues, {
    fields: [leagues.previousSeasonId],
    references: [leagues.id],
    relationName: "seasonChain",
  }),
  nextSeasons: many(leagues, { relationName: "seasonChain" }),
  teams: many(teams),
  bowlerLeagues: many(bowlerLeagues),
  payments: many(payments),
}));

export const teamRelations = relations(teams, ({ one, many }) => ({
  league: one(leagues, {
    fields: [teams.leagueId],
    references: [leagues.id],
  }),
  bowlerLeagues: many(bowlerLeagues),
}));

export const bowlerRelations = relations(bowlers, ({ many }) => ({
  bowlerLeagues: many(bowlerLeagues),
  payments: many(payments),
  users: many(users),
}));

export const bowlerLeagueRelations = relations(bowlerLeagues, ({ one }) => ({
  bowler: one(bowlers, {
    fields: [bowlerLeagues.bowlerId],
    references: [bowlers.id],
  }),
  league: one(leagues, {
    fields: [bowlerLeagues.leagueId],
    references: [leagues.id],
  }),
  team: one(teams, {
    fields: [bowlerLeagues.teamId],
    references: [teams.id],
  }),
}));

export const gameRelations = relations(games, ({ one, many }) => ({
  league: one(leagues, {
    fields: [games.leagueId],
    references: [leagues.id],
  }),
  scores: many(scores),
}));

export const scoreRelations = relations(scores, ({ one }) => ({
  game: one(games, {
    fields: [scores.gameId],
    references: [games.id],
  }),
  bowler: one(bowlers, {
    fields: [scores.bowlerId],
    references: [bowlers.id],
  }),
  team: one(teams, {
    fields: [scores.teamId],
    references: [teams.id],
  }),
}));

export const paymentRelations = relations(payments, ({ one }) => ({
  bowler: one(bowlers, {
    fields: [payments.bowlerId],
    references: [bowlers.id],
  }),
  league: one(leagues, {
    fields: [payments.leagueId],
    references: [leagues.id],
  }),
}));

export const paymentScheduleRelations = relations(paymentSchedules, ({ one }) => ({
  bowler: one(bowlers, {
    fields: [paymentSchedules.bowlerId],
    references: [bowlers.id],
  }),
  league: one(leagues, {
    fields: [paymentSchedules.leagueId],
    references: [leagues.id],
  }),
}));

export const userRelations = relations(users, ({ one }) => ({
  bowler: one(bowlers, {
    fields: [users.bowlerId],
    references: [bowlers.id],
  }),
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
}));
