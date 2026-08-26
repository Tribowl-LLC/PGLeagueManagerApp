import { pgTable, text, serial, integer, boolean, timestamp, index, uniqueIndex, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { WEEKDAYS, PAYMENT_MODES, nameSchema, positiveIntSchema, dateSchema, timeSchema, DEFAULT_WEEKLY_FEE_CENTS, DEFAULT_TIMEZONE } from "./constants";
import { organizations } from "./organizations";
import { locations } from "./locations";

export const SUBSTITUTE_ACCESS = ["team_only", "floating"] as const;
export type SubstituteAccess = (typeof SUBSTITUTE_ACCESS)[number];
export const SUBSTITUTE_PAYMENT_REGIMES = ["team_choice", "league_lineage_prize_split"] as const;
export type SubstitutePaymentRegime = (typeof SUBSTITUTE_PAYMENT_REGIMES)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_INDEX: Record<typeof WEEKDAYS[number], number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Task #646: validate `doublePayDates` against the league's schedule.
 *  - each entry must be ISO `YYYY-MM-DD`
 *  - must not overlap `skipDates` or `cancelledDates`
 *  - must fall on the league's `weekDay` and within `[seasonStart, seasonEnd]`
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, message, path }` for
 * the first failing date so callers can attach a `.refine` error.
 *
 * Exported for the PATCH route in `server/routes/leagues.ts`, which has
 * to enforce schedule-context checks server-side using the merged
 * persisted-league + patch-body view (a partial PATCH that only changes
 * `doublePayDates` would otherwise bypass the schema-level guard, since
 * the schema can't see the persisted weekDay/seasonStart/seasonEnd).
 */
export function validateDoublePayDates(args: {
  doublePayDates: string[] | undefined | null;
  skipDates?: string[] | null;
  cancelledDates?: string[] | null;
  weekDay?: typeof WEEKDAYS[number];
  seasonStart?: string | Date | null;
  seasonEnd?: string | Date | null;
}): { ok: true } | { ok: false; message: string } {
  const dpd = args.doublePayDates ?? [];
  if (dpd.length === 0) return { ok: true };

  for (const raw of dpd) {
    if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) {
      return { ok: false, message: `Double-pay date "${raw}" must be in YYYY-MM-DD format` };
    }
  }
  if (new Set(dpd).size !== dpd.length) {
    return { ok: false, message: "Double-pay dates must be unique" };
  }

  const skipSet = new Set((args.skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((args.cancelledDates ?? []).map((d) => d.slice(0, 10)));
  for (const d of dpd) {
    if (skipSet.has(d) || cancelSet.has(d)) {
      return { ok: false, message: `Double-pay date "${d}" cannot also be a skip or cancelled week` };
    }
  }

  if (args.weekDay && args.seasonStart && args.seasonEnd) {
    const targetDow = WEEKDAY_INDEX[args.weekDay];
    const startStr = (typeof args.seasonStart === "string" ? args.seasonStart : args.seasonStart.toISOString()).slice(0, 10);
    const endStr = (typeof args.seasonEnd === "string" ? args.seasonEnd : args.seasonEnd.toISOString()).slice(0, 10);
    for (const d of dpd) {
      if (d < startStr || d > endStr) {
        return { ok: false, message: `Double-pay date "${d}" must fall within the season` };
      }
      const [y, m, day] = d.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
      if (dow !== targetDow) {
        return { ok: false, message: `Double-pay date "${d}" must fall on ${args.weekDay}` };
      }
    }
  }

  return { ok: true };
}

export const leagues = pgTable("leagues", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Explicit league configuration. Nullable only so existing leagues can be
  // upgraded deliberately; public league setup requires three or four.
  payingLineupSize: integer("paying_lineup_size"),
  // Roster-driven payment configuration. Defaults keep pre-PR1 rows readable;
  // new setup requests persist an explicit value through the insert schema.
  substituteAccess: text("substitute_access", { enum: SUBSTITUTE_ACCESS }).notNull().default("team_only"),
  substitutePaymentRegime: text("substitute_payment_regime", { enum: SUBSTITUTE_PAYMENT_REGIMES }).notNull().default("team_choice"),
  active: boolean("active").notNull().default(true),
  allowPublicSignup: boolean("allow_public_signup").notNull().default(false),
  seasonStart: timestamp("season_start", { mode: "string" }).notNull(),
  seasonEnd: timestamp("season_end", { mode: "string" }).notNull(),
  weekDay: text("week_day", { enum: WEEKDAYS }).notNull(),
  weeklyFee: integer("weekly_fee").notNull().default(DEFAULT_WEEKLY_FEE_CENTS),
  lineageFee: integer("lineage_fee"),
  prizeFundFee: integer("prize_fund_fee"),
  practiceStartTime: text("practice_start_time"),
  competitionStartTime: text("competition_start_time"),
  squareLineageItemId: text("square_lineage_item_id"),
  lineageItemVariationId: text("lineage_item_variation_id"),
  squareLineageItemName: text("square_lineage_item_name"),
  squarePrizeFundItemId: text("square_prize_fund_item_id"),
  prizeFundItemVariationId: text("prize_fund_item_variation_id"),
  squarePrizeFundItemName: text("square_prize_fund_item_name"),
  squareCategoryId: text("square_category_id"),
  timezone: text("timezone").default(DEFAULT_TIMEZONE),
  // Keep the database default for legacy/internal insert compatibility. The
  // public create contract still requires an explicit operator choice.
  paymentMode: text("payment_mode", { enum: PAYMENT_MODES }).notNull().default("weekly"),
  seasonNumber: integer("season_number").notNull().default(1),
  previousSeasonId: integer("previous_season_id").references((): AnyPgColumn => leagues.id, { onDelete: 'set null' }),
  // NULLABLE on purpose. The org-less state is what the system-admin
  // "orphan data" cleanup feature exists to handle: legacy rows that
  // pre-date the org model, or rows orphaned by an org deletion. The
  // application layer (insert/update schemas + access-control) enforces
  // that NEW leagues are always attached to an org; this column stays
  // nullable so the orphan-data tooling has something to operate on.
  organizationId: integer("organization_id").references(() => organizations.id),
  locationId: integer("location_id").references(() => locations.id),
  totalBowlingWeeks: integer("total_bowling_weeks"),
  skipDates: text("skip_dates").array().notNull().default(sql`'{}'`),
  cancelledDates: text("cancelled_dates").array().notNull().default(sql`'{}'`),
  // Up to 2 ISO `YYYY-MM-DD` bowling dates that should be charged at
  // 2× the weekly fee by the autopay scheduler (Task #646). Replaces
  doublePayDates: text("double_pay_dates").array().notNull().default(sql`'{}'`),
  // Durable optimistic revision for authoritative canonical schedule edits.
  // A zero value is retained for pre-canonical legacy rows and is initialized
  // to the generation source revision when v3 setup publishes a schedule.
  canonicalScheduleRevision: integer("canonical_schedule_revision").notNull().default(0),
}, (table) => ({
  activeNameIdx: index("leagues_active_name_idx").on(table.active, table.name),
  seasonIdx: index("leagues_season_idx").on(table.seasonStart, table.seasonEnd),
  organizationIdx: index("leagues_organization_idx").on(table.organizationId),
  locationIdx: index("leagues_location_idx").on(table.locationId),
  paymentModeCheck: check("leagues_payment_mode_check", sql`${table.paymentMode} IN ('weekly', 'upfront')`),
  payingLineupSizeCheck: check("leagues_paying_lineup_size_check", sql`${table.payingLineupSize} IS NULL OR ${table.payingLineupSize} IN (3, 4)`),
  substituteAccessCheck: check("leagues_substitute_access_check", sql`${table.substituteAccess} IN ('team_only', 'floating')`),
  substitutePaymentRegimeCheck: check("leagues_substitute_payment_regime_check", sql`${table.substitutePaymentRegime} IN ('team_choice', 'league_lineage_prize_split')`),
  // Canonical occurrence rows carry both the league and organization IDs.
  // This parent key lets PostgreSQL enforce that the pair came from the same
  // tenant even though legacy leagues.organization_id remains nullable.
  idOrganizationUnique: uniqueIndex("leagues_id_organization_unique").on(table.id, table.organizationId),
}));

const baseLeagueSchema = createInsertSchema(leagues);

export const insertLeagueSchema = baseLeagueSchema.extend({
  name: nameSchema,
  description: z.string().nullable().optional(),
  payingLineupSize: z.union([z.literal(3), z.literal(4)]),
  substituteAccess: z.enum(SUBSTITUTE_ACCESS).optional(),
  substitutePaymentRegime: z.enum(SUBSTITUTE_PAYMENT_REGIMES).optional(),
  active: z.boolean().default(true),
  allowPublicSignup: z.boolean().default(false),
  seasonStart: dateSchema,
  seasonEnd: dateSchema,
  weekDay: z.enum(WEEKDAYS),
  weeklyFee: positiveIntSchema.default(DEFAULT_WEEKLY_FEE_CENTS),
  lineageFee: z.number().int().min(0).nullable().optional(),
  prizeFundFee: z.number().int().min(0).nullable().optional(),
  practiceStartTime: timeSchema.optional(),
  competitionStartTime: timeSchema.optional(),
  timezone: z.string().default(DEFAULT_TIMEZONE),
  squareLineageItemId: z.string().nullable().optional(),
  lineageItemVariationId: z.string().nullable().optional(),
  squareLineageItemName: z.string().nullable().optional(),
  squarePrizeFundItemId: z.string().nullable().optional(),
  prizeFundItemVariationId: z.string().nullable().optional(),
  squarePrizeFundItemName: z.string().nullable().optional(),
  squareCategoryId: z.string().nullable().optional(),
  locationId: z.number().int().positive().nullable().optional(),
  seasonNumber: z.number().int().positive().default(1),
  previousSeasonId: z.number().int().positive().nullable().optional(),
  paymentMode: z.enum(PAYMENT_MODES),
  totalBowlingWeeks: z.number().int().positive().nullable().optional(),
  skipDates: z.array(z.string()).default([]),
  cancelledDates: z.array(z.string()).default([]),
  doublePayDates: z.array(z.string()).max(2, "At most 2 double-pay weeks allowed").default([]),
}).omit({ id: true })
  .refine(
    (data) => data.seasonEnd > data.seasonStart,
    "Season end date must be after season start date"
  )
  .refine(
    (data) => {
      const lf = data.lineageFee;
      const pf = data.prizeFundFee;
      if (lf != null || pf != null) {
        if (lf == null || pf == null) return false;
        return lf + pf === data.weeklyFee;
      }
      return true;
    },
    { message: "Lineage fee and prize fund fee must both be set and sum to the weekly fee", path: ["lineageFee"] }
  )
  .superRefine((data, ctx) => {
    const result = validateDoublePayDates({
      doublePayDates: data.doublePayDates,
      skipDates: data.skipDates,
      cancelledDates: data.cancelledDates,
      weekDay: data.weekDay,
      seasonStart: data.seasonStart,
      seasonEnd: data.seasonEnd,
    });
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["doublePayDates"], message: result.message });
    }
  });

export const updateLeagueSchema = z.object({
  name: nameSchema,
  description: z.string().nullable(),
  payingLineupSize: z.union([z.literal(3), z.literal(4)]),
  substituteAccess: z.enum(SUBSTITUTE_ACCESS),
  substitutePaymentRegime: z.enum(SUBSTITUTE_PAYMENT_REGIMES),
  active: z.boolean(),
  allowPublicSignup: z.boolean(),
  seasonStart: dateSchema,
  seasonEnd: dateSchema,
  weekDay: z.enum(WEEKDAYS),
  weeklyFee: positiveIntSchema,
  lineageFee: z.number().int().min(0).nullable(),
  prizeFundFee: z.number().int().min(0).nullable(),
  practiceStartTime: timeSchema,
  competitionStartTime: timeSchema,
  timezone: z.string(),
  squareLineageItemId: z.string().nullable(),
  lineageItemVariationId: z.string().nullable(),
  squareLineageItemName: z.string().nullable(),
  squarePrizeFundItemId: z.string().nullable(),
  prizeFundItemVariationId: z.string().nullable(),
  squarePrizeFundItemName: z.string().nullable(),
  squareCategoryId: z.string().nullable(),
  locationId: z.number().int().positive().nullable(),
  paymentMode: z.enum(PAYMENT_MODES),
  totalBowlingWeeks: z.number().int().positive().nullable(),
  skipDates: z.array(z.string()),
  cancelledDates: z.array(z.string()),
  doublePayDates: z.array(z.string()).max(2, "At most 2 double-pay weeks allowed"),
  organizationId: z.number().int().positive(),
}).partial().refine(
  (data) => {
    if (data.seasonStart && data.seasonEnd) {
      return data.seasonEnd > data.seasonStart;
    }
    return true;
  },
  "Season end date must be after season start date"
).refine(
  (data) => {
    const lf = data.lineageFee;
    const pf = data.prizeFundFee;
    const wf = data.weeklyFee;
    if (lf != null || pf != null) {
      if (lf == null || pf == null) return false;
      if (wf != null && lf + pf !== wf) return false;
    }
    return true;
  },
  { message: "Lineage fee and prize fund fee must both be set and sum to the weekly fee", path: ["lineageFee"] }
).superRefine((data, ctx) => {
  if (!data.doublePayDates) return;
  const result = validateDoublePayDates({
    doublePayDates: data.doublePayDates,
    skipDates: data.skipDates,
    cancelledDates: data.cancelledDates,
    weekDay: data.weekDay,
    seasonStart: data.seasonStart,
    seasonEnd: data.seasonEnd,
  });
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["doublePayDates"], message: result.message });
  }
});

// API/test fixtures may represent pre-0030 legacy rows without the durable
// canonical revision; database-selected rows always contain the defaulted
// column.
export type League = Omit<typeof leagues.$inferSelect, "canonicalScheduleRevision" | "payingLineupSize" | "substituteAccess" | "substitutePaymentRegime"> & {
  canonicalScheduleRevision?: number;
  payingLineupSize?: number | null;
  substituteAccess?: SubstituteAccess;
  substitutePaymentRegime?: SubstitutePaymentRegime;
};
export type InsertLeagueInput = z.input<typeof insertLeagueSchema>;
export type InsertLeague = z.output<typeof insertLeagueSchema>;
export type UpdateLeague = z.infer<typeof updateLeagueSchema>;
