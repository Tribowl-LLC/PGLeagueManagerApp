import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { rotatingOccurrenceAssignments } from "@shared/schema";

const queryState = vi.hoisted(() => ({
  rows: [] as unknown[][],
  fromTables: [] as unknown[],
  whereConditions: [] as SQL[],
}));
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://unit.test/leaguevault";
  process.env.SESSION_SECRET = "unit-test-session-secret";
  process.env.FIELD_ENCRYPTION_KEY = "0".repeat(64);
});

vi.mock("../../server/db.js", () => ({
  db: {
    select: vi.fn(() => {
      const rows = queryState.rows.shift() ?? [];
      const builder = {
        from(table: unknown) {
          queryState.fromTables.push(table);
          return builder;
        },
        innerJoin() { return builder; },
        leftJoin() { return builder; },
        where(condition: SQL) { queryState.whereConditions.push(condition); return builder; },
        orderBy() { return builder; },
        limit() { return builder; },
        for() { return builder; },
        then<TResult1 = unknown[], TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2> {
          return Promise.resolve(rows).then(onfulfilled, onrejected);
        },
      };
      return builder;
    }),
  },
}));

import {
  readRosterPaymentResponsibilityV2,
  readTeamEnvelopeRosterReadContext,
} from "../../server/services/roster-payment-core.js";

const organizationId = 3;
const leagueId = 19075;
const teamId = 20425;
const occurrenceId = "00000000-0000-4000-8000-000000000029";

function metadataRows(slotIndexes: readonly number[] = [0, 1, 2, 3]): unknown[][] {
  const mainBowlerIds = [100, 101, 102];
  const slots = [
    ...mainBowlerIds.map((mainBowlerId, slotIndex) => ({ teamId, slotIndex, occupant: "main", mainBowlerId })),
    { teamId, slotIndex: 3, occupant: "rotating", mainBowlerId: null },
  ].filter((slot) => slotIndexes.includes(slot.slotIndex));
  return [
    [{ id: leagueId, organizationId, locationId: 1, payingLineupSize: 4, paymentMode: "weekly", weeklyFee: 2_000, substituteAccess: "team_only", substitutePaymentRegime: "team_choice", lineageFee: null, prizeFundFee: null }],
    [{ id: teamId, name: "Tuesday Team", number: 1 }],
    slots,
    [],
    [{ id: 103, name: "Rotation Bowler", teamId }],
    [],
    [],
    mainBowlerIds.map((bowlerId) => ({ bowlerId, teamId })),
    slots.map((slot) => ({ ...slot, id: `slot-${slot.slotIndex}`, currentRevision: 1 })),
    [{ teamId, bowlerId: 103 }],
  ];
}

function rosterDisplayRows(): unknown[] {
  return [
    { id: 40, teamId, bowlerId: 100, displayName: "Zoe Lane", activeProfile: true, order: 0, joinedAt: "2026-09-01T00:00:00.000Z" },
    { id: 10, teamId, bowlerId: 101, displayName: "Mina Quinn", activeProfile: true, order: 1, joinedAt: "2026-09-03T00:00:00.000Z" },
    { id: 20, teamId, bowlerId: 102, displayName: "Aaron Park", activeProfile: true, order: 1, joinedAt: "2026-09-03T00:00:00.000Z" },
    { id: 30, teamId, bowlerId: 110, displayName: "Inactive Member", activeProfile: false, order: 2, joinedAt: "2026-09-01T00:00:00.000Z" },
    { id: 90, teamId, bowlerId: 101, displayName: "Old Mina Association", activeProfile: true, order: 0, joinedAt: "2026-08-01T00:00:00.000Z" },
  ];
}

function setQueryRows(rows: unknown[][]): void {
  queryState.rows = rows;
  queryState.fromTables = [];
  queryState.whereConditions = [];
}

describe("team envelope roster read context", () => {
  afterEach(() => setQueryRows([]));

  it("reads ordered current roster display metadata within organization scope without querying assignment history", async () => {
    setQueryRows([...metadataRows(), rosterDisplayRows()]);

    const context = await readTeamEnvelopeRosterReadContext({ organizationId, leagueId });

    expect(context).toMatchObject({ organizationId, leagueId, ready: true });
    expect(context.teams[0]).toMatchObject({ id: teamId, eligibleRotatingBowlerIds: [103] });
    expect(context.teams[0]?.slots[3]).toMatchObject({ slotIndex: 3, occupant: "rotating", currentRevision: 1 });
    expect(context).not.toHaveProperty("rotationAssignments");
    expect(context.rosterDisplayMembersByTeam).toEqual([{
      teamId,
      members: [
        { bowlerId: 100, displayName: "Zoe Lane", activeProfile: true },
        { bowlerId: 101, displayName: "Mina Quinn", activeProfile: true },
        { bowlerId: 102, displayName: "Aaron Park", activeProfile: true },
        { bowlerId: 110, displayName: "Inactive Member", activeProfile: false },
      ],
    }]);
    expect(queryState.fromTables).not.toContain(rotatingOccurrenceAssignments);
    const rosterScopeCondition = queryState.whereConditions.at(-1);
    if (!rosterScopeCondition) throw new Error("missing roster metadata query scope");
    const rosterScope = new PgDialect().sqlToQuery(rosterScopeCondition);
    expect(rosterScope.sql).toContain('"bowlers"."organization_id"');
    expect(rosterScope.sql).toContain('"bowler_leagues"."league_id"');
    expect(rosterScope.sql).toContain('"bowler_leagues"."team_id"');
    expect(rosterScope.params).toEqual(expect.arrayContaining([organizationId, leagueId, teamId]));
    expect(queryState.rows).toEqual([]);
  });

  it("fills missing fixed positions only for the envelope report context", async () => {
    setQueryRows([...metadataRows([0, 2]), rosterDisplayRows()]);

    const reportContext = await readTeamEnvelopeRosterReadContext({ organizationId, leagueId });

    expect(reportContext.ready).toBe(false);
    expect(reportContext.teams[0]?.slots.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(reportContext.teams[0]?.slots.find((slot) => slot.slotIndex === 1)).toMatchObject({
      teamId,
      slotIndex: 1,
      occupant: "unassigned",
      mainBowlerId: null,
    });
    expect(reportContext.teams[0]?.slots.find((slot) => slot.slotIndex === 3)).toMatchObject({
      teamId,
      slotIndex: 3,
      occupant: "unassigned",
      mainBowlerId: null,
    });

    setQueryRows([...metadataRows([0, 2]), []]);
    const standardV2Read = await readRosterPaymentResponsibilityV2({ organizationId, leagueId });

    expect(standardV2Read.ready).toBe(false);
    expect(standardV2Read.teams[0]?.slots.map((slot) => slot.slotIndex)).toEqual([0, 2]);
  });

  const staleAssignment = {
    id: "assignment-29",
    organizationId,
    leagueId,
    occurrenceId,
    teamId,
    slotId: "slot-3",
    slotIndex: 3,
    responsibilityId: "voided-responsibility",
    version: 1,
    actualBowlerId: 103,
    correctionReason: null,
    recordedByUserId: 1,
    createdAt: "2026-10-01T12:00:00.000Z",
  };
  const occurrenceRow = { id: occurrenceId, startAt: "2026-09-29T23:00:00.000Z", occurrenceLocalDate: "2026-09-29", plannedOrdinal: 3, status: "scheduled" };

  it("reports a week as unassigned when Manage Payments retired the rotating responsibility", async () => {
    setQueryRows([
      ...metadataRows(),
      [occurrenceRow],
      [],
      [],
      [staleAssignment],
    ]);

    const read = await readRosterPaymentResponsibilityV2({ organizationId, leagueId });

    expect(read.rotationAssignments).toEqual([{
      occurrenceId,
      teamId,
      slotIndex: 3,
      responsibilityId: null,
      obligationIds: [],
      assignmentId: null,
      actualBowlerId: null,
      revision: null,
      assignedAt: null,
      recordedByUserId: null,
    }]);
    expect(queryState.fromTables).toContain(rotatingOccurrenceAssignments);
  });

  it("keeps the standard V2 read fail-closed for an assignment that names a different active responsibility", async () => {
    setQueryRows([
      ...metadataRows(),
      [occurrenceRow],
      [],
      [{ id: "active-responsibility", occurrenceId, teamId, slotIndex: 3, state: "active" }],
      [],
      [staleAssignment],
    ]);

    await expect(readRosterPaymentResponsibilityV2({ organizationId, leagueId })).rejects.toMatchObject({
      code: "ROTATING_ASSIGNMENT_EVIDENCE_INVALID",
      message: "A rotating assignment does not match the current canonical responsibility",
      status: 503,
    });
  });
});
