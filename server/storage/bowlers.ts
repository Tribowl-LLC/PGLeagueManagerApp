import { eq, and, sql, inArray, ilike, asc } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlers, bowlerLeagues, leagues, teams,
  type Bowler, type InsertBowler, type UpdateBowler,
  type BowlerLeague, type InsertBowlerLeague, type UpdateBowlerLeague,
} from "@shared/schema";
import { createLogger } from '../logger';
import { cacheFetch, cacheInvalidate } from '../utils/cache';

const log = createLogger("StorageBowlers");

const BOWLERS_TTL = 30_000;

const bowlerColumns = {
  id: bowlers.id,
  name: bowlers.name,
  email: bowlers.email,
  phone: bowlers.phone,
  active: bowlers.active,
  order: bowlers.order,
  organizationId: bowlers.organizationId,
  paymentCustomerId: bowlers.paymentCustomerId,
  paymentProviderLocationId: bowlers.paymentProviderLocationId,
  paymentSyncPendingAt: bowlers.paymentSyncPendingAt,
  paymentSyncAttempts: bowlers.paymentSyncAttempts,
  paymentSyncLastAttemptAt: bowlers.paymentSyncLastAttemptAt,
};

export async function getBowlers(filters: { teamId?: number; organizationId: number }): Promise<Bowler[]> {
  const cacheKey = filters.teamId !== undefined
    ? `bowlers:team:${filters.teamId}:org:${filters.organizationId}`
    : `bowlers:org:${filters.organizationId}`;

  return cacheFetch(cacheKey, BOWLERS_TTL, () => {
    if (filters.teamId !== undefined) {
      return db
        .selectDistinct(bowlerColumns)
        .from(bowlers)
        .innerJoin(bowlerLeagues, eq(bowlerLeagues.bowlerId, bowlers.id))
        .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
        .where(and(
          eq(bowlerLeagues.teamId, filters.teamId),
          eq(leagues.organizationId, filters.organizationId),
        ))
        .orderBy(bowlers.order);
    }
    return db
      .selectDistinct(bowlerColumns)
      .from(bowlers)
      .innerJoin(bowlerLeagues, eq(bowlerLeagues.bowlerId, bowlers.id))
      .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
      .where(eq(leagues.organizationId, filters.organizationId))
      .orderBy(bowlers.order);
  });
}

export async function getAllBowlersSystemAdmin(): Promise<Bowler[]> {
  // Org-less resource policy (see server/utils/access-control.ts):
  // exclude bowlers whose only league assignments point to org-less leagues
  // (or who have no league assignments at all). They are only surfaced via
  // the explicit /api/system-admin/orphaned-data-counts diagnostic endpoint.
  return db
    .selectDistinct(bowlerColumns)
    .from(bowlers)
    .innerJoin(bowlerLeagues, eq(bowlerLeagues.bowlerId, bowlers.id))
    .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
    .where(sql`${leagues.organizationId} IS NOT NULL`)
    .orderBy(bowlers.order);
}

export async function getBowler(id: number): Promise<Bowler | undefined> {
  const [result] = await db.select().from(bowlers).where(eq(bowlers.id, id));
  return result;
}

export async function createBowler(
  bowler: InsertBowler & { organizationId: number },
): Promise<Bowler> {
  const [result] = await db.insert(bowlers).values(bowler).returning();
  cacheInvalidate('bowlers:');
  return result;
}

export async function updateBowler(id: number, bowler: UpdateBowler): Promise<Bowler> {
  const [result] = await db.update(bowlers).set(bowler).where(eq(bowlers.id, id)).returning();
  cacheInvalidate('bowlers:');
  return result;
}

export async function deleteBowler(id: number): Promise<void> {
  await db.delete(bowlers).where(eq(bowlers.id, id));
  cacheInvalidate('bowlers:');
}

export async function getBowlerLeaguesFiltered(filters?: { bowlerId?: number; leagueId?: number; teamId?: number }): Promise<BowlerLeague[]> {
  const query = db.select().from(bowlerLeagues);

  if (filters) {
    const conditions = [];
    if (filters.bowlerId !== undefined) {
      conditions.push(eq(bowlerLeagues.bowlerId, filters.bowlerId));
    }
    if (filters.leagueId !== undefined) {
      conditions.push(eq(bowlerLeagues.leagueId, filters.leagueId));
    }
    if (filters.teamId !== undefined) {
      conditions.push(eq(bowlerLeagues.teamId, filters.teamId));
    }
    if (conditions.length > 0) {
      conditions.push(eq(bowlerLeagues.active, true));
      return query.where(and(...conditions)).orderBy(bowlerLeagues.order);
    }
  }

  return query.where(eq(bowlerLeagues.active, true)).orderBy(bowlerLeagues.order);
}

export async function getBowlerLeague(id: number): Promise<BowlerLeague | undefined> {
  const [result] = await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.id, id));
  return result;
}

// True when the bowler currently has an ACTIVE roster row in the league.
// Payment-creation routes use this to reject payments that pair a league
// with a bowler who isn't rostered in it (P1: prevents corrupting
// balances/reports with mismatched bowler/league pairs).
export async function isBowlerActiveInLeague(bowlerId: number, leagueId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: bowlerLeagues.id })
    .from(bowlerLeagues)
    .where(
      and(
        eq(bowlerLeagues.bowlerId, bowlerId),
        eq(bowlerLeagues.leagueId, leagueId),
        eq(bowlerLeagues.active, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function createBowlerLeague(bowlerLeague: InsertBowlerLeague): Promise<BowlerLeague> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${bowlerLeague.teamId} FOR UPDATE`);

    const [maxOrder] = await tx
      .select({ maxOrder: sql<number>`max(${bowlerLeagues.order})` })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.teamId, bowlerLeague.teamId));

    const order = (maxOrder?.maxOrder ?? -1) + 1;

    const [result] = await tx
      .insert(bowlerLeagues)
      .values({ ...bowlerLeague, order })
      .returning();
    cacheInvalidate('bowlers:');
    return result;
  });
}

/**
 * Atomic non-bootstrap insert (task #473). Inserts a bowler-league row
 * if and only if no active link for the same (bowlerId, leagueId) pair
 * already exists. The check + insert runs inside a single transaction
 * with `SELECT ... FOR UPDATE` on the bowler row, so concurrent
 * attempts to add the same bowler to the same league serialize and
 * only the first one observes the pair as missing.
 *
 * Returns null when an active (bowlerId, leagueId) row already exists
 * (caller should map to the same 400 the non-atomic check used to
 * return). Returns the freshly created link otherwise.
 *
 * Why this exists separately from `createBowlerLeague`: the original
 * non-bootstrap route did `getBowlerLeagues({bowlerId, leagueId})` and
 * then `createBowlerLeague(data)` as two separate ops. A double-clicked
 * submit (or a React Query retry) could slip through both checks and
 * produce two rows for the same (bowler, league) pair before either
 * insert landed. There is no DB-level unique constraint on
 * (bowler_id, league_id) — only an index — so the application has to
 * serialize the check + insert itself. The bootstrap helper
 * (`createBowlerLeagueIfBowlerFree`) gates on "bowler has zero links";
 * this helper gates on "no link to THIS league" so the everyday path
 * can still add additional league memberships to an already-linked
 * bowler.
 */
export async function createBowlerLeagueIfNotInLeague(
  bowlerLeague: InsertBowlerLeague,
): Promise<BowlerLeague | null> {
  return db.transaction(async (tx) => {
    // Lock the bowler row so concurrent transactions targeting the same
    // bowler serialize. A racing transaction will block here until this
    // one commits/rollbacks, and will then observe the link we are
    // about to insert (and return null). We lock the bowler rather than
    // the (bowler, league) pair because there's no row to lock for a
    // pair that doesn't exist yet, and the bowler row is the natural
    // serialization point shared with `createBowlerLeagueIfBowlerFree`.
    await tx.execute(
      sql`SELECT id FROM ${bowlers} WHERE id = ${bowlerLeague.bowlerId} FOR UPDATE`,
    );

    const existing = await tx
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(and(
        eq(bowlerLeagues.bowlerId, bowlerLeague.bowlerId),
        eq(bowlerLeagues.leagueId, bowlerLeague.leagueId),
        eq(bowlerLeagues.active, true),
      ))
      .limit(1);

    if (existing.length > 0) {
      return null;
    }

    // Order computation mirrors createBowlerLeague (lock team row, take
    // max + 1) to keep insert behavior consistent across both paths.
    await tx.execute(
      sql`SELECT id FROM ${teams} WHERE id = ${bowlerLeague.teamId} FOR UPDATE`,
    );

    const [maxOrder] = await tx
      .select({ maxOrder: sql<number>`max(${bowlerLeagues.order})` })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.teamId, bowlerLeague.teamId));

    const order = (maxOrder?.maxOrder ?? -1) + 1;

    const [result] = await tx
      .insert(bowlerLeagues)
      .values({ ...bowlerLeague, order })
      .returning();
    cacheInvalidate('bowlers:');
    return result;
  });
}

/**
 * Atomic bootstrap-only insert (task #343). Inserts a bowler-league row
 * if and only if the target bowler currently has zero active league
 * links. The check + insert runs inside a single transaction with
 * `SELECT ... FOR UPDATE` on the bowler row, so concurrent bootstrap
 * attempts for the same bowler serialize and only the first one
 * observes a free-floating bowler.
 *
 * Returns null when the bowler already has at least one active link
 * (caller should map to the same 400 it would have returned via the
 * non-atomic check). Returns the freshly created link otherwise.
 *
 * Why this exists separately from `createBowlerLeague`: the regular
 * non-bootstrap path is allowed to add additional league memberships
 * to an already-linked bowler, so it cannot share the same
 * "no existing links" gate. Only the bootstrap branch in
 * /api/bowler-leagues uses this helper.
 */
export async function createBowlerLeagueIfBowlerFree(
  bowlerLeague: InsertBowlerLeague,
): Promise<BowlerLeague | null> {
  return db.transaction(async (tx) => {
    // Lock the bowler row so concurrent bootstrap transactions for the
    // same bowler serialize. Any racing transaction will block here
    // until this one commits/rollbacks, and then will observe the link
    // we are about to insert (and return null).
    await tx.execute(
      sql`SELECT id FROM ${bowlers} WHERE id = ${bowlerLeague.bowlerId} FOR UPDATE`,
    );

    const existing = await tx
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(and(
        eq(bowlerLeagues.bowlerId, bowlerLeague.bowlerId),
        eq(bowlerLeagues.active, true),
      ))
      .limit(1);

    if (existing.length > 0) {
      return null;
    }

    // Order computation mirrors createBowlerLeague (lock team row, take
    // max + 1) to keep insert behavior consistent across both paths.
    await tx.execute(
      sql`SELECT id FROM ${teams} WHERE id = ${bowlerLeague.teamId} FOR UPDATE`,
    );

    const [maxOrder] = await tx
      .select({ maxOrder: sql<number>`max(${bowlerLeagues.order})` })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.teamId, bowlerLeague.teamId));

    const order = (maxOrder?.maxOrder ?? -1) + 1;

    const [result] = await tx
      .insert(bowlerLeagues)
      .values({ ...bowlerLeague, order })
      .returning();
    cacheInvalidate('bowlers:');
    return result;
  });
}

export async function updateBowlerLeague(id: number, bowlerLeague: UpdateBowlerLeague): Promise<BowlerLeague> {
  const [result] = await db
    .update(bowlerLeagues)
    .set(bowlerLeague)
    .where(eq(bowlerLeagues.id, id))
    .returning();
  cacheInvalidate('bowlers:');
  return result;
}

export async function updateBowlerLeagueOrder(id: number, newOrder: number): Promise<BowlerLeague[]> {
  return db.transaction(async (tx) => {
    const [targetBowlerLeague] = await tx
      .select()
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.id, id));

    if (!targetBowlerLeague) {
      throw new Error('Bowler league not found');
    }

    await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${targetBowlerLeague.teamId} FOR UPDATE`);

    const bowlerLeaguesInTeam = await tx
      .select()
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.teamId, targetBowlerLeague.teamId))
      .orderBy(bowlerLeagues.order);

    const updatedBowlerLeagues = bowlerLeaguesInTeam.map((bl, index) => ({
      ...bl,
      order: bl.id === id ? newOrder : index >= newOrder ? index + 1 : index,
    }));

    const results: BowlerLeague[] = [];
    for (const bl of updatedBowlerLeagues) {
      const [updated] = await tx
        .update(bowlerLeagues)
        .set({ order: bl.order })
        .where(eq(bowlerLeagues.id, bl.id))
        .returning();
      results.push(updated);
    }
    cacheInvalidate('bowlers:');
    return results;
  });
}

export async function deleteBowlerLeague(id: number): Promise<boolean> {
  const result = await db.delete(bowlerLeagues)
    .where(eq(bowlerLeagues.id, id))
    .returning();
  cacheInvalidate('bowlers:');
  return result.length > 0;
}

export async function getBowlersByIds(ids: number[]): Promise<Bowler[]> {
  if (ids.length === 0) return [];
  return db.select().from(bowlers).where(inArray(bowlers.id, ids));
}

export async function getBowlerLeaguesByBowlerIds(bowlerIds: number[]): Promise<BowlerLeague[]> {
  if (bowlerIds.length === 0) return [];
  return db
    .select()
    .from(bowlerLeagues)
    .where(and(inArray(bowlerLeagues.bowlerId, bowlerIds), eq(bowlerLeagues.active, true)))
    .orderBy(bowlerLeagues.order);
}

export async function getBowlerByEmail(email: string, organizationId: number): Promise<Bowler | undefined> {
  const results = await db
    .select({ bowler: bowlers })
    .from(bowlers)
    .innerJoin(bowlerLeagues, eq(bowlers.id, bowlerLeagues.bowlerId))
    .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
    .where(and(eq(bowlers.email, email), eq(leagues.organizationId, organizationId)));
  return results[0]?.bowler;
}

/**
 * Look up a bowler by email directly via `bowlers.organization_id`,
 * without requiring league membership. Used by the partner-link invite
 * flow where an org bowler may be invitable before being placed on a
 * league.
 */
export async function getBowlerByEmailInOrg(
  email: string,
  organizationId: number,
): Promise<Bowler | undefined> {
  const [row] = await db
    .select()
    .from(bowlers)
    .where(and(eq(bowlers.email, email), eq(bowlers.organizationId, organizationId)))
    .limit(1);
  return row;
}

/**
 * Case-insensitive substring search of bowlers within an organization.
 * Returns up to `limit` rows matching `q` against `bowlers.name` or
 * `bowlers.email`. The `secondaryLabel` is the first league the bowler
 * is on (for disambiguation in UI), falling back to a masked email
 * when no league is found, or `null` when neither is available.
 *
 * Org-less bowlers are never returned (per the org-less data policy).
 */
export interface BowlerSearchResult {
  id: number;
  name: string;
  organizationId: number;
  secondaryLabel: string | null;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}

export async function searchBowlersByName(
  q: string,
  organizationId: number,
  limit = 10,
): Promise<BowlerSearchResult[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) return [];
  const pattern = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({
      id: bowlers.id,
      name: bowlers.name,
      email: bowlers.email,
      organizationId: bowlers.organizationId,
    })
    .from(bowlers)
    .where(
      and(
        eq(bowlers.organizationId, organizationId),
        eq(bowlers.active, true),
        sql`(${bowlers.name} ILIKE ${pattern} OR ${bowlers.email} ILIKE ${pattern})`,
      ),
    )
    .orderBy(asc(bowlers.name))
    .limit(limit);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Pull a representative league name per bowler (the lowest-id active
  // league row) for the secondary label.
  const leagueRows = await db
    .select({
      bowlerId: bowlerLeagues.bowlerId,
      leagueName: leagues.name,
      leagueId: leagues.id,
    })
    .from(bowlerLeagues)
    .innerJoin(leagues, eq(leagues.id, bowlerLeagues.leagueId))
    .where(
      and(
        inArray(bowlerLeagues.bowlerId, ids),
        eq(leagues.organizationId, organizationId),
      ),
    )
    .orderBy(asc(bowlerLeagues.bowlerId), asc(leagues.id));
  const firstLeagueByBowler = new Map<number, string>();
  for (const r of leagueRows) {
    if (!firstLeagueByBowler.has(r.bowlerId)) {
      firstLeagueByBowler.set(r.bowlerId, r.leagueName);
    }
  }

  return rows
    .filter((r): r is typeof r & { organizationId: number } => r.organizationId !== null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      organizationId: r.organizationId,
      secondaryLabel:
        firstLeagueByBowler.get(r.id) ??
        (r.email ? maskEmail(r.email) : null),
    }));
}

export async function getBowlerByEmailSystemAdmin(email: string): Promise<Bowler | undefined> {
  const [result] = await db.select().from(bowlers).where(eq(bowlers.email, email));
  return result;
}

/**
 * Find every bowler row whose email matches the supplied address (case
 * sensitive — emails are normalised on insert). Used by the account-data
 * deletion flow which needs to scrub all bowler records tied to a single
 * email, even if duplicated across orgs.
 */
export async function getBowlersByEmailSystemAdmin(email: string): Promise<Bowler[]> {
  return db.select().from(bowlers).where(eq(bowlers.email, email));
}

/**
 * Scrub personally-identifying fields on a bowler in-place. Preserves
 * the row (and its FK-protected payments / scores / league memberships)
 * so historical data stays consistent, but removes name, email, phone,
 * and stored payment-provider references and marks the bowler inactive.
 */
export async function anonymizeBowler(id: number): Promise<Bowler> {
  const [updated] = await db
    .update(bowlers)
    .set({
      name: 'Deleted Bowler',
      email: null,
      phone: null,
      active: false,
      paymentCustomerId: null,
      paymentProviderLocationId: null,
      paymentSyncPendingAt: null,
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
    })
    .where(eq(bowlers.id, id))
    .returning();
  cacheInvalidate('bowlers:');
  if (!updated) {
    throw new Error(`Failed to anonymize bowler ${id}`);
  }
  return updated;
}
