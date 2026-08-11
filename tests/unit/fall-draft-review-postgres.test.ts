import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancyRevisions,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  games,
  leagues,
  locations,
  organizations,
  payments,
  users,
} from "@shared/schema";
import type { FallDraftGeneratorSemantics, FallDraftPreview } from "@shared/fall-draft-generation";
import {
  FALL_DRAFT_APPROVE_REQUEST_VERSION,
  FALL_DRAFT_CANCEL_REQUEST_VERSION,
  FALL_DRAFT_REJECT_REQUEST_VERSION,
  FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
  FALL_DRAFT_RESTORE_REQUEST_VERSION,
  type FallDraftApproveRequest,
  type FallDraftRejectRequest,
  type FallDraftRescheduleRequest,
} from "@shared/fall-draft-review";
import { applyFallDraftGeneration, previewFallDraftGeneration } from "../../server/services/fall-draft-generation";
import {
  approveAndPublishFallDraft,
  cancelFallDraftOccurrence,
  loadFallDraftReview,
  rejectFallDraft,
  rescheduleFallDraftOccurrence,
  restoreFallDraftOccurrence,
} from "../../server/services/fall-draft-review";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
let sequence = 0;

const semantics: FallDraftGeneratorSemantics = {
  billingOrdinalPolicy: "dense_billable",
};

async function fixture(label: string, overrides: Partial<typeof leagues.$inferInsert> = {}) {
  const unique = `c2-${label}-${++sequence}`;
  const [organization] = await db.insert(organizations).values({ name: unique, slug: unique }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture failed");
  organizationsToDelete.push(organization.id);
  const [actor] = await db.insert(users).values({
    email: `${unique}@example.test`, password: "deterministic-hash", name: `${unique} admin`,
    role: "org_admin", organizationId: organization.id,
  }).returning({ id: users.id });
  const [secondActor] = await db.insert(users).values({
    email: `${unique}-second@example.test`, password: "deterministic-hash", name: `${unique} second admin`,
    role: "org_admin", organizationId: organization.id,
  }).returning({ id: users.id });
  const [location] = await db.insert(locations).values({ name: `${unique} location`, organizationId: organization.id }).returning({ id: locations.id });
  if (!actor || !secondActor || !location) throw new Error("C2 actor/location fixture failed");
  const [league] = await db.insert(leagues).values({
    name: `${unique} league`, organizationId: organization.id, locationId: location.id, active: true,
    seasonStart: "2032-08-01", seasonEnd: "2032-08-15", weekDay: "Sunday",
    timezone: "America/New_York", competitionStartTime: "19:00", totalBowlingWeeks: 3,
    weeklyFee: 2_000, skipDates: [], cancelledDates: [], doublePayDates: [], ...overrides,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("C2 league fixture failed");
  return {
    organizationId: organization.id,
    leagueId: league.id,
    actorUserId: actor.id,
    secondActorUserId: secondActor.id,
  };
}

function scope(fixtureValue: Awaited<ReturnType<typeof fixture>>, actorUserId = fixtureValue.actorUserId) {
  return { organizationId: fixtureValue.organizationId, leagueId: fixtureValue.leagueId, actorUserId };
}

async function generateDraft(fixtureValue: Awaited<ReturnType<typeof fixture>>, customSemantics = semantics): Promise<FallDraftPreview> {
  const preview = await previewFallDraftGeneration({ ...scope(fixtureValue), semantics: customSemantics });
  await applyFallDraftGeneration({
    ...scope(fixtureValue),
    apply: {
      contractVersion: "fall-draft-apply-request/2",
      ...customSemantics,
      confirmedPreviewFingerprint: preview.previewFingerprint,
      reason: "Create deterministic C2 test draft",
      idempotencyKey: `c2-generate-${fixtureValue.leagueId}`,
    },
  });
  return preview;
}

async function caughtCode(callback: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await callback();
    return undefined;
  } catch (caught) {
    return caught && typeof caught === "object" && "code" in caught ? String(caught.code) : undefined;
  }
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("C2 Fall draft persisted review and editing", () => {
  it("builds a deterministic complete review and rejects stale review and entity revisions", async () => {
    const f = await fixture("review");
    await generateDraft(f);
    const first = await loadFallDraftReview(scope(f));
    const second = await loadFallDraftReview(scope(f, f.secondActorUserId));
    expect(second.reviewFingerprint).toBe(first.reviewFingerprint);
    expect(second.occurrences).toEqual(first.occurrences);
    expect(first).toMatchObject({
      reviewContractVersion: "fall-draft-review/2",
      reviewFingerprintVersion: "fall-draft-review-fingerprint/2",
      generationRun: { state: "generated" },
      currentLegacyInput: { matches: true },
    });
    expect(first.occurrences.every((row) => row.revisions.length === row.currentRevision)).toBe(true);
    expect(first.billingTerms.every((row) => row.revisions.length === row.currentRevision)).toBe(true);

    const occurrence = first.occurrences[0];
    const request: FallDraftRescheduleRequest = {
      contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
      confirmedReviewFingerprint: first.reviewFingerprint,
      reason: "Move the reviewed future occurrence by one day",
      idempotencyKey: `c2-reschedule-${f.leagueId}`,
      occurrenceId: occurrence.id,
      expectedOccurrenceRevision: occurrence.currentRevision,
      authoritativeLocalDate: "2032-08-02",
      authoritativeLocalStartTime: "19:30:00",
      timezone: "US/Eastern",
    };
    const applied = await rescheduleFallDraftOccurrence({ ...scope(f), request });
    expect(applied.mode).toBe("applied");
    const changed = applied.review.occurrences.find((row) => row.id === occurrence.id);
    expect(changed).toMatchObject({
      id: occurrence.id,
      generationKey: occurrence.generationKey,
      authoritativeLocalDate: "2032-08-02",
      authoritativeLocalStartTime: "19:30:00",
      currentRevision: occurrence.currentRevision + 1,
    });
    expect(changed?.timezone).toBe("America/New_York");
    const retry = await rescheduleFallDraftOccurrence({ ...scope(f), request });
    expect(retry).toMatchObject({ mode: "idempotent_retry", writesPerformed: false, commandIds: applied.commandIds });
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({ ...scope(f), request: { ...request, reason: "Changed reason" } }))).toBe("idempotency_conflict");
    expect(await caughtCode(() => cancelFallDraftOccurrence({
      ...scope(f),
      request: {
        contractVersion: FALL_DRAFT_CANCEL_REQUEST_VERSION,
        confirmedReviewFingerprint: first.reviewFingerprint,
        reason: "This confirmation is stale",
        idempotencyKey: `c2-stale-${f.leagueId}`,
        occurrenceId: first.occurrences[1].id,
        expectedOccurrenceRevision: first.occurrences[1].currentRevision,
      },
    }))).toBe("stale_review");
  });

  it("rejects DST gaps, unresolved folds, incompatible assertions, exact-start, same-day, and exception collisions", async () => {
    const f = await fixture("dst-collisions", { seasonEnd: "2032-08-22", skipDates: ["2032-08-08"] });
    await generateDraft(f);
    const review = await loadFallDraftReview(scope(f));
    const target = review.occurrences[0];
    const common: Pick<FallDraftRescheduleRequest,
      "contractVersion" | "confirmedReviewFingerprint" | "reason" | "occurrenceId"
      | "expectedOccurrenceRevision" | "timezone"> = {
      contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: "Validate a rejected C2 reschedule",
      occurrenceId: target.id,
      expectedOccurrenceRevision: target.currentRevision,
      timezone: "America/New_York",
    };
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: { ...common, idempotencyKey: `c2-gap-${f.leagueId}`, authoritativeLocalDate: "2032-03-14", authoritativeLocalStartTime: "02:30:00" },
    }))).toBe("invalid_dst_input");
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: { ...common, idempotencyKey: `c2-fold-${f.leagueId}`, authoritativeLocalDate: "2032-11-07", authoritativeLocalStartTime: "01:30:00" },
    }))).toBe("invalid_dst_input");
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: {
        ...common,
        idempotencyKey: `c2-assertion-${f.leagueId}`,
        authoritativeLocalDate: "2032-08-02",
        authoritativeLocalStartTime: "19:00:00",
        startAt: "2032-08-02T00:00:00.000Z",
      },
    }))).toBe("invalid_dst_input");
    const other = review.occurrences[1];
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: {
        ...common,
        idempotencyKey: `c2-exact-${f.leagueId}`,
        authoritativeLocalDate: other.authoritativeLocalDate,
        authoritativeLocalStartTime: other.authoritativeLocalStartTime,
      },
    }))).toBe("exact_start_collision");
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: {
        ...common,
        idempotencyKey: `c2-same-day-${f.leagueId}`,
        authoritativeLocalDate: other.authoritativeLocalDate,
        authoritativeLocalStartTime: "20:00:00",
      },
    }))).toBe("same_day_collision");
    expect(await caughtCode(() => rescheduleFallDraftOccurrence({
      ...scope(f),
      request: {
        ...common,
        idempotencyKey: `c2-exception-${f.leagueId}`,
        authoritativeLocalDate: review.scheduleExceptions[0].localDate,
        authoritativeLocalStartTime: "20:00:00",
      },
    }))).toBe("exception_collision");
  });

  it("preserves identity and recomputes dense billing ordinals across cancellation and restoration", async () => {
    const f = await fixture("cancel-restore");
    await generateDraft(f);
    const review = await loadFallDraftReview(scope(f));
    const target = review.occurrences[1];
    const cancelRequest = {
      contractVersion: FALL_DRAFT_CANCEL_REQUEST_VERSION,
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: "Cancel one reviewed future session",
      idempotencyKey: `c2-cancel-${f.leagueId}`,
      occurrenceId: target.id,
      expectedOccurrenceRevision: target.currentRevision,
    } as const;
    const cancelled = await cancelFallDraftOccurrence({
      ...scope(f),
      request: cancelRequest,
    });
    expect((await cancelFallDraftOccurrence({ ...scope(f), request: cancelRequest })).durableEntityIds)
      .toEqual(cancelled.durableEntityIds);
    const cancelledRow = cancelled.review.occurrences.find((row) => row.id === target.id);
    if (!cancelledRow) throw new Error("cancelled occurrence was not returned in C2 review");
    expect(cancelledRow).toMatchObject({ id: target.id, generationKey: target.generationKey, status: "cancelled", plannedOrdinal: 2, competitionNumber: null });
    const originalOrdinals = new Map(review.occurrences.map((row) => [row.id, row.plannedOrdinal ?? 0]));
    expect(cancelled.review.billingTerms
      .sort((left, right) => (originalOrdinals.get(left.occurrenceId) ?? 0) - (originalOrdinals.get(right.occurrenceId) ?? 0))
      .map((row) => row.billingOrdinal)).toEqual([1, null, 2]);

    const restoreRequest = {
      contractVersion: FALL_DRAFT_RESTORE_REQUEST_VERSION,
      confirmedReviewFingerprint: cancelled.review.reviewFingerprint,
      reason: "Restore the verified cancelled draft",
      idempotencyKey: `c2-restore-${f.leagueId}`,
      occurrenceId: target.id,
      expectedOccurrenceRevision: cancelledRow.currentRevision,
    } as const;
    const restored = await restoreFallDraftOccurrence({
      ...scope(f),
      request: restoreRequest,
    });
    expect((await restoreFallDraftOccurrence({ ...scope(f), request: restoreRequest })).durableEntityIds)
      .toEqual(restored.durableEntityIds);
    expect(restored.review.occurrences.find((row) => row.id === target.id)).toMatchObject({
      id: target.id, generationKey: target.generationKey, status: "scheduled", plannedOrdinal: 2,
      competitionNumber: 2, competitive: true, countsInStandings: true, cancelledAt: null,
    });
    const restoredOrdinals = new Map(restored.review.occurrences.map((row) => [row.id, row.plannedOrdinal ?? 0]));
    expect(restored.review.billingTerms
      .sort((left, right) => (restoredOrdinals.get(left.occurrenceId) ?? 0) - (restoredOrdinals.get(right.occurrenceId) ?? 0))
      .map((row) => row.billingOrdinal)).toEqual([1, 2, 3]);
    expect(restored.review.billingTerms.find((row) => row.occurrenceId === target.id)).toMatchObject({
      obligationPolicy: "eligible_bowlers", defaultAmountMinor: 2_000, currency: "USD",
    });
  });

  it("preserves planned-slot billing gaps and restores the original planned billing ordinal", async () => {
    const f = await fixture("planned-cancel-restore");
    const plannedSemantics: FallDraftGeneratorSemantics = { ...semantics, billingOrdinalPolicy: "planned_slot" };
    await generateDraft(f, plannedSemantics);
    const review = await loadFallDraftReview(scope(f));
    const target = review.occurrences[1];
    const cancelled = await cancelFallDraftOccurrence({
      ...scope(f),
      request: {
        contractVersion: FALL_DRAFT_CANCEL_REQUEST_VERSION,
        confirmedReviewFingerprint: review.reviewFingerprint,
        reason: "Cancel one planned-slot policy draft",
        idempotencyKey: `c2-planned-cancel-${f.leagueId}`,
        occurrenceId: target.id,
        expectedOccurrenceRevision: target.currentRevision,
      },
    });
    const termOrdinals = new Map(cancelled.review.billingTerms.map((row) => [row.occurrenceId, row.billingOrdinal]));
    expect(cancelled.review.occurrences.map((row) => termOrdinals.get(row.id))).toEqual([1, null, 3]);
    const cancelledTarget = cancelled.review.occurrences.find((row) => row.id === target.id);
    if (!cancelledTarget) throw new Error("planned-slot cancelled occurrence was not returned");
    const restored = await restoreFallDraftOccurrence({
      ...scope(f),
      request: {
        contractVersion: FALL_DRAFT_RESTORE_REQUEST_VERSION,
        confirmedReviewFingerprint: cancelled.review.reviewFingerprint,
        reason: "Restore original planned-slot billing position",
        idempotencyKey: `c2-planned-restore-${f.leagueId}`,
        occurrenceId: target.id,
        expectedOccurrenceRevision: cancelledTarget.currentRevision,
      },
    });
    const restoredOrdinals = new Map(restored.review.billingTerms.map((row) => [row.occurrenceId, row.billingOrdinal]));
    expect(restored.review.occurrences.map((row) => restoredOrdinals.get(row.id))).toEqual([1, 2, 3]);
  });
});

describe("C2 atomic approval, publication, and rejection", () => {
  it("requires exact discrepancy dispositions and permits resolved only after durable correction", async () => {
    const f = await fixture("discrepancy", { seasonEnd: "2032-08-22" });
    await generateDraft(f);
    const initial = await loadFallDraftReview(scope(f));
    expect(initial.discrepancies).toHaveLength(1);
    expect(initial.discrepancies[0]).toMatchObject({ code: "total_week_mismatch", resolutionState: "open", canResolve: false });
    const approvalBase = {
      contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
      confirmedReviewFingerprint: initial.reviewFingerprint,
      reason: "Review the current generation discrepancy",
      idempotencyKey: `c2-discrepancy-approval-${f.leagueId}`,
    } as const;
    expect(await caughtCode(() => approveAndPublishFallDraft({ ...scope(f), request: { ...approvalBase, discrepancyDispositions: [] } }))).toBe("discrepancy_disposition_invalid");
    expect(await caughtCode(() => approveAndPublishFallDraft({
      ...scope(f),
      request: { ...approvalBase, discrepancyDispositions: [{ discrepancyId: initial.discrepancies[0].id, disposition: "resolved" }] },
    }))).toBe("discrepancy_disposition_invalid");
    const last = initial.occurrences.at(-1);
    if (!last) throw new Error("C2 discrepancy fixture has no final occurrence");
    const corrected = await rescheduleFallDraftOccurrence({
      ...scope(f),
      request: {
        contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
        confirmedReviewFingerprint: initial.reviewFingerprint,
        reason: "Correct the final reviewed date to the stored season end",
        idempotencyKey: `c2-discrepancy-reschedule-${f.leagueId}`,
        occurrenceId: last.id,
        expectedOccurrenceRevision: last.currentRevision,
        authoritativeLocalDate: "2032-08-22",
        authoritativeLocalStartTime: last.authoritativeLocalStartTime,
        timezone: last.timezone,
      },
    });
    expect(corrected.review.discrepancies[0].canResolve).toBe(true);
    const approved = await approveAndPublishFallDraft({
      ...scope(f),
      request: {
        ...approvalBase,
        confirmedReviewFingerprint: corrected.review.reviewFingerprint,
        idempotencyKey: `c2-discrepancy-resolved-${f.leagueId}`,
        discrepancyDispositions: [{ discrepancyId: initial.discrepancies[0].id, disposition: "resolved" }],
      },
    });
    expect(approved.review.discrepancies[0]).toMatchObject({ resolutionState: "resolved", resolutionCommandId: expect.any(String) });
    expect(approved.review.discrepancies[0].revisions).toHaveLength(1);
    expect(await db.select().from(leagueOccurrenceGenerationDiscrepancyRevisions)
      .where(eq(leagueOccurrenceGenerationDiscrepancyRevisions.leagueId, f.leagueId))).toHaveLength(1);
  });

  it("publishes the complete reviewed set with truthful commands and exact retry behavior", async () => {
    const f = await fixture("approve");
    await generateDraft(f);
    const review = await loadFallDraftReview(scope(f));
    const beforeLegacy = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const beforeGames = await db.select().from(games).where(eq(games.leagueId, f.leagueId));
    const beforePayments = await db.select().from(payments).where(eq(payments.leagueId, f.leagueId));
    const request: FallDraftApproveRequest = {
      contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: "Approve and publish the complete reviewed C1 set",
      idempotencyKey: `c2-approve-${f.leagueId}`,
      discrepancyDispositions: [],
    };
    const applied = await approveAndPublishFallDraft({ ...scope(f), request });
    expect(applied).toMatchObject({ operation: "approve_publish", mode: "applied", writesPerformed: true });
    expect(applied.review.generationRun).toMatchObject({ state: "applied", approvalCommandId: expect.any(String) });
    expect(applied.review.occurrences.every((row) => row.lifecycle === "published" && row.publicationCommandId !== null)).toBe(true);
    expect(applied.review.billingTerms.every((row) => row.state === "published" && row.publicationCommandId !== null)).toBe(true);
    const commandTypes = (await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, f.leagueId)))
      .map((row) => row.commandType);
    expect(commandTypes).toContain("approve_generation");
    expect(commandTypes).toContain("publish");
    expect(await db.select().from(leagues).where(eq(leagues.id, f.leagueId))).toEqual(beforeLegacy);
    expect(await db.select().from(games).where(eq(games.leagueId, f.leagueId))).toEqual(beforeGames);
    expect(await db.select().from(payments).where(eq(payments.leagueId, f.leagueId))).toEqual(beforePayments);
    expect(await db.select().from(leagueOccurrenceRelationships).where(eq(leagueOccurrenceRelationships.leagueId, f.leagueId))).toHaveLength(0);
    const retry = await approveAndPublishFallDraft({ ...scope(f), request });
    expect(retry).toMatchObject({ mode: "idempotent_retry", writesPerformed: false, commandIds: applied.commandIds });
    expect(retry.durableEntityIds).toEqual(applied.durableEntityIds);
    expect(await caughtCode(() => rejectFallDraft({
      ...scope(f),
      request: {
        contractVersion: FALL_DRAFT_REJECT_REQUEST_VERSION,
        confirmedReviewFingerprint: applied.review.reviewFingerprint,
        reason: "Cannot reject after publication",
        idempotencyKey: `c2-reject-late-${f.leagueId}`,
      },
    }))).toBe("terminal_state");
  });

  it("rejects without deletion or publication and terminalizes every draft row atomically", async () => {
    const f = await fixture("reject", { skipDates: ["2032-08-08"], seasonEnd: "2032-08-22" });
    await generateDraft(f);
    const review = await loadFallDraftReview(scope(f));
    const request: FallDraftRejectRequest = {
      contractVersion: FALL_DRAFT_REJECT_REQUEST_VERSION,
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: "Reject this reviewed draft set without publication",
      idempotencyKey: `c2-reject-${f.leagueId}`,
    };
    const rejected = await rejectFallDraft({ ...scope(f), request });
    expect(rejected.review.generationRun).toMatchObject({ state: "rejected", rejectionCommandId: expect.any(String) });
    expect(rejected.review.occurrences.every((row) => row.lifecycle === "draft" && row.status === "discarded" && row.plannedOrdinal === null)).toBe(true);
    expect(rejected.review.billingTerms.every((row) => row.state === "superseded" && row.publicationCommandId === null)).toBe(true);
    expect(rejected.review.scheduleExceptions.every((row) => row.lifecycle === "revoked" && row.publicationCommandId === null)).toBe(true);
    expect(rejected.review.occurrences.map((row) => row.id).sort()).toEqual(review.occurrences.map((row) => row.id).sort());
    expect(rejected.review.occurrences.map((row) => row.generationKey).sort()).toEqual(review.occurrences.map((row) => row.generationKey).sort());
    const retry = await rejectFallDraft({ ...scope(f), request });
    expect(retry).toMatchObject({ mode: "idempotent_retry", durableEntityIds: rejected.durableEntityIds });
    expect((await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, f.leagueId)))).toHaveLength(1);
  });

  it("rolls back every audited table after each meaningful approval stage", async () => {
    for (const stage of ["after_commands", "after_occurrences", "after_billing_terms", "after_exceptions", "after_generation_run"] as const) {
      const f = await fixture(`rollback-${stage}`);
      await generateDraft(f);
      const review = await loadFallDraftReview(scope(f));
      const before = {
        commands: await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, f.leagueId)),
        occurrences: await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, f.leagueId)).orderBy(asc(leagueOccurrences.id)),
        terms: await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId)).orderBy(asc(leagueOccurrenceBillingTerms.id)),
        occurrenceRevisions: await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.leagueId, f.leagueId)),
        termRevisions: await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.leagueId, f.leagueId)),
        exceptionRevisions: await db.select().from(leagueScheduleExceptionRevisions).where(eq(leagueScheduleExceptionRevisions.leagueId, f.leagueId)),
        discrepancyRevisions: await db.select().from(leagueOccurrenceGenerationDiscrepancyRevisions).where(eq(leagueOccurrenceGenerationDiscrepancyRevisions.leagueId, f.leagueId)),
      };
      await expect(approveAndPublishFallDraft({
        ...scope(f),
        request: {
          contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
          confirmedReviewFingerprint: review.reviewFingerprint,
          reason: "Exercise complete transaction rollback",
          idempotencyKey: `c2-rollback-${stage}-${f.leagueId}`,
          discrepancyDispositions: [],
        },
        failureInjection: stage,
      })).rejects.toMatchObject({ code: "transaction_failure" });
      expect(await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, f.leagueId))).toEqual(before.commands);
      expect(await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, f.leagueId)).orderBy(asc(leagueOccurrences.id))).toEqual(before.occurrences);
      expect(await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId)).orderBy(asc(leagueOccurrenceBillingTerms.id))).toEqual(before.terms);
      expect(await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.leagueId, f.leagueId))).toEqual(before.occurrenceRevisions);
      expect(await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.leagueId, f.leagueId))).toEqual(before.termRevisions);
      expect(await db.select().from(leagueScheduleExceptionRevisions).where(eq(leagueScheduleExceptionRevisions.leagueId, f.leagueId))).toEqual(before.exceptionRevisions);
      expect(await db.select().from(leagueOccurrenceGenerationDiscrepancyRevisions).where(eq(leagueOccurrenceGenerationDiscrepancyRevisions.leagueId, f.leagueId))).toEqual(before.discrepancyRevisions);
    }
  });

  it("serializes edit/edit, edit/approval, approval/approval, and rejection/approval races", async () => {
    const editEdit = await fixture("race-edit-edit");
    await generateDraft(editEdit);
    const editReview = await loadFallDraftReview(scope(editEdit));
    const editTarget = editReview.occurrences[0];
    const editOutcomes = await Promise.allSettled([
      rescheduleFallDraftOccurrence({
        ...scope(editEdit),
        request: {
          contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
          confirmedReviewFingerprint: editReview.reviewFingerprint,
          reason: "First competing edit",
          idempotencyKey: `c2-race-edit-one-${editEdit.leagueId}`,
          occurrenceId: editTarget.id,
          expectedOccurrenceRevision: editTarget.currentRevision,
          authoritativeLocalDate: "2032-08-02",
          authoritativeLocalStartTime: editTarget.authoritativeLocalStartTime,
          timezone: editTarget.timezone,
        },
      }),
      rescheduleFallDraftOccurrence({
        ...scope(editEdit),
        request: {
          contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
          confirmedReviewFingerprint: editReview.reviewFingerprint,
          reason: "Second competing edit",
          idempotencyKey: `c2-race-edit-two-${editEdit.leagueId}`,
          occurrenceId: editTarget.id,
          expectedOccurrenceRevision: editTarget.currentRevision,
          authoritativeLocalDate: "2032-08-03",
          authoritativeLocalStartTime: editTarget.authoritativeLocalStartTime,
          timezone: editTarget.timezone,
        },
      }),
    ]);
    expect(editOutcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);

    const editApproval = await fixture("race-edit-approval");
    await generateDraft(editApproval);
    const mixedReview = await loadFallDraftReview(scope(editApproval));
    const mixedTarget = mixedReview.occurrences[0];
    const mixedOutcomes = await Promise.allSettled([
      cancelFallDraftOccurrence({
        ...scope(editApproval),
        request: {
          contractVersion: FALL_DRAFT_CANCEL_REQUEST_VERSION,
          confirmedReviewFingerprint: mixedReview.reviewFingerprint,
          reason: "Competing edit against approval",
          idempotencyKey: `c2-race-mixed-edit-${editApproval.leagueId}`,
          occurrenceId: mixedTarget.id,
          expectedOccurrenceRevision: mixedTarget.currentRevision,
        },
      }),
      approveAndPublishFallDraft({
        ...scope(editApproval),
        request: {
          contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
          confirmedReviewFingerprint: mixedReview.reviewFingerprint,
          reason: "Competing approval against edit",
          idempotencyKey: `c2-race-mixed-approve-${editApproval.leagueId}`,
          discrepancyDispositions: [],
        },
      }),
    ]);
    expect(mixedOutcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);

    const approvalApproval = await fixture("race-approval-approval");
    await generateDraft(approvalApproval);
    const approvalReview = await loadFallDraftReview(scope(approvalApproval));
    const approvalOutcomes = await Promise.allSettled(["one", "two"].map((suffix) => approveAndPublishFallDraft({
      ...scope(approvalApproval),
      request: {
        contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
        confirmedReviewFingerprint: approvalReview.reviewFingerprint,
        reason: `Competing approval ${suffix}`,
        idempotencyKey: `c2-race-approval-${suffix}-${approvalApproval.leagueId}`,
        discrepancyDispositions: [],
      },
    })));
    expect(approvalOutcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);

    const rejectionApproval = await fixture("race-rejection-approval");
    await generateDraft(rejectionApproval);
    const terminalReview = await loadFallDraftReview(scope(rejectionApproval));
    const terminalOutcomes = await Promise.allSettled([
      rejectFallDraft({
        ...scope(rejectionApproval),
        request: {
          contractVersion: FALL_DRAFT_REJECT_REQUEST_VERSION,
          confirmedReviewFingerprint: terminalReview.reviewFingerprint,
          reason: "Competing terminal rejection",
          idempotencyKey: `c2-race-reject-${rejectionApproval.leagueId}`,
        },
      }),
      approveAndPublishFallDraft({
        ...scope(rejectionApproval),
        request: {
          contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
          confirmedReviewFingerprint: terminalReview.reviewFingerprint,
          reason: "Competing terminal approval",
          idempotencyKey: `c2-race-approve-${rejectionApproval.leagueId}`,
          discrepancyDispositions: [],
        },
      }),
    ]);
    expect(terminalOutcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(["rejected", "applied"]).toContain((await loadFallDraftReview(scope(rejectionApproval))).generationRun.state);
  });
});
