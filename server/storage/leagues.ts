import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerLeagues,
  bowlers,
  paymentSchedules,
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
import { withLegacyScheduledCycleLocksForLeague } from '../services/scheduled-payment-cycle-lock.js';
import { revokeStandingAutopayForArchivedLeagueInTransaction } from '../services/roster-standing-autopay.js';

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

export class LeagueArchivedReadOnlyError extends Error {
  constructor() {
    super('Inactive canonical leagues are read-only archives and cannot be edited or reactivated');
    this.name = 'LeagueArchivedReadOnlyError';
  }
}

export class LeagueRetiredLegacyError extends Error {
  constructor() {
    super('Retired legacy leagues are permanently inactive and immutable');
    this.name = 'LeagueRetiredLegacyError';
  }
}

const CANONICAL_UPDATE_FIELDS = [
  'active',
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
      .where(and(eq(leagues.organizationId, organizationId), eq(leagues.scheduleAuthority, 'canonical')))
      .orderBy(leagues.name)
  );
}

export async function getAllLeaguesSystemAdmin(): Promise<League[]> {
  // Org-less resource policy (see server/utils/access-control.ts):
  // exclude leagues whose organization_id IS NULL. They are only surfaced via
  // the explicit /api/system-admin/orphaned-data-counts diagnostic endpoint.
  return cacheFetch('leagues:all', LEAGUES_TTL, () =>
    db.select().from(leagues).where(and(isNotNull(leagues.organizationId), eq(leagues.scheduleAuthority, 'canonical'))).orderBy(leagues.id)
  );
}

export async function getLeague(id: number): Promise<League | undefined> {
  return cacheFetch(`leagues:id:${id}`, LEAGUES_TTL, async () => {
    const [result] = await db.select().from(leagues).where(and(eq(leagues.id, id), eq(leagues.scheduleAuthority, 'canonical')));
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
    const result = await db.transaction(async (tx) => {
      const [scope] = await tx.select({ organizationId: leagues.organizationId })
        .from(leagues).where(eq(leagues.id, id)).limit(1);
      if (!scope) throw new Error(`League with ID ${id} not found`);
      await lockLeagueSchedule(tx, scope.organizationId, id);
      const scopedWhere = scope.organizationId === null
        ? and(eq(leagues.id, id), isNull(leagues.organizationId))
        : and(eq(leagues.id, id), eq(leagues.organizationId, scope.organizationId));
      const [current] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
        .from(leagues).where(scopedWhere).limit(1).for('update');
      if (!current) throw new Error(`League with ID ${id} not found`);
      if (current.scheduleAuthority === 'retired_legacy') throw new LeagueRetiredLegacyError();
      if (!current.active) throw new LeagueArchivedReadOnlyError();
      const [updated] = await tx.update(leagues).set(league).where(scopedWhere).returning();
      if (!updated) throw new Error(`League with ID ${id} not found`);
      return updated;
    });
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
    if (current.scheduleAuthority === 'retired_legacy') throw new LeagueRetiredLegacyError();
    if (!current.active) throw new LeagueArchivedReadOnlyError();

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
    const scheduleFieldsChanged = changedFields.filter((field) => field !== 'active');
    if (scheduleFieldsChanged.length > 0 && await hasLeagueOccurrenceEvidence(tx, current.organizationId, id)) {
      if (scheduleFieldsChanged.length === 1 && scheduleFieldsChanged[0] === 'paymentMode') throw new LeaguePaymentModeLockedError();
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

    if (league.active === false && current.active && current.organizationId !== null) {
      await revokeStandingAutopayForArchivedLeagueInTransaction(tx, {
        organizationId: current.organizationId,
        leagueId: id,
      });
    }
    const [updated] = await tx.update(leagues).set(league).where(and(
      eq(leagues.id, id),
      current.organizationId === null ? isNull(leagues.organizationId) : eq(leagues.organizationId, current.organizationId),
    )).returning();
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
      .select({ id: leagues.id, organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
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
    if (league.scheduleAuthority === 'retired_legacy') throw new LeagueRetiredLegacyError();
    if (!league.active) throw new LeagueArchivedReadOnlyError();

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

export async function archiveLeague(id: number, organizationId?: number | null): Promise<League> {
  const result = await withLegacyScheduledCycleLocksForLeague(id, () => db.transaction(async (tx) => {
    // The first read supplies the tenant key needed by the advisory lock. All
    // authorization-sensitive state is re-read under that lock below.
    const [scope] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, id)).limit(1);
    if (!scope) throw new Error(`League with ID ${id} not found`);
    if (organizationId !== undefined && scope.organizationId !== organizationId) {
      throw new Error('League organization does not match archive scope');
    }
    if (scope.organizationId !== null) await lockLeagueSchedule(tx, scope.organizationId, id);
    const scopedWhere = scope.organizationId === null
      ? and(eq(leagues.id, id), isNull(leagues.organizationId))
      : and(eq(leagues.id, id), eq(leagues.organizationId, scope.organizationId));
    const [current] = await tx.select().from(leagues).where(scopedWhere).limit(1).for('update');
    if (!current) throw new Error(`League with ID ${id} not found`);
    if (current.scheduleAuthority === 'retired_legacy') throw new LeagueRetiredLegacyError();
    if (current.organizationId !== null) {
      await revokeStandingAutopayForArchivedLeagueInTransaction(tx, {
        organizationId: current.organizationId,
        leagueId: id,
      });
    }
    // Legacy node-schedule callbacks may already be queued in memory. Keep
    // the durable cursor permanently fenced when an archive wins the league
    // lock so a callback can never dispatch the retired schedule.
    await tx.update(paymentSchedules).set({
      active: false,
      cancelledAt: new Date().toISOString(),
      cancelReason: "league_archived",
    }).where(eq(paymentSchedules.leagueId, id));
    const [updated] = await tx.update(leagues).set({ active: false }).where(scopedWhere).returning();
    if (!updated) throw new Error(`League with ID ${id} not found`);
    return updated;
  }));
  cacheInvalidate('leagues:');
  return result;
}

export async function restoreLeague(id: number): Promise<League> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, id)).limit(1);
    if (!current) throw new Error(`League with ID ${id} not found`);
    if (current.scheduleAuthority === 'retired_legacy') throw new LeagueRetiredLegacyError();
    if (!current.active) throw new LeagueArchivedReadOnlyError();
    if (current.organizationId !== null) await lockLeagueSchedule(tx, current.organizationId, id);
    const [updated] = await tx.update(leagues).set({ active: true }).where(eq(leagues.id, id)).returning();
    return updated;
  });
  cacheInvalidate('leagues:');
  return result;
}

export async function getLeaguesByIds(ids: number[]): Promise<League[]> {
  if (ids.length === 0) return [];
  return db.select().from(leagues).where(and(inArray(leagues.id, ids), eq(leagues.scheduleAuthority, 'canonical')));
}

/** Bounded, tenant-scoped diagnostics for immutable retired legacy evidence. */
export async function getRetiredLegacyScheduleDiagnostics(input: { organizationId: number; limit?: number }) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const result = await db.execute(sql`
    SELECT l.id AS "leagueId", l.organization_id AS "organizationId", l.name,
      l.schedule_authority AS "scheduleAuthority", l.active,
      (SELECT count(*)::integer FROM league_occurrence_generation_runs r
        WHERE r.organization_id = l.organization_id AND r.league_id = l.id) AS "generationRunCount",
      (SELECT count(*)::integer FROM league_occurrences o
        WHERE o.organization_id = l.organization_id AND o.league_id = l.id) AS "occurrenceCount",
      (SELECT count(*)::integer FROM canonical_collection_groups g
        WHERE g.organization_id = l.organization_id AND g.league_id = l.id) AS "collectionGroupCount",
      (SELECT count(*)::integer FROM payment_schedules s
        WHERE s.league_id = l.id AND s.active = TRUE) AS "activeLegacyScheduleCount",
      (SELECT count(*)::integer FROM autopay_consents c
        WHERE c.organization_id = l.organization_id AND c.league_id = l.id AND c.state = 'active') AS "activeConsentCount",
      (SELECT count(*)::integer FROM payment_operations p
        WHERE p.organization_id = l.organization_id AND p.league_id = l.id
          AND p.status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required')) AS "nonterminalOperationCount",
      (SELECT count(*)::integer FROM payment_operation_roster_snapshot_items i
        WHERE i.organization_id = l.organization_id AND i.league_id = l.id AND i.state = 'reserved') AS "reservedSnapshotCount"
    FROM leagues l
    WHERE l.organization_id = ${input.organizationId}
      AND l.schedule_authority = 'retired_legacy'
    ORDER BY l.id
    LIMIT ${limit}
  `);
  return result.rows.map((row) => {
    const evidence = row;
    const reasons: string[] = [];
    if (Number(evidence.activeLegacyScheduleCount) > 0) reasons.push("active_legacy_schedule");
    if (Number(evidence.activeConsentCount) > 0) reasons.push("active_consent");
    if (Number(evidence.nonterminalOperationCount) > 0) reasons.push("nonterminal_operation");
    if (Number(evidence.reservedSnapshotCount) > 0) reasons.push("reserved_snapshot");
    return { ...evidence, evidence: reasons, reason: reasons.length > 0 ? reasons.join(",") : "retired_legacy_schedule_authority" };
  });
}
