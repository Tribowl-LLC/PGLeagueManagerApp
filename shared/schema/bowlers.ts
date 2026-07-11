import { pgTable, text, serial, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { nameSchema, emailSchema, positiveIntSchema } from "./constants";
import { leagues } from "./leagues";
import { teams } from "./teams";
import { locations } from "./locations";
import { organizations } from "./organizations";

export const bowlers = pgTable("bowlers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  order: integer("order").notNull().default(0),
  // Owning organization stamped at creation time (task #342, hardened
  // to NOT NULL in task #407). Every route that creates a bowler MUST
  // set this from the caller's org so a bowler is org-bound from the
  // moment it exists, not retroactively inferred from league links.
  // Enforced at the database level: any future code path that forgets
  // to stamp the owner is rejected by the constraint instead of
  // silently producing an orphan row that's invisible to its own org.
  organizationId: integer("organization_id").notNull().references(() => organizations.id),
  paymentCustomerId: text("payment_customer_id"),
  cloverCustomerId: text("clover_customer_id"),
  // Records which location's payment processor created the bowler's
  // saved-customer record (`paymentCustomerId` / `cloverCustomerId`).
  // Set whenever either of those columns is first written and used by
  // the account-deletion service to target exactly one processor for
  // saved-card cleanup instead of fanning out to every location
  // reachable through the bowler's leagues. NULL on legacy rows; the
  // deletion service falls back to the join-based scan in that case.
  // See server/services/account-deletion.ts (collectProviderTargets)
  // and task #346.
  paymentProviderLocationId: integer("payment_provider_location_id").references(() => locations.id, { onDelete: 'set null' }),
  bnContactId: text("bn_contact_id"),
  // Set when a profile-update tried to push the bowler to the payment
  // provider and the call failed for a non-config reason (auth, rate
  // limit, network). Cleared when a subsequent sync attempt succeeds.
  // Used by the admin "retry payment sync" endpoint and surfaced in the
  // PATCH /api/account/profile response so the caller knows the customer
  // record on the provider side may be stale. See server/routes/account.ts.
  paymentSyncPendingAt: timestamp("payment_sync_pending_at", { mode: "string" }),
  // Retry-sweep bookkeeping for `paymentSyncPendingAt` (task #284).
  // `paymentSyncAttempts` counts consecutive failed retries since the
  // flag was set; once it hits the cap the background sweep stops
  // touching the bowler and ops must handle it manually. Reset to 0 on
  // a successful sync. `paymentSyncLastAttemptAt` is the timestamp of
  // the most recent retry attempt and drives exponential backoff
  // between sweep ticks.
  paymentSyncAttempts: integer("payment_sync_attempts").notNull().default(0),
  paymentSyncLastAttemptAt: timestamp("payment_sync_last_attempt_at", { mode: "string" }),
  // BowlNow contact-sync retry state (task #480). Parallel triple to
  // `paymentSync*` above but kept SEPARATE on purpose — Square and
  // BowlNow are independent external systems with independent
  // failure modes (different APIs, different rate limits, different
  // outages). A single shared flag would force a Square success to
  // clear a still-failing BowlNow retry (or vice-versa) and would
  // conflate the per-provider attempt counts.
  // `bnSyncPendingAt` is set by `bowler-resync.ts` when a fire-and-
  // forget BowlNow sync attempt fails; the background sweep
  // (`server/services/bowlnow-sync-retry.ts`) walks flagged rows,
  // re-runs `syncBowlerToBN`, and clears the flag on success.
  bnSyncPendingAt: timestamp("bn_sync_pending_at", { mode: "string" }),
  bnSyncAttempts: integer("bn_sync_attempts").notNull().default(0),
  bnSyncLastAttemptAt: timestamp("bn_sync_last_attempt_at", { mode: "string" }),
});

// Mirror of `PAYMENT_SYNC_MAX_ATTEMPTS` in
// server/services/payment-customer-sync.ts. Re-exported from a `shared/`
// module so the admin UI can render "attempt N/MAX" without round-tripping
// to the server. Both values must stay in lockstep — see task #320.
export const PAYMENT_SYNC_MAX_ATTEMPTS = 5;

// Single source of truth for the payment-sync status union returned by
// PATCH /api/account/profile, /api/account/profile/retry-payment-sync,
// /api/account/confirm-email-change, and surfaced on /api/user. Adding
// a fifth state means changing this tuple — and only this tuple — so
// the server, the profile card, the users page, and the email-confirm
// page can never drift from each other (task #374). Keep alphabetized
// only by intent: the order here is the natural lifecycle order
// (success → no-op → retryable failure → not relevant), and tests do
// not depend on the order.
export const PAYMENT_SYNC_STATUSES = [
  'synced',
  'skipped',
  'pending_retry',
  'not_applicable',
] as const;

export type PaymentSyncStatus = (typeof PAYMENT_SYNC_STATUSES)[number];

// Defensive parser used by clients that read `paymentSyncStatus` off
// an arbitrary JSON response. An unknown value (older client + newer
// server adding a fifth state, or a malformed response) collapses to
// `not_applicable` so the UI stays silent rather than rendering a
// stale or misleading retry notice.
export function parsePaymentSyncStatus(value: unknown): PaymentSyncStatus {
  return (PAYMENT_SYNC_STATUSES as readonly string[]).includes(value as string)
    ? (value as PaymentSyncStatus)
    : 'not_applicable';
}

// Same shape as PAYMENT_SYNC_MAX_ATTEMPTS but for the BowlNow retry
// sweep (task #480). Kept as a distinct constant so we can tune the
// two providers' attempt budgets independently if one ends up flakier
// than the other in production.
export const BN_SYNC_MAX_ATTEMPTS = 5;

export const bowlerLeagues = pgTable("bowler_leagues", {
  id: serial("id").primaryKey(),
  bowlerId: integer("bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: 'cascade' }),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: 'cascade' }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  active: boolean("active").notNull().default(true),
  order: integer("order").notNull().default(0),
  joinedAt: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  bowlerIdx: index().on(table.bowlerId),
  leagueIdx: index().on(table.leagueId),
  teamIdx: index().on(table.teamId),
  orderIdx: index().on(table.teamId, table.leagueId, table.order),
  activeBowlerIdx: index("bowler_leagues_active_unique_idx").on(
    table.bowlerId,
    table.leagueId,
    table.teamId,
    table.active
  ),
}));

const baseBowlerSchema = createInsertSchema(bowlers);
const baseBowlerLeagueSchema = createInsertSchema(bowlerLeagues);

export const insertBowlerSchema = baseBowlerSchema.extend({
  name: nameSchema,
  email: z.union([emailSchema, z.literal("")]).optional().nullable(),
  phone: z.string().nullable().optional(),
  active: z.boolean().default(true),
  order: z.number().min(0).default(0),
  // Server stamps this from the caller's org in every creation route;
  // accepted as optional in the Zod schema so the parse on `req.body`
  // (which never carries it) doesn't reject. The stamping code adds
  // it before calling `storage.createBowler`, and the DB-level NOT
  // NULL constraint (task #407) is the final safety net that rejects
  // any creation path that forgets to set it.
  organizationId: z.number().int().positive().optional(),
  paymentCustomerId: z.string().nullable().optional(),
  cloverCustomerId: z.string().nullable().optional(),
  paymentProviderLocationId: z.number().int().positive().nullable().optional(),
  paymentSyncPendingAt: z.string().nullable().optional(),
  paymentSyncAttempts: z.number().int().min(0).optional(),
  paymentSyncLastAttemptAt: z.string().nullable().optional(),
  bnSyncPendingAt: z.string().nullable().optional(),
  bnSyncAttempts: z.number().int().min(0).optional(),
  bnSyncLastAttemptAt: z.string().nullable().optional(),
}).omit({ id: true });

export const insertBowlerLeagueSchema = baseBowlerLeagueSchema.extend({
  bowlerId: positiveIntSchema,
  leagueId: positiveIntSchema,
  teamId: positiveIntSchema,
  active: z.boolean().default(true),
  order: z.number().min(0).default(0),
}).omit({ id: true });

export const updateBowlerSchema = z.object({
  name: nameSchema,
  email: z.union([emailSchema, z.literal("")]).nullable(),
  phone: z.string().nullable(),
  active: z.boolean(),
  order: z.number().min(0),
  paymentCustomerId: z.string().nullable(),
  cloverCustomerId: z.string().nullable(),
  paymentProviderLocationId: z.number().int().positive().nullable(),
  bnContactId: z.string().nullable(),
  paymentSyncPendingAt: z.string().nullable(),
  paymentSyncAttempts: z.number().int().min(0),
  paymentSyncLastAttemptAt: z.string().nullable(),
  bnSyncPendingAt: z.string().nullable(),
  bnSyncAttempts: z.number().int().min(0),
  bnSyncLastAttemptAt: z.string().nullable(),
}).partial();

export const updateBowlerLeagueSchema = z.object({
  bowlerId: positiveIntSchema,
  leagueId: positiveIntSchema,
  teamId: positiveIntSchema,
  active: z.boolean(),
  order: z.number().min(0),
}).partial();

export type Bowler = typeof bowlers.$inferSelect;
export type InsertBowler = z.infer<typeof insertBowlerSchema>;
export type UpdateBowler = z.infer<typeof updateBowlerSchema>;

export type BowlerLeague = typeof bowlerLeagues.$inferSelect;
export type InsertBowlerLeague = z.infer<typeof insertBowlerLeagueSchema>;
export type UpdateBowlerLeague = z.infer<typeof updateBowlerLeagueSchema>;
