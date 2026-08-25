import { and, eq, inArray, or, sql } from "drizzle-orm";
import { differenceInWeeks } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import {
  bowlers,
  bowlerPaymentLinks,
  leagues,
  locationSquareCredentialsSchema,
  locations,
  paymentOperations,
  paymentSchedules,
  users,
  canonicalCollectionGroups,
  canonicalCollectionGroupMembers,
  DEFAULT_TIMEZONE,
  type PaymentOperation,
  type PaymentSchedule,
} from "@shared/schema";
import { getEffectiveBowlingWeeks, isDateSkippedOrCancelled } from "@shared/schedule-utils";
import { db } from "../db.js";
import {
  createOrGetScheduledPaymentOperation,
  persistScheduledPaymentOperationSnapshot,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import {
  buildSquarePaymentRequestIdentity,
} from "./payment-operation-idempotency.js";
import {
  buildScheduledChargePlan,
  computePaymentSplit,
} from "./payment-execution.js";
import { computeNextPaymentDate } from "./payment-lifecycle.js";
import type { ScheduledPaymentSemanticSnapshot } from "./scheduled-payment-operation-snapshot.js";
import {
  normalizeScheduledBillingCycle,
  scheduledPaymentCycleLockKey,
} from "./scheduled-payment-cycle-lock.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  assertNoOccurrenceReferenceConflict,
  logOccurrenceCompatibility,
  OccurrenceCompatibilityConflictError,
  resolveCanonicalOccurrenceCompatibility,
} from "./canonical-occurrence-compatibility.js";

const SERIALIZATION_MAX_ATTEMPTS = 4;

export class ScheduledPaymentPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPaymentPreparationError";
  }
}

export type ScheduledPaymentPreparationResult =
  | { kind: "prepared" | "existing"; operation: PaymentOperation; schedule: PaymentSchedule }
  | { kind: "skipped"; schedule: PaymentSchedule }
  | { kind: "inactive" | "not_due" | "stale"; schedule?: PaymentSchedule };

function timestampMatches(left: string | null, right: string): boolean {
  return left !== null
    && normalizeScheduledBillingCycle(left) === normalizeScheduledBillingCycle(right);
}

function isSerializationFailure(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate instanceof Error; depth += 1) {
    const code = "code" in candidate ? (candidate as { code?: unknown }).code : undefined;
    if (code === "40001" || code === "40P01") return true;
    candidate = candidate.cause;
  }
  return false;
}

async function serializable<T>(work: (tx: PaymentOperationTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        return work(tx);
      });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === SERIALIZATION_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  throw new ScheduledPaymentPreparationError("serializable payment preparation did not complete");
}

async function loadLockedSchedule(
  tx: PaymentOperationTransaction,
  paymentScheduleId: number,
): Promise<PaymentSchedule | undefined> {
  const [schedule] = await tx
    .select()
    .from(paymentSchedules)
    .where(eq(paymentSchedules.id, paymentScheduleId))
    .limit(1)
    .for("update");
  return schedule;
}

async function getExistingCycleOperation(
  tx: PaymentOperationTransaction,
  paymentScheduleId: number,
  billingCycleAt: string,
): Promise<PaymentOperation | undefined> {
  const [operation] = await tx
    .select()
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.operationType, "scheduled_charge"),
      eq(paymentOperations.paymentScheduleId, paymentScheduleId),
      sql`${paymentOperations.billingCycleAt} = ${billingCycleAt}::timestamp`,
    ))
    .limit(1);
  return operation;
}

function fullSeasonAmountMinor(league: typeof leagues.$inferSelect): number | null {
  const seasonStart = new Date(league.seasonStart);
  const seasonEnd = new Date(league.seasonEnd);
  const totalWeeks = league.totalBowlingWeeks !== null
    ? getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? [])
    : Math.max(0, differenceInWeeks(seasonEnd, seasonStart));
  const amount = league.weeklyFee * totalWeeks;
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

async function loadPreparationContext(
  tx: PaymentOperationTransaction,
  schedule: PaymentSchedule,
): Promise<{
  organizationId: number;
  league: typeof leagues.$inferSelect;
  payer: typeof bowlers.$inferSelect;
  validPartnerIds: number[];
  paidByUserId: number | null;
  providerLocationId: string;
}> {
  const [league] = await tx
    .select()
    .from(leagues)
    .where(eq(leagues.id, schedule.leagueId))
    .limit(1)
    .for("share");
  if (!league?.organizationId) {
    throw new ScheduledPaymentPreparationError("scheduled payment league has no tenant owner");
  }
  const organizationId = league.organizationId;

  const [payer] = await tx
    .select()
    .from(bowlers)
    .where(and(
      eq(bowlers.id, schedule.bowlerId),
      eq(bowlers.organizationId, organizationId),
    ))
    .limit(1)
    .for("share");
  if (!payer) {
    throw new ScheduledPaymentPreparationError("scheduled payment payer does not belong to the league tenant");
  }

  const requestedPartnerIds = [...new Set(schedule.additionalBowlerIds ?? [])]
    .filter((id) => id !== payer.id);
  const partnerRows = requestedPartnerIds.length === 0
    ? []
    : await tx
      .select()
      .from(bowlers)
      .where(inArray(bowlers.id, requestedPartnerIds))
      .for("share");
  const partnerById = new Map(partnerRows.map((row) => [row.id, row]));
  for (const partnerId of requestedPartnerIds) {
    if (partnerById.get(partnerId)?.organizationId !== organizationId) {
      throw new ScheduledPaymentPreparationError("combined scheduled payment contains a missing or cross-tenant bowler");
    }
  }

  const linkRows = requestedPartnerIds.length === 0
    ? []
    : await tx
      .select()
      .from(bowlerPaymentLinks)
      .where(and(
        eq(bowlerPaymentLinks.organizationId, organizationId),
        eq(bowlerPaymentLinks.status, "accepted"),
        or(
          and(
            eq(bowlerPaymentLinks.bowlerAId, payer.id),
            inArray(bowlerPaymentLinks.bowlerBId, requestedPartnerIds),
          ),
          and(
            eq(bowlerPaymentLinks.bowlerBId, payer.id),
            inArray(bowlerPaymentLinks.bowlerAId, requestedPartnerIds),
          ),
        ),
      ))
      .for("share");
  const acceptedPartnerIds = new Set(linkRows.map((row) => (
    row.bowlerAId === payer.id ? row.bowlerBId : row.bowlerAId
  )));
  const validPartnerIds = requestedPartnerIds.filter((id) => acceptedPartnerIds.has(id));

  const [payerUser] = validPartnerIds.length === 0
    ? [undefined]
    : await tx
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.organizationId, organizationId),
        eq(users.bowlerId, payer.id),
      ))
      .limit(1)
      .for("share");

  if (league.locationId === null) {
    throw new ScheduledPaymentPreparationError("scheduled payment league has no provider location");
  }
  const [location] = await tx
    .select()
    .from(locations)
    .where(and(
      eq(locations.id, league.locationId),
      eq(locations.organizationId, organizationId),
    ))
    .limit(1)
    .for("share");
  if (!location) {
    throw new ScheduledPaymentPreparationError("scheduled payment location does not belong to the league tenant");
  }
  const credentials = locationSquareCredentialsSchema.safeParse(location.squareCredentials);
  const providerLocationId = credentials.success
    ? credentials.data?.locationId?.trim() ?? ""
    : "";
  if (providerLocationId.length === 0) {
    throw new ScheduledPaymentPreparationError("scheduled payment Square location identity is unavailable");
  }
  if (!schedule.paymentCardId.startsWith("ccof:")) {
    throw new ScheduledPaymentPreparationError("scheduled payment source reference is invalid");
  }

  return {
    organizationId,
    league,
    payer,
    validPartnerIds,
    paidByUserId: payerUser?.id ?? null,
    providerLocationId,
  };
}

function buildSnapshot(input: {
  operation: PaymentOperation;
  schedule: PaymentSchedule;
  context: Awaited<ReturnType<typeof loadPreparationContext>>;
  canonicalCollectionAmountMinor?: number;
}): ScheduledPaymentSemanticSnapshot {
  const { operation, schedule, context } = input;
  if (operation.paymentScheduleId === null || operation.billingCycleAt === null) {
    throw new ScheduledPaymentPreparationError("scheduled operation identity is incomplete");
  }
  const plan = buildScheduledChargePlan(
    schedule,
    context.league,
    context.validPartnerIds.length,
    { canonicalAuthoritative: input.canonicalCollectionAmountMinor !== undefined || schedule.nextOccurrenceId !== null, canonicalCollectionAmountMinor: input.canonicalCollectionAmountMinor },
  );
  if (plan.amountMinor !== operation.amountMinor) {
    throw new ScheduledPaymentPreparationError("scheduled operation amount changed during preparation");
  }
  const { lineageAmount, prizeFundAmount } = computePaymentSplit(
    plan.allocationAmountMinor,
    context.league,
  );
  const combined = context.validPartnerIds.length > 0;
  const baseNotes = plan.isDoublePay ? "Double-pay week (2x weekly fee)" : null;
  const bowlerIds = [context.payer.id, ...context.validPartnerIds];
  const allocations = bowlerIds.map((bowlerId, allocationIndex) => ({
    allocationIndex,
    bowlerId,
    amountMinor: plan.allocationAmountMinor,
    lineageAmountMinor: lineageAmount ?? null,
    prizeFundAmountMinor: prizeFundAmount ?? null,
    notes: allocationIndex === 0
      ? (combined
        ? (baseNotes ? `${baseNotes} (combined autopay self)` : "Combined autopay (self)")
        : baseNotes)
      : "Combined autopay (paid by partner)",
    paidByUserId: combined ? context.paidByUserId : null,
  }));
  const upfront = context.league.paymentMode === "upfront" || schedule.frequency === "upfront";
  const paidInFullThresholdAmountMinor = upfront ? null : fullSeasonAmountMinor(context.league);
  const requestKind = plan.lineItems.length > 0 ? "order" : "direct";
  const squareIdentity = buildSquarePaymentRequestIdentity({
    providerIdempotencyKey: operation.providerIdempotencyKey,
    requestKind,
    providerLocationId: context.providerLocationId,
  });
  return {
    snapshotVersion: 1,
    organizationId: context.organizationId,
    paymentScheduleId: operation.paymentScheduleId,
    billingCycleAt: normalizeScheduledBillingCycle(operation.billingCycleAt),
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: context.league.id,
    locationId: context.league.locationId,
    providerLocationId: context.providerLocationId,
    requestKind,
    squarePaymentIdempotencyKey: squareIdentity.paymentKey,
    squareOrderIdempotencyKey: requestKind === "order"
      ? squareIdentity.orderKey ?? null
      : null,
    autocomplete: true,
    storeCard: false,
    sourceId: schedule.paymentCardId,
    customerId: context.payer.paymentCustomerId,
    buyerEmail: context.payer.email,
    isDoublePay: plan.isDoublePay,
    deactivateScheduleOnPreparation: upfront,
    paidInFullThresholdAmountMinor,
    seasonStartAt: paidInFullThresholdAmountMinor === null
      ? null
      : normalizeScheduledBillingCycle(context.league.seasonStart),
    seasonEndAt: paidInFullThresholdAmountMinor === null
      ? null
      : normalizeScheduledBillingCycle(context.league.seasonEnd),
    allocations,
    lineItems: plan.lineItems.map((lineItem, lineItemIndex) => ({
      lineItemIndex,
      catalogObjectId: lineItem.catalogObjectId,
      quantity: lineItem.quantity,
    })),
  };
}

export async function prepareScheduledPaymentCycle(input: {
  paymentScheduleId: number;
  billingCycleAt: string | Date;
  now?: Date;
}): Promise<ScheduledPaymentPreparationResult> {
  const expectedCycleAt = normalizeScheduledBillingCycle(input.billingCycleAt);
  const now = input.now ?? new Date();
  return serializable(async (tx) => {
    const advisoryKey = scheduledPaymentCycleLockKey(input.paymentScheduleId, expectedCycleAt);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey}::bigint)`);
    const schedule = await loadLockedSchedule(tx, input.paymentScheduleId);
    if (!schedule) return { kind: "stale" };

    const [ownedLeague] = await tx
      .select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
      .from(leagues)
      .where(eq(leagues.id, schedule.leagueId))
      .limit(1);
    if (!ownedLeague?.organizationId) {
      throw new ScheduledPaymentPreparationError("scheduled payment league has no tenant owner");
    }
    if (!ownedLeague.active || ownedLeague.scheduleAuthority !== "canonical") {
      await tx.update(paymentSchedules).set({ active: false }).where(and(
        eq(paymentSchedules.id, schedule.id),
        eq(paymentSchedules.active, true),
      ));
      return { kind: "stale" };
    }
    await lockLeagueSchedule(tx, ownedLeague.organizationId, schedule.leagueId);

    const existing = await getExistingCycleOperation(tx, schedule.id, expectedCycleAt);
    if (existing) {
      if (existing.organizationId !== ownedLeague.organizationId) {
        throw new ScheduledPaymentPreparationError("existing scheduled operation tenant does not match its schedule");
      }
      if (existing.triggerOccurrenceId !== null) {
        const comparison = await resolveCanonicalOccurrenceCompatibility(tx, {
          subject: "scheduled_operation",
          organizationId: ownedLeague.organizationId,
          leagueId: schedule.leagueId,
          legacyStartAt: expectedCycleAt,
          existingReferenceId: existing.triggerOccurrenceId,
        });
        logOccurrenceCompatibility("scheduled_operation_retry", comparison);
        if (comparison.classification !== "exact_match"
          || comparison.occurrenceId !== existing.triggerOccurrenceId) {
          throw new OccurrenceCompatibilityConflictError(comparison);
        }
      }
      return { kind: "existing", operation: existing, schedule };
    }

    if (!schedule.active) return { kind: "inactive", schedule };
    if (!timestampMatches(schedule.nextPaymentDate, expectedCycleAt)) {
      return { kind: "stale", schedule };
    }
    if (new Date(expectedCycleAt).getTime() > now.getTime()) {
      return { kind: "not_due", schedule };
    }

    const context = await loadPreparationContext(tx, schedule);
    const firingDate = toZonedTime(
      new Date(expectedCycleAt),
      context.league.timezone ?? DEFAULT_TIMEZONE,
    );
    const upfront = context.league.paymentMode === "upfront" || schedule.frequency === "upfront";
    if (!upfront && isDateSkippedOrCancelled(
      firingDate,
      context.league.skipDates ?? [],
      context.league.cancelledDates ?? [],
    )) {
      const nextPaymentDate = computeNextPaymentDate(schedule, context.league).toISOString();
      const nextComparison = await resolveCanonicalOccurrenceCompatibility(tx, {
        subject: "payment_schedule",
        organizationId: context.organizationId,
        leagueId: schedule.leagueId,
        legacyStartAt: nextPaymentDate,
        immediateUpfront: false,
        eligibilityNow: now.toISOString(),
        existingReferenceId: schedule.nextOccurrenceId,
      });
      assertNoOccurrenceReferenceConflict(nextComparison);
      logOccurrenceCompatibility("payment_schedule_skipped_cursor_advance", nextComparison);
      const [advanced] = await tx
        .update(paymentSchedules)
        .set({
          nextPaymentDate,
          nextOccurrenceId: nextComparison.classification === "exact_match" ? nextComparison.occurrenceId : null,
          lastPaymentDate: expectedCycleAt,
        })
        .where(and(
          eq(paymentSchedules.id, schedule.id),
          eq(paymentSchedules.active, true),
          eq(paymentSchedules.nextPaymentDate, expectedCycleAt),
        ))
        .returning();
      if (!advanced) throw new ScheduledPaymentPreparationError("skipped cycle cursor could not be advanced");
      return { kind: "skipped", schedule: advanced };
    }

    const triggerComparison = await resolveCanonicalOccurrenceCompatibility(tx, {
      subject: "scheduled_operation",
      organizationId: context.organizationId,
      leagueId: schedule.leagueId,
      legacyStartAt: expectedCycleAt,
      existingReferenceId: schedule.nextOccurrenceId,
    });
    assertNoOccurrenceReferenceConflict(triggerComparison);
    logOccurrenceCompatibility("scheduled_operation_prepare", triggerComparison);
    if (schedule.nextOccurrenceId !== null
      && (triggerComparison.classification !== "exact_match"
        || triggerComparison.occurrenceId !== schedule.nextOccurrenceId)) {
      throw new OccurrenceCompatibilityConflictError(triggerComparison);
    }
    const exactTriggerOccurrenceId = triggerComparison.classification === "exact_match"
      ? triggerComparison.occurrenceId
      : null;
    let triggerOccurrenceId = schedule.nextOccurrenceId;
    if (!upfront && triggerOccurrenceId === null && exactTriggerOccurrenceId !== null) {
      const [reconciled] = await tx
        .update(paymentSchedules)
        .set({ nextOccurrenceId: exactTriggerOccurrenceId })
        .where(and(
          eq(paymentSchedules.id, schedule.id),
          eq(paymentSchedules.active, true),
          eq(paymentSchedules.nextPaymentDate, expectedCycleAt),
          sql`${paymentSchedules.nextOccurrenceId} IS NULL`,
        ))
        .returning({ nextOccurrenceId: paymentSchedules.nextOccurrenceId });
      if (reconciled?.nextOccurrenceId !== exactTriggerOccurrenceId) {
        throw new ScheduledPaymentPreparationError(
          "scheduled cycle cursor occurrence could not be reconciled",
        );
      }
      triggerOccurrenceId = exactTriggerOccurrenceId;
    }
    let canonicalCollectionAmountMinor: number | undefined;
    let canonicalPairedOccurrence = false;
    if (triggerOccurrenceId !== null) {
      const [canonicalMember] = await tx.select({ groupId: canonicalCollectionGroupMembers.groupId, role: canonicalCollectionGroupMembers.role })
        .from(canonicalCollectionGroupMembers)
        .innerJoin(canonicalCollectionGroups, and(
          eq(canonicalCollectionGroups.id, canonicalCollectionGroupMembers.groupId),
          eq(canonicalCollectionGroups.organizationId, context.organizationId),
          eq(canonicalCollectionGroups.leagueId, schedule.leagueId),
          eq(canonicalCollectionGroups.state, "published"),
        ))
        .where(and(
          eq(canonicalCollectionGroupMembers.organizationId, context.organizationId),
          eq(canonicalCollectionGroupMembers.leagueId, schedule.leagueId),
          eq(canonicalCollectionGroupMembers.occurrenceId, triggerOccurrenceId),
          eq(canonicalCollectionGroupMembers.active, true),
        )).limit(1);
      if (canonicalMember?.role === "paired") {
        // The paired physical occurrence was already included in the exact
        // trigger charge. Preserve its UUID/term evidence but advance the
        // legacy cursor without creating a second provider operation.
        canonicalPairedOccurrence = true;
      } else if (canonicalMember?.role === "trigger") {
        const members = await tx.select({ amountMinor: canonicalCollectionGroupMembers.amountMinor })
          .from(canonicalCollectionGroupMembers)
          .where(and(
            eq(canonicalCollectionGroupMembers.organizationId, context.organizationId),
            eq(canonicalCollectionGroupMembers.leagueId, schedule.leagueId),
            eq(canonicalCollectionGroupMembers.groupId, canonicalMember.groupId),
            eq(canonicalCollectionGroupMembers.active, true),
          )).orderBy(canonicalCollectionGroupMembers.memberOrdinal);
        if (members.length !== 2) throw new ScheduledPaymentPreparationError("canonical collection group membership is incomplete");
        canonicalCollectionAmountMinor = members.reduce((total, member) => total + member.amountMinor, 0);
      }
    }
    if (canonicalPairedOccurrence) {
      const nextPaymentDate = computeNextPaymentDate(schedule, context.league).toISOString();
      const nextComparison = await resolveCanonicalOccurrenceCompatibility(tx, {
        subject: "payment_schedule",
        organizationId: context.organizationId,
        leagueId: schedule.leagueId,
        legacyStartAt: nextPaymentDate,
        immediateUpfront: false,
        eligibilityNow: now.toISOString(),
        // The cursor currently names the paired occurrence. Resolve the next
        // physical occurrence from its date, then require exact identity so a
        // paired-cycle skip can never silently advance to an inferred row.
        existingReferenceId: null,
      });
      assertNoOccurrenceReferenceConflict(nextComparison);
      if (nextComparison.classification !== "exact_match" || !nextComparison.occurrenceId) {
        throw new ScheduledPaymentPreparationError("paired canonical cycle has no exact next occurrence");
      }
      const [advanced] = await tx.update(paymentSchedules).set({
        nextPaymentDate,
        nextOccurrenceId: nextComparison.occurrenceId,
        lastPaymentDate: expectedCycleAt,
      }).where(and(
        eq(paymentSchedules.id, schedule.id),
        eq(paymentSchedules.active, true),
        eq(paymentSchedules.nextPaymentDate, expectedCycleAt),
      )).returning();
      if (!advanced) throw new ScheduledPaymentPreparationError("paired canonical cycle cursor could not be advanced");
      return { kind: "skipped", schedule: advanced };
    }
    const plan = buildScheduledChargePlan(schedule, context.league, context.validPartnerIds.length, {
      canonicalAuthoritative: triggerOccurrenceId !== null,
      canonicalCollectionAmountMinor,
    });
    const operation = await createOrGetScheduledPaymentOperation({
      organizationId: context.organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: expectedCycleAt,
      amountMinor: plan.amountMinor,
      currency: "USD",
      providerName: "square",
      triggerOccurrenceId,
    }, tx);
    await persistScheduledPaymentOperationSnapshot(
      operation,
      buildSnapshot({ operation, schedule, context, canonicalCollectionAmountMinor }),
      tx,
    );

    const nextPaymentDate = upfront
      ? null
      : computeNextPaymentDate(schedule, context.league).toISOString();
    const nextComparison = nextPaymentDate === null
      ? null
      : await resolveCanonicalOccurrenceCompatibility(tx, {
        subject: "payment_schedule",
        organizationId: context.organizationId,
        leagueId: schedule.leagueId,
        legacyStartAt: nextPaymentDate,
        immediateUpfront: false,
        eligibilityNow: now.toISOString(),
        existingReferenceId: schedule.nextOccurrenceId,
      });
    if (nextComparison) {
      assertNoOccurrenceReferenceConflict(nextComparison);
      logOccurrenceCompatibility("payment_schedule_prepared_cursor_advance", nextComparison);
    }
    const scheduleUpdate = upfront
      ? {
        active: false,
        nextOccurrenceId: null,
        lastPaymentDate: expectedCycleAt,
        cancelledAt: now.toISOString(),
        cancelReason: `ledger_upfront_prepared:operation=${operation.id}`,
      }
      : {
        nextPaymentDate: nextPaymentDate as string,
        nextOccurrenceId: nextComparison?.classification === "exact_match"
          ? nextComparison.occurrenceId
          : null,
        lastPaymentDate: expectedCycleAt,
      };
    const [advanced] = await tx
      .update(paymentSchedules)
      .set(scheduleUpdate)
      .where(and(
        eq(paymentSchedules.id, schedule.id),
        eq(paymentSchedules.active, true),
        eq(paymentSchedules.nextPaymentDate, expectedCycleAt),
      ))
      .returning();
    if (!advanced) throw new ScheduledPaymentPreparationError("scheduled cycle cursor could not be advanced");
    return { kind: "prepared", operation, schedule: advanced };
  });
}
