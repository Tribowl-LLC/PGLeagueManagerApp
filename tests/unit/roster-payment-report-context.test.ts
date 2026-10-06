import { afterEach, describe, expect, it, vi } from "vitest";
import { rotatingOccurrenceAssignments } from "@shared/schema";

const queryState = vi.hoisted(() => ({
  rows: [] as unknown[][],
  fromTables: [] as unknown[],
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
        where() { return builder; },
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

function metadataRows(): unknown[][] {
  const mainBowlerIds = [100, 101, 102];
  const slots = [
    ...mainBowlerIds.map((mainBowlerId, slotIndex) => ({ teamId, slotIndex, occupant: "main", mainBowlerId })),
    { teamId, slotIndex: 3, occupant: "rotating", mainBowlerId: null },
  ];
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

function setQueryRows(rows: unknown[][]): void {
  queryState.rows = rows;
  queryState.fromTables = [];
}

describe("team envelope roster read context", () => {
  afterEach(() => setQueryRows([]));

  it("reads V2 lineup and pool metadata without querying assignment history", async () => {
    setQueryRows(metadataRows());

    const context = await readTeamEnvelopeRosterReadContext({ organizationId, leagueId });

    expect(context).toMatchObject({ organizationId, leagueId, ready: true });
    expect(context.teams[0]).toMatchObject({ id: teamId, eligibleRotatingBowlerIds: [103] });
    expect(context.teams[0]?.slots[3]).toMatchObject({ slotIndex: 3, occupant: "rotating", currentRevision: 1 });
    expect(context).not.toHaveProperty("rotationAssignments");
    expect(queryState.fromTables).not.toContain(rotatingOccurrenceAssignments);
    expect(queryState.rows).toEqual([]);
  });

  it("keeps the standard V2 read fail-closed for an assignment without an active responsibility", async () => {
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
    setQueryRows([
      ...metadataRows(),
      [{ id: occurrenceId, startAt: "2026-09-29T23:00:00.000Z", occurrenceLocalDate: "2026-09-29", plannedOrdinal: 3, status: "scheduled" }],
      [],
      [],
      [staleAssignment],
    ]);

    await expect(readRosterPaymentResponsibilityV2({ organizationId, leagueId })).rejects.toMatchObject({
      code: "ROTATING_ASSIGNMENT_EVIDENCE_INVALID",
      message: "A rotating assignment does not match the current canonical responsibility",
      status: 503,
    });
    expect(queryState.fromTables).toContain(rotatingOccurrenceAssignments);
  });
});
