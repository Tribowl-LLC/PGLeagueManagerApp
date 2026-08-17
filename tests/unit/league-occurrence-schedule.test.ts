import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  LeagueOccurrence,
  LeagueOccurrenceBillingTerm,
  LeagueOccurrenceGenerationRun,
  LeagueOccurrenceRelationship,
  LeagueScheduleException,
} from "@shared/schema/canonical-occurrences";
import {
  buildLeagueOccurrenceSchedule,
  LeagueOccurrenceScheduleError,
  type BuildLeagueOccurrenceScheduleInput,
} from "../../server/services/league-occurrence-schedule";

const organizationId = 11;
const leagueId = 22;
const publishedAt = "2029-01-01T00:00:00.000Z";
const commandId = "10000000-0000-4000-8000-000000000001";

function occurrence(overrides: Partial<LeagueOccurrence> = {}): LeagueOccurrence {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    organizationId,
    leagueId,
    locationId: 33,
    generationKey: "occurrence:v1:stable",
    generationRunId: "30000000-0000-4000-8000-000000000001",
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: "2031-03-09",
    authoritativeLocalStartTime: "19:30:00",
    timezone: "America/Detroit",
    startAt: "2031-03-09T23:30:00.000Z",
    selectedUtcOffsetMinutes: -240,
    foldResolution: "unambiguous",
    resolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    currentRevision: 1,
    lastCommandId: commandId,
    publishedAt,
    publishedByUserId: 1,
    publicationCommandId: commandId,
    lockedAt: null,
    lockedByUserId: null,
    lockReason: null,
    lockCommandId: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationCommandId: null,
    completedAt: null,
    completedByUserId: null,
    completionCommandId: null,
    discardedAt: null,
    discardedByUserId: null,
    discardCommandId: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...overrides,
  };
}

function term(overrides: Partial<LeagueOccurrenceBillingTerm> = {}): LeagueOccurrenceBillingTerm {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    organizationId,
    leagueId,
    occurrenceId: "20000000-0000-4000-8000-000000000001",
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: 7,
    version: 1,
    state: "published",
    currentRevision: 1,
    lastCommandId: commandId,
    publishedAt,
    publishedByUserId: 1,
    publicationCommandId: commandId,
    supersededAt: null,
    supersededByCommandId: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...overrides,
  };
}

function exception(overrides: Partial<LeagueScheduleException> = {}): LeagueScheduleException {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    organizationId,
    leagueId,
    kind: "skip",
    localDate: "2031-03-16",
    timezone: "America/Detroit",
    source: "generator",
    lifecycle: "published",
    reason: "Facility unavailable",
    generationRunId: "30000000-0000-4000-8000-000000000001",
    currentRevision: 1,
    lastCommandId: commandId,
    publishedAt,
    publishedByUserId: 1,
    publicationCommandId: commandId,
    revokedAt: null,
    revokedByUserId: null,
    revocationCommandId: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...overrides,
  };
}

function relationship(overrides: Partial<LeagueOccurrenceRelationship> = {}): LeagueOccurrenceRelationship {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    organizationId,
    leagueId,
    kind: "makeup_for",
    sourceOccurrenceId: "20000000-0000-4000-8000-000000000002",
    targetOccurrenceId: "20000000-0000-4000-8000-000000000001",
    state: "published",
    currentRevision: 2,
    lastCommandId: commandId,
    publishedAt,
    publishedByUserId: 1,
    publicationCommandId: commandId,
    revokedAt: null,
    revokedByUserId: null,
    revocationCommandId: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...overrides,
  };
}

function run(overrides: Partial<LeagueOccurrenceGenerationRun> = {}): LeagueOccurrenceGenerationRun {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId,
    leagueId,
    originatingCommandId: commandId,
    generatorVersion: "canonical-occurrence-generator/1",
    inputFingerprint: "a".repeat(64),
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { snapshotContractVersion: "fall-draft-generation-input-snapshot/3" },
    rangeStartDate: "2031-03-09",
    rangeEndDate: "2031-03-30",
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 1,
    skippedDateCount: 1,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: publishedAt,
    approvedByUserId: 1,
    approvalCommandId: commandId,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    rejectionCommandId: null,
    supersededAt: null,
    supersededByCommandId: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...overrides,
  };
}

function input(overrides: Partial<BuildLeagueOccurrenceScheduleInput> = {}): BuildLeagueOccurrenceScheduleInput {
  return {
    organizationId,
    leagueId,
    includeAdministratorEvidence: true,
    databaseNow: "2030-01-01T00:00:00.000Z",
    league: {
      id: leagueId,
      organizationId,
      active: true,
      seasonStart: "2031-03-02T00:00:00.000Z",
      seasonEnd: "2031-03-30T00:00:00.000Z",
      weekDay: "Sunday",
      competitionStartTime: "19:30",
      timezone: "America/Detroit",
      totalBowlingWeeks: 3,
      skipDates: ["2031-03-16"],
      cancelledDates: ["2031-03-23"],
    },
    canonical: {
      generationRuns: [run()],
      occurrences: [occurrence()],
      billingTerms: [term()],
      scheduleExceptions: [exception()],
      relationships: [],
      linkedActivityOccurrenceIds: new Set(),
      hasAnyCanonicalEvidence: true,
    },
    ...overrides,
  };
}

describe("league occurrence schedule source selection", () => {
  it("consumes published Summer and published/locked future canonical schedules without legacy blending", () => {
    const summer = buildLeagueOccurrenceSchedule(input({
      league: { ...input().league, seasonStart: "2031-06-01", skipDates: ["2040-01-01"], cancelledDates: ["2040-01-08"] },
      canonical: { ...input().canonical, generationRuns: [run({ normalizedInputSnapshot: { contractVersion: "canonical-occurrence-input/1" } })] },
    }));
    expect(summer.authoritativeSource).toBe("canonical");
    expect(summer.occurrences).toHaveLength(1);
    expect(summer.occurrences[0].occurrenceId).toBe("20000000-0000-4000-8000-000000000001");
    expect(summer.occurrences.map((row) => row.authoritativeLocalDate)).not.toContain("2040-01-08");

    const locked = occurrence({
      lifecycle: "locked",
      lockedAt: publishedAt,
      lockedByUserId: 1,
      lockReason: "Linked operational evidence",
      lockCommandId: commandId,
    });
    const fall = buildLeagueOccurrenceSchedule(input({
      league: { ...input().league, seasonStart: "2031-09-07" },
      canonical: { ...input().canonical, occurrences: [locked] },
    }));
    expect(fall.occurrences[0]).toMatchObject({ lifecycle: "locked", effectivelyLocked: true });
    expect(fall.occurrences[0].effectiveLockReasons).toContain("canonical_lock");
  });

  it("uses the established legacy projection only when no operational canonical state exists", () => {
    const legacy = buildLeagueOccurrenceSchedule(input({
      canonical: {
        generationRuns: [], occurrences: [], billingTerms: [], scheduleExceptions: [], relationships: [],
        linkedActivityOccurrenceIds: new Set(), hasAnyCanonicalEvidence: false,
      },
    }));
    expect(legacy.authoritativeSource).toBe("legacy_fallback");
    expect(legacy.occurrences.map((row) => ({
      id: row.occurrenceId,
      date: row.authoritativeLocalDate,
      status: row.status,
      planned: row.plannedOrdinal,
      competition: row.competitionNumber,
    }))).toEqual([
      { id: null, date: "2031-03-02", status: "scheduled", planned: 1, competition: 1 },
      { id: null, date: "2031-03-09", status: "scheduled", planned: 2, competition: 2 },
      { id: null, date: "2031-03-23", status: "cancelled", planned: 3, competition: null },
    ]);
    expect(legacy.skippedDates).toEqual([expect.objectContaining({
      localDate: "2031-03-16", durableCanonicalException: false, exceptionId: null,
    })]);
    expect(legacy.administrator?.fallRecoveryEligible).toBe(false);
  });

  it("makes contextual recovery available only for an active Fall league with zero canonical evidence", () => {
    const recovery = buildLeagueOccurrenceSchedule(input({
      league: { ...input().league, seasonStart: "2031-09-07" },
      canonical: {
        generationRuns: [], occurrences: [], billingTerms: [], scheduleExceptions: [], relationships: [],
        linkedActivityOccurrenceIds: new Set(), hasAnyCanonicalEvidence: false,
      },
    }));
    expect(recovery.administrator?.fallRecoveryEligible).toBe(true);
  });

  it("keeps draft-only and rejected/discarded/revoked/superseded evidence out of operational output", () => {
    const draft = occurrence({ lifecycle: "draft", publishedAt: null, publishedByUserId: null, publicationCommandId: null });
    const discarded = occurrence({
      id: "20000000-0000-4000-8000-000000000009",
      lifecycle: "draft",
      status: "discarded",
      plannedOrdinal: null,
      competitionNumber: null,
      publishedAt: null,
      publishedByUserId: null,
      publicationCommandId: null,
      discardedAt: publishedAt,
      discardedByUserId: 1,
      discardCommandId: commandId,
    });
    const evidence = buildLeagueOccurrenceSchedule(input({
      canonical: {
        generationRuns: [run({
          state: "rejected", approvedAt: null, approvedByUserId: null, approvalCommandId: null,
          rejectedAt: publishedAt, rejectedByUserId: 1, rejectionReason: "Not approved", rejectionCommandId: commandId,
        }), run({
          id: "30000000-0000-4000-8000-000000000002", sourceScheduleRevision: 2, state: "superseded",
          normalizedInputSnapshot: { contractVersion: "canonical-occurrence-input/1" },
          supersededAt: publishedAt, supersededByCommandId: commandId,
        })],
        occurrences: [draft, discarded],
        billingTerms: [term({ state: "superseded", publishedAt: null, publishedByUserId: null, publicationCommandId: null, supersededAt: publishedAt, supersededByCommandId: commandId })],
        scheduleExceptions: [exception({ lifecycle: "revoked", publishedAt: null, publishedByUserId: null, publicationCommandId: null, revokedAt: publishedAt, revokedByUserId: 1, revocationCommandId: commandId })],
        relationships: [relationship({ state: "revoked", revokedAt: publishedAt, revokedByUserId: 1, revocationCommandId: commandId })],
        linkedActivityOccurrenceIds: new Set(),
        hasAnyCanonicalEvidence: true,
      },
    }));
    expect(evidence.authoritativeSource).toBe("legacy_fallback");
    expect(evidence.occurrences.every((row) => row.occurrenceId === null)).toBe(true);
    expect(evidence.administrator).toMatchObject({
      hasDraftEvidence: true, hasRejectedEvidence: true, hasSupersededEvidence: true, hasRevokedEvidence: true,
      c2ReviewAvailable: true, reviewContractFamily: "fall", fallRecoveryEligible: false,
    });
  });

  it("retains cancelled and rescheduled UUID identity while keeping all ordinals distinct", () => {
    const id = "20000000-0000-4000-8000-000000000001";
    const current = occurrence({
      id,
      status: "cancelled",
      authoritativeLocalDate: "2031-04-06",
      startAt: "2031-04-06T23:30:00.000Z",
      plannedOrdinal: 4,
      competitionNumber: 9,
      currentRevision: 3,
      competitive: false,
      countsInStandings: false,
      cancelledAt: publishedAt,
      cancelledByUserId: 1,
      cancellationCommandId: commandId,
    });
    const schedule = buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        generationRuns: [run({ candidateOccurrenceCount: 1, skippedDateCount: 0 })],
        occurrences: [current],
        billingTerms: [term({ billingOrdinal: 12 })],
        scheduleExceptions: [],
      },
    }));
    expect(schedule.occurrences[0]).toMatchObject({
      occurrenceId: id,
      authoritativeLocalDate: "2031-04-06",
      status: "cancelled",
      plannedOrdinal: 4,
      competitionNumber: 9,
      billing: { billingOrdinal: 12 },
      currentRevision: 3,
    });
  });

  it("represents a published skip without fabricating an occurrence", () => {
    const schedule = buildLeagueOccurrenceSchedule(input());
    expect(schedule.skippedDates).toEqual([expect.objectContaining({
      exceptionId: "50000000-0000-4000-8000-000000000001",
      localDate: "2031-03-16",
      durableCanonicalException: true,
    })]);
    expect(schedule.occurrences.some((row) => row.authoritativeLocalDate === "2031-03-16")).toBe(false);
  });

  it("presents special/makeup relationships and deterministically orders equal-date sessions", () => {
    const regular = occurrence({ id: "20000000-0000-4000-8000-000000000001", plannedOrdinal: 3, competitionNumber: 3 });
    const makeup = occurrence({
      id: "20000000-0000-4000-8000-000000000002",
      generationKey: "makeup",
      generationRunId: null,
      kind: "makeup",
      plannedOrdinal: 4,
      competitionNumber: 4,
    });
    const special = occurrence({
      id: "20000000-0000-4000-8000-000000000003",
      generationKey: "rolloff",
      generationRunId: null,
      kind: "rolloff",
      plannedOrdinal: 5,
      competitionNumber: 5,
      authoritativeLocalStartTime: "20:00:00",
      startAt: "2031-03-10T00:00:00.000Z",
    });
    const schedule = buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        generationRuns: [run({ candidateOccurrenceCount: 1, skippedDateCount: 0 })],
        occurrences: [special, makeup, regular],
        billingTerms: [],
        scheduleExceptions: [],
        relationships: [relationship()],
      },
    }));
    expect(schedule.occurrences.map((row) => row.occurrenceId)).toEqual([regular.id, makeup.id, special.id]);
    expect(schedule.occurrences.find((row) => row.occurrenceId === makeup.id)?.relationships).toEqual([
      expect.objectContaining({ kind: "makeup_for", role: "source", relatedOccurrenceId: regular.id }),
    ]);
  });

  it("preserves DST resolver evidence and local calendar fields independently of host timezone", () => {
    const prior = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      const schedule = buildLeagueOccurrenceSchedule(input({
        canonical: {
          ...input().canonical,
          generationRuns: [run({ candidateOccurrenceCount: 1, skippedDateCount: 0 })],
          scheduleExceptions: [],
        },
      }));
      expect(schedule.occurrences[0]).toMatchObject({
        authoritativeLocalDate: "2031-03-09",
        authoritativeLocalStartTime: "19:30:00",
        timezone: "America/Detroit",
        startAt: "2031-03-09T23:30:00.000Z",
        selectedUtcOffsetMinutes: -240,
        foldResolution: "unambiguous",
        resolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
      });
    } finally {
      process.env.TZ = prior;
    }
  });

  it("computes effective locks from read evidence without stamping canonical locks", () => {
    const row = occurrence();
    const schedule = buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        generationRuns: [run({ candidateOccurrenceCount: 1, skippedDateCount: 0 })],
        scheduleExceptions: [],
        linkedActivityOccurrenceIds: new Set([row.id]),
      },
    }));
    expect(schedule.occurrences[0]).toMatchObject({ lifecycle: "published", effectivelyLocked: true });
    expect(schedule.occurrences[0].effectiveLockReasons).toEqual(["linked_activity"]);
  });

  it("fails closed for mixed, incomplete, overlapping, or cross-tenant canonical state", () => {
    const draft = occurrence({
      id: "20000000-0000-4000-8000-000000000002",
      generationKey: "draft",
      lifecycle: "draft",
      publishedAt: null,
      publishedByUserId: null,
      publicationCommandId: null,
    });
    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: { ...input().canonical, occurrences: [occurrence(), draft], scheduleExceptions: [] },
    }))).toThrowError(LeagueOccurrenceScheduleError);
    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: { ...input().canonical, occurrences: [] },
    }))).toThrow(/incomplete/);
    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: { ...input().canonical, scheduleExceptions: [exception({ localDate: "2031-03-09" })] },
    }))).toThrow(/overlaps/);
    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: { ...input().canonical, occurrences: [occurrence({ organizationId: organizationId + 1 })] },
    }))).toThrow(/outside the authorized tenant/);
  });

  it("rejects partial or inconsistently associated operational generation sets", () => {
    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        generationRuns: [run({ candidateOccurrenceCount: 3, generatedOccurrenceCount: 2 })],
      },
    }))).toThrow(/partial or non-operational occurrence set/);

    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: { ...input().canonical, scheduleExceptions: [] },
    }))).toThrow(/partial schedule-exception set/);

    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        generationRuns: [run(), run({
          id: "30000000-0000-4000-8000-000000000002",
          sourceScheduleRevision: 2,
        })],
      },
    }))).toThrow(/exactly one current approved or applied generation run/);

    expect(() => buildLeagueOccurrenceSchedule(input({
      canonical: {
        ...input().canonical,
        occurrences: [occurrence(), occurrence({
          id: "20000000-0000-4000-8000-000000000002",
          generationKey: "unassociated-regular",
          generationRunId: null,
          plannedOrdinal: 2,
          competitionNumber: 2,
        })],
      },
    }))).toThrow(/audited later special session/);
  });

  it("does not import provider or payment services from the E1 read implementation", () => {
    const source = readFileSync(new URL("../../server/services/league-occurrence-schedule.ts", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import ")).join("\n");
    expect(imports).not.toMatch(/square|provider|payments|payment-/i);
  });
});
