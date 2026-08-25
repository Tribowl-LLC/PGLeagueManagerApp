import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerLeagues,
  bowlers,
  leagues,
  occurrencePaymentResponsibilities,
  teamPaymentSlots,
  teams,
  type League,
  type InsertLeague,
  type UpdateLeague,
} from "@shared/schema";
import { createLogger } from '../logger';
import { cacheFetch, cacheInvalidate } from '../utils/cache';
import { hasLeagueOccurrenceEvidence, hasOperationalLeagueOccurrenceEvidence } from './canonical-occurrence-evidence.js';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StorageLeagues");

const LEAGUES_TTL = 30_000;

export class LeagueOccurrenceEvidenceExistsError extends Error {
  constructor() {
    super('League has retained canonical occurrence evidence and must be archived instead');
    this.name = 'LeagueOccurrenceEvidenceExistsError';
  }
}

export class LeaguePaymentModeLockedError extends Error {
  constructor() {
    super('League payment timing cannot change after canonical schedule evidence exists');
    this.name = 'LeaguePaymentModeLockedError';
  }
}

export class LeagueCanonicalScheduleLockedError extends Error {
  constructor() {
    super('Canonical schedule inputs cannot change after canonical schedule evidence exists');
    this.name = 'LeagueCanonicalScheduleLockedError';
  }
}

export class LeagueSubstituteConfigurationLockedError extends Error {
  constructor() {
    super('Substitute access and payment regime cannot change after the first canonical responsibility');
    this.name = 'LeagueSubstituteConfigurationLockedError';
  }
}

const CANONICAL_UPDATE_FIELDS = [
  'organizationId',
  'locationId',
  'seasonStart',
  'seasonEnd',
  'weekDay',
  'competitionStartTime',
  'timezone',
  'totalBowlingWeeks',
  'skipDates',
  'cancelledDates',
  'weeklyFee',
  'lineageFee',
  'prizeFundFee',
  'payingLineupSize',
  'paymentMode',
] as const satisfies readonly (keyof UpdateLeague)[];

function sameCanonicalValue(field: typeof CANONICAL_UPDATE_FIELDS[number], left: unknown, right: unknown): boolean {
  if (field === 'seasonStart' || field === 'seasonEnd') {
    const dateOnly = (value: unknown): string | null => {
      const raw = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
      const match = raw === null ? null : /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(raw);
      return match?.[1] ?? null;
    };
    const leftDate = dateOnly(left);
    return leftDate !== null && leftDate === dateOnly(right);
  }
  if (field === 'skipDates' || field === 'cancelledDates') {
    const normalize = (value: unknown) => Array.isArray(value) ? [...value].map(String).sort() : [];
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }
  if (field === 'competitionStartTime') {
    const normalize = (value: unknown) => typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value)
      ? `${value.padStart(5, '0')}:00`
      : value ?? null;
    return normalize(left) === normalize(right);
  }
  return (left ?? null) === (right ?? null);
}

function sameValue(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

export async function getLeagues(organizationId: number): Promise<League[]> {
  return cacheFetch(`leagues:org:${organizationId}`, LEAGUES_TTL, () =>
    db.select().from(leagues)
      .where(eq(leagues.organizationId, organizationId))
      .orderBy(leagues.name)
  );
}

export async function getAllLeaguesSystemAdmin(): Promise<League[]> {
  // Org-less resource policy (see server/utils/access-control.ts):
  // exclude leagues whose organization_id IS NULL. They are only surfaced via
  // the explicit /api/system-admin/orphaned-data-counts diagnostic endpoint.
  return cacheFetch('leagues:all', LEAGUES_TTL, () =>
    db.select().from(leagues).where(isNotNull(leagues.organizationId)).orderBy(leagues.id)
  );
}

export async function getLeague(id: number): Promise<League | undefined> {
  return cacheFetch(`leagues:id:${id}`, LEAGUES_TTL, async () => {
    const [result] = await db.select().from(leagues).where(eq(leagues.id, id));
    return result;
  });
}

export async function createLeague(league: InsertLeague): Promise<League> {
  const [result] = await db.insert(leagues).values(league).returning();
  cacheInvalidate('leagues:');
  return result;
}

export async function updateLeague(id: number, league: UpdateLeague): Promise<League> {
  const canonicalFields = CANONICAL_UPDATE_FIELDS.filter((field) => league[field] !== undefined);
  const substituteConfigurationChanged = league.substituteAccess !== undefined || league.substitutePaymentRegime !== undefined;
  if (canonicalFields.length === 0 && !substituteConfigurationChanged) {
    const [result] = await db.update(leagues).set(league).where(eq(leagues.id, id)).returning();
    cacheInvalidate('leagues:');
    return result;
  }

  const result = await db.transaction(async (tx) => {
    const [scope] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues)
      .where(eq(leagues.id, id));
    if (!scope) throw new Error(`League with ID ${id} not found`);

    await lockLeagueSchedule(tx, scope.organizationId, id);
    const [current] = await tx.select().from(leagues).where(eq(leagues.id, id)).for('update');
    if (!current || current.organizationId !== scope.organizationId) {
      throw new Error('League organization changed while acquiring its schedule lock');
    }

    const changedFields = canonicalFields.filter((field) => !sameCanonicalValue(field, league[field], current[field]));
    if (changedFields.includes('payingLineupSize')) {
      const requestedSize = league.payingLineupSize;
      if (requestedSize !== undefined && requestedSize !== null && current.organizationId !== null) {
        const [outOfRange] = await tx.select({ id: teamPaymentSlots.id })
          .from(teamPaymentSlots)
          .where(and(
            eq(teamPaymentSlots.organizationId, current.organizationId),
            eq(teamPaymentSlots.leagueId, id),
            sql`${teamPaymentSlots.slotIndex} >= ${requestedSize}`,
          ))
          .limit(1);
        if (outOfRange) throw new LeagueCanonicalScheduleLockedError();
      }
    }
    if (changedFields.length > 0 && await hasLeagueOccurrenceEvidence(tx, current.organizationId, id)) {
      if (changedFields.length === 1 && changedFields[0] === 'paymentMode') throw new LeaguePaymentModeLockedError();
      throw new LeagueCanonicalScheduleLockedError();
    }

    const substituteConfigChanged =
      (league.substituteAccess !== undefined && !sameValue(league.substituteAccess, current.substituteAccess))
      || (league.substitutePaymentRegime !== undefined && !sameValue(league.substitutePaymentRegime, current.substitutePaymentRegime));
    if (substituteConfigChanged) {
      if (current.organizationId !== null) {
        const [responsibility] = await tx.select({ id: occurrencePaymentResponsibilities.id })
          .from(occurrencePaymentResponsibilities)
          .where(and(
            eq(occurrencePaymentResponsibilities.organizationId, current.organizationId),
            eq(occurrencePaymentResponsibilities.leagueId, id),
          ))
          .limit(1);
        if (responsibility || await hasOperationalLeagueOccurrenceEvidence(tx, current.organizationId, id)) {
          throw new LeagueSubstituteConfigurationLockedError();
        }
      }
    }

    const [updated] = await tx.update(leagues).set(league).where(eq(leagues.id, id)).returning();
    if (!updated) throw new Error(`League with ID ${id} not found`);
    return updated;
  });
  cacheInvalidate('leagues:');
  return result;
}

export async function deleteLeague(id: number, organizationId: number | null): Promise<number[]> {
  let affectedBowlerIds: number[] = [];

  await db.transaction(async (tx) => {
    // This is the shared schedule-mutation lock contract. A2 generation and
    // every future canonical schedule mutation must take this same lock
    // before reading or writing the league's occurrence domain.
    await lockLeagueSchedule(tx, organizationId, id);

    const [league] = await tx
      .select({ id: leagues.id, organizationId: leagues.organizationId })
      .from(leagues)
      .where(eq(leagues.id, id))
      .for('update');
    if (!league) {
      throw new Error(`League with ID ${id} not found`);
    }

    // The route's authorization read is intentionally repeated after the
    // lock. This closes the stale-read window and keeps storage fail-closed
    // if a caller supplies a mismatched tenant identifier.
    if (league.organizationId !== organizationId) {
      throw new Error('League organization does not match deletion scope');
    }

    if (await hasLeagueOccurrenceEvidence(tx, league.organizationId, id)) {
      throw new LeagueOccurrenceEvidenceExistsError();
    }

    const retainedRoster = await tx
      .select({ bowlerId: bowlerLeagues.bowlerId })
      .from(bowlerLeagues)
      .where(and(
        eq(bowlerLeagues.leagueId, id),
        eq(bowlerLeagues.active, true),
      ));
    affectedBowlerIds = Array.from(new Set(retainedRoster.map((row) => row.bowlerId)));

    // Preserve the legacy route behavior: every bowler found through a team
    // row is deactivated/reset before that team's roster is removed. These
    // writes deliberately use this transaction's executor rather than the
    // standalone storage helpers, so a later failure rolls them back too.
    const leagueOrganizationPredicate = league.organizationId === null
      ? isNull(leagues.organizationId)
      : eq(leagues.organizationId, league.organizationId);
    const teamBowlers = await tx
      .selectDistinct({ id: bowlers.id })
      .from(bowlers)
      .innerJoin(bowlerLeagues, eq(bowlerLeagues.bowlerId, bowlers.id))
      .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
      .where(and(
        eq(leagues.id, id),
        leagueOrganizationPredicate,
      ));
    const teamBowlerIds = teamBowlers.map((row) => row.id);
    if (teamBowlerIds.length > 0) {
      await tx
        .update(bowlers)
        .set({ active: false, order: 0 })
        .where(inArray(bowlers.id, teamBowlerIds));
    }

    const leagueTeams = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.leagueId, id))
      .for('update');
    for (const team of leagueTeams) {
      await tx.delete(teams).where(eq(teams.id, team.id));
    }

    await tx.delete(leagues).where(eq(leagues.id, id));
  });

  // Cache state and external provider state are intentionally post-commit
  // effects. A conflict or rollback above therefore cannot publish a false
  // deletion to another worker or to the external bowler resync path.
  cacheInvalidate('leagues:');
  cacheInvalidate('bowlers:');
  return affectedBowlerIds;
}

export async function archiveLeague(id: number): Promise<League> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, id)).limit(1);
    if (!current) throw new Error(`League with ID ${id} not found`);
    if (current.organizationId !== null) await lockLeagueSchedule(tx, current.organizationId, id);
    const [updated] = await tx.update(leagues).set({ active: false }).where(eq(leagues.id, id)).returning();
    return updated;
  });
  cacheInvalidate('leagues:');
  return result;
}

export async function restoreLeague(id: number): Promise<League> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, id)).limit(1);
    if (!current) throw new Error(`League with ID ${id} not found`);
    if (current.organizationId !== null) await lockLeagueSchedule(tx, current.organizationId, id);
    const [updated] = await tx.update(leagues).set({ active: true }).where(eq(leagues.id, id)).returning();
    return updated;
  });
  cacheInvalidate('leagues:');
  return result;
}

export async function getLeaguesByIds(ids: number[]): Promise<League[]> {
  if (ids.length === 0) return [];
  return db.select().from(leagues).where(inArray(leagues.id, ids));
}
