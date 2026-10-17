import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  REFUND_PAYMENT_SNAPSHOT_VERSION,
  REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION,
  bowlers,
  leagues,
  locations,
  paymentAllocationCorrections,
  paymentAllocationFundingApplications,
  paymentOperations,
  paymentAllocations,
  type RefundPaymentFundingSnapshotV3,
  weeklyPaymentFundings,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  payments,
  rotatingCreditFundings,
  weeklyPaymentAllocationReleases,
  users,
} from "@shared/schema";
import { isCardPaymentType } from "@shared/schema/constants";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  createOrGetRefundPaymentOperation,
  loadRefundPaymentOperationSnapshotInTransaction,
  PaymentOperationImmutableMismatchError,
  persistRefundPaymentOperationSnapshot,
  REFUND_TARGET_PREFIX,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import {
  OwnedPaymentRefundEvidenceError,
  readCompletedOwnedPaymentRefundEvidenceInTransaction,
  readOwnedGenericFundingSourcesByPaymentInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  validateOwnedFundingPortionsForTenderInTransaction,
} from "./owned-payment-ledger.js";
import type { RefundPaymentSemanticSnapshot } from "./refund-payment-operation-snapshot.js";
import { REFUND_PAYMENT_DISPOSITIONS } from "@shared/schema";

export const DEFAULT_REFUND_REASON = "Refund processed via LeagueVault";

export class RefundPreparationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RefundPreparationError";
  }
}

function normalizeReason(value: unknown): { reason: string; requestedReason: string | null } {
  if (value == null || value === "") return { reason: DEFAULT_REFUND_REASON, requestedReason: null };
  if (typeof value !== "string") throw new RefundPreparationError("Refund reason must be text", 400, "VALIDATION_ERROR");
  const reason = value.trim();
  if (!reason) return { reason: DEFAULT_REFUND_REASON, requestedReason: null };
  if (reason.length > 192) throw new RefundPreparationError("Refund reason must be 192 characters or fewer", 400, "VALIDATION_ERROR");
  return { reason, requestedReason: reason };
}

function refundSourceMismatch(): never {
  throw new RefundPreparationError(
    "This payment's owned funding evidence does not match the captured tender",
    409,
    "REFUND_FUNDING_EVIDENCE_MISMATCH",
  );
}

export interface PrepareRefundPaymentOperationInput {
  paymentId: number;
  disposition: unknown;
  reason?: unknown;
  requestedByUserId: number;
  requestedByRole: "org_admin" | "system_admin";
  requestedByOrganizationId: number | null;
  /** Fixed business scope supplied by singleton request context. */
  authorizedOrganizationId?: number;
  now?: Date;
}

export async function prepareRefundPaymentOperation(input: PrepareRefundPaymentOperationInput) {
  return db.transaction(async (tx: PaymentOperationTransaction) => {
    // Resolve the tenant/league without taking a financial row lock first.
    // The schedule advisory lock is the canonical outer lock for every
    // operation that can change obligation evidence; re-read the payment
    // under that lock before locking allocations or reservations.
    let [owned] = await tx.select({ payment: payments, league: leagues })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!owned) throw new RefundPreparationError("Payment not found", 404, "NOT_FOUND");
    const organizationId = owned.league.organizationId;
    const locationId = owned.league.locationId;
    if (organizationId === null) throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    if (input.authorizedOrganizationId !== undefined && organizationId !== input.authorizedOrganizationId) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    await lockLeagueSchedule(tx, organizationId, owned.payment.leagueId);
    [owned] = await tx.select({ payment: payments, league: leagues })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(and(
        eq(payments.id, input.paymentId),
        eq(payments.organizationId, organizationId),
        eq(leagues.organizationId, organizationId),
      ))
      .limit(1)
      .for("update");
    if (!owned) throw new RefundPreparationError("Payment not found", 404, "NOT_FOUND");
    if (input.requestedByRole === "org_admin" && input.requestedByOrganizationId !== organizationId) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    const [actor] = await tx.select({
      id: users.id,
      role: users.role,
      organizationId: users.organizationId,
    }).from(users).where(eq(users.id, input.requestedByUserId)).limit(1);
    if (
      !actor
      || actor.role !== input.requestedByRole
      || (actor.role === "org_admin" && actor.organizationId !== organizationId)
    ) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    const [creditFunding] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, organizationId),
      eq(rotatingCreditFundings.leagueId, owned.payment.leagueId),
      eq(rotatingCreditFundings.paymentId, input.paymentId),
    )).limit(1).for("share");
    if (creditFunding) {
      throw new RefundPreparationError(
        "Credit funding tenders can only be refunded through their personal credit balance",
        409,
        "ROTATING_CREDIT_REFUND_REQUIRED",
      );
    }
    const [ownedBowler] = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.id, owned.payment.bowlerId),
      eq(bowlers.organizationId, organizationId),
    )).limit(1);
    if (!ownedBowler) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    if (locationId !== null) {
      const [ownedLocation] = await tx.select({ id: locations.id }).from(locations).where(and(
        eq(locations.id, locationId),
        eq(locations.organizationId, organizationId),
      )).limit(1);
      if (!ownedLocation) {
        throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
      }
    }
    if (!isCardPaymentType(owned.payment.type)) {
      throw new RefundPreparationError("Only card payments can be refunded", 400, "INVALID_TYPE");
    }
    if (!owned.payment.providerPaymentId) {
      throw new RefundPreparationError("Payment has no provider charge to refund", 400, "INVALID_PROVIDER_PAYMENT");
    }
    const hasDisposition = input.disposition !== undefined && input.disposition !== null && input.disposition !== "";
    if (hasDisposition && (typeof input.disposition !== "string"
      || !REFUND_PAYMENT_DISPOSITIONS.includes(input.disposition as typeof REFUND_PAYMENT_DISPOSITIONS[number]))) {
      throw new RefundPreparationError("Choose whether the refunded amount is still owed or should be waived", 400, "VALIDATION_ERROR");
    }
    const requestedDisposition = hasDisposition
      ? input.disposition as typeof REFUND_PAYMENT_DISPOSITIONS[number]
      : null;
    const normalizedReason = normalizeReason(input.reason);
    const [existing] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.targetKey, `${REFUND_TARGET_PREFIX}${input.paymentId}`),
    )).limit(1);
    if (existing) {
      if ((existing.leagueId !== null && existing.leagueId !== owned.payment.leagueId)
        || existing.amountMinor !== owned.payment.amount
        || existing.currency !== "USD"
        || existing.providerName !== "square") {
        throw new PaymentOperationImmutableMismatchError();
      }
      const storedSnapshot = await loadRefundPaymentOperationSnapshotInTransaction(tx, existing);
      const replayDisposition = storedSnapshot?.snapshotVersion === REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION
        && storedSnapshot.allocations.length === 0
        ? "still_owed"
        : requestedDisposition;
      if (!storedSnapshot
        || storedSnapshot.paymentId !== input.paymentId
        || storedSnapshot.leagueId !== owned.payment.leagueId
        || storedSnapshot.providerPaymentId !== owned.payment.providerPaymentId
        || storedSnapshot.reason !== normalizedReason.reason
        || storedSnapshot.requestedReason !== normalizedReason.requestedReason
        || (storedSnapshot.snapshotVersion !== 1
          && (replayDisposition === null || storedSnapshot.disposition !== replayDisposition))) {
        throw new PaymentOperationImmutableMismatchError();
      }
      if (existing.status === "succeeded") {
        if (storedSnapshot.snapshotVersion === REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION) {
          try {
            const proof = await readCompletedOwnedPaymentRefundEvidenceInTransaction(tx, {
              organizationId,
              leagueId: owned.payment.leagueId,
              paymentId: input.paymentId,
              chargeOperationId: owned.payment.paymentOperationId ?? "",
              providerPaymentId: owned.payment.providerPaymentId ?? "",
              amountMinor: owned.payment.amount,
            });
            if (!proof || proof.refundOperationId !== existing.id) throw new OwnedPaymentRefundEvidenceError();
          } catch {
            throw new PaymentOperationImmutableMismatchError();
          }
        } else if (owned.payment.status !== "refunded"
          || !owned.payment.squareRefundId
          || existing.providerObjectId !== owned.payment.squareRefundId) {
          throw new PaymentOperationImmutableMismatchError();
        }
      }
      return { operation: existing, snapshot: storedSnapshot };
    }

    const adoption = await readOwnedLedgerAdoptionInTransaction(tx, {
      organizationId,
      leagueId: owned.payment.leagueId,
    });
    let fundingSnapshot: RefundPaymentFundingSnapshotV3[] | undefined;
    if (adoption) {
      const [fundingRows, fundingSources] = await Promise.all([
        tx.select().from(weeklyPaymentFundings).where(and(
          eq(weeklyPaymentFundings.organizationId, organizationId),
          eq(weeklyPaymentFundings.leagueId, owned.payment.leagueId),
          eq(weeklyPaymentFundings.paymentId, input.paymentId),
        )).orderBy(asc(weeklyPaymentFundings.portionIndex), asc(weeklyPaymentFundings.id)),
        readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
          organizationId,
          leagueId: owned.payment.leagueId,
          paymentId: input.paymentId,
        }),
      ]);
      if (fundingRows.length === 0
        || fundingRows.length !== fundingSources.length
        || fundingSources.some((source, index) => {
          const funding = fundingRows[index];
          return !funding
            || source.reviewRequired
            || source.fundingId !== funding.id
            || source.paymentId !== input.paymentId
            || source.creditedBowlerId !== funding.creditedBowlerId
            || source.portionIndex !== funding.portionIndex
            || source.amountMinor !== funding.amountMinor
            || source.availableMinor < 0
            || source.availableMinor > source.amountMinor;
        })) {
        throw new RefundPreparationError("This payment's owned funding evidence requires review before refunding", 409, "REFUND_FUNDING_EVIDENCE_MISMATCH");
      }
      try {
        await validateOwnedFundingPortionsForTenderInTransaction(tx, {
          payment: owned.payment,
          fundings: fundingRows,
        });
      } catch {
        refundSourceMismatch();
      }
      fundingSnapshot = fundingSources.map((source) => ({
        fundingId: source.fundingId,
        paymentId: source.paymentId,
        creditedBowlerId: source.creditedBowlerId,
        fundingAmountMinor: source.amountMinor,
        unusedCreditMinor: source.availableMinor,
        currency: "USD" as const,
      }));
    }
    const sourceAllocations = await tx.select({
      id: paymentAllocations.id,
      paymentId: paymentAllocations.paymentId,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      currency: paymentAllocations.currency,
      state: paymentAllocations.state,
      allocationKind: paymentAllocations.allocationKind,
      reviewRequired: paymentAllocations.reviewRequired,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, owned.payment.leagueId),
      eq(paymentAllocations.paymentId, input.paymentId),
    )).orderBy(paymentAllocations.id).for("update");
    const correctionRows = await tx.select().from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, organizationId),
      eq(paymentAllocationCorrections.leagueId, owned.payment.leagueId),
      eq(paymentAllocationCorrections.paymentId, input.paymentId),
    )).orderBy(paymentAllocationCorrections.createdAt, paymentAllocationCorrections.id);
    const allocationById = new Map(sourceAllocations.map((allocation) => [allocation.id, allocation]));
    const voidedAllocations = sourceAllocations.filter((allocation) => allocation.state === "voided");
    const correctionBySourceId = new Map(correctionRows.map((correction) => [correction.sourceAllocationId, correction]));
    const voidedAllocationIds = voidedAllocations.map((allocation) => allocation.id);
    const [voidedApplications, voidedReleases] = voidedAllocationIds.length === 0 ? [[], []] : await Promise.all([
      tx.select().from(paymentAllocationFundingApplications).where(and(
        eq(paymentAllocationFundingApplications.organizationId, organizationId),
        eq(paymentAllocationFundingApplications.leagueId, owned.payment.leagueId),
        inArray(paymentAllocationFundingApplications.allocationId, voidedAllocationIds),
      )),
      tx.select().from(weeklyPaymentAllocationReleases).where(and(
        eq(weeklyPaymentAllocationReleases.organizationId, organizationId),
        eq(weeklyPaymentAllocationReleases.leagueId, owned.payment.leagueId),
        inArray(weeklyPaymentAllocationReleases.sourceAllocationId, voidedAllocationIds),
      )),
    ]);
    const applicationsByVoidedAllocation = new Map<string, typeof voidedApplications>();
    for (const application of voidedApplications) applicationsByVoidedAllocation.set(application.allocationId, [
      ...(applicationsByVoidedAllocation.get(application.allocationId) ?? []), application,
    ]);
    const releasesByVoidedAllocation = new Map<string, typeof voidedReleases>();
    for (const release of voidedReleases) releasesByVoidedAllocation.set(release.sourceAllocationId, [
      ...(releasesByVoidedAllocation.get(release.sourceAllocationId) ?? []), release,
    ]);
    const correctionProvenIds = new Set<string>();
    const releaseProvenIds = new Set<string>();
    const provenVoids = voidedAllocations.every((source) => {
      const correction = correctionBySourceId.get(source.id);
      const replacement = correction ? allocationById.get(correction.replacementAllocationId) : undefined;
      const correctionIsValid = correction !== undefined
        && correction.organizationId === organizationId
        && correction.leagueId === owned.payment.leagueId
        && correction.paymentId === input.paymentId
        && correction.sourceObligationId === source.obligationId
        && correction.amountMinor === source.amountMinor
        && correction.currency === source.currency
        && source.allocationKind === "ordinary"
        && replacement !== undefined
        && replacement.state === "active"
        && replacement.allocationKind === "ordinary"
        && replacement.paymentId === input.paymentId
        && replacement.obligationId === correction.targetObligationId
        && replacement.amountMinor === correction.amountMinor
        && replacement.currency === correction.currency;
      const [application] = applicationsByVoidedAllocation.get(source.id) ?? [];
      const allocationReleases = releasesByVoidedAllocation.get(source.id) ?? [];
      const [release] = allocationReleases;
      const releaseIsValid = (applicationsByVoidedAllocation.get(source.id) ?? []).length === 1
        && application !== undefined
        && application.paymentId === input.paymentId
        && application.allocationId === source.id
        && application.genericFundingId !== null
        && application.rotatingFundingId === null
        && application.obligationId === source.obligationId
        && application.amountMinor === source.amountMinor
        && application.currency === source.currency
        && allocationReleases.length === 1
        && release !== undefined
        && release.fundingApplicationId === application.id
        && release.paymentId === input.paymentId
        && release.creditedBowlerId === application.creditedBowlerId
        && release.sourceObligationId === source.obligationId
        && release.sourceApplicationAmountMinor === source.amountMinor
        && release.releasedAmountMinor === source.amountMinor
        && release.retainedAmountMinor === 0
        && release.replacementAllocationId === null;
      if (correctionIsValid === releaseIsValid) return false;
      if (correctionIsValid) correctionProvenIds.add(source.id);
      if (releaseIsValid) releaseProvenIds.add(source.id);
      return true;
    });
    if (!provenVoids
      || correctionRows.length !== correctionProvenIds.size
      || voidedReleases.length !== releaseProvenIds.size) {
      throw new RefundPreparationError("This payment has voided allocation evidence and requires reconciliation before refunding", 409, "REFUND_ALLOCATION_STATE_CONFLICT");
    }
    const refundSourceAllocations = sourceAllocations.filter((allocation) => allocation.state === "active");
    if (refundSourceAllocations.some((allocation) => allocation.reviewRequired)) {
      throw new RefundPreparationError("This payment has allocation evidence requiring review before refunding", 409, "REFUND_ALLOCATION_REVIEW_REQUIRED");
    }
    const activeAllocationMinor = refundSourceAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if ((!adoption && (refundSourceAllocations.length === 0 || activeAllocationMinor !== owned.payment.amount))
      || (adoption && (fundingSnapshot === undefined
        || fundingSnapshot.reduce((sum, funding) => sum + funding.fundingAmountMinor, 0) !== owned.payment.amount
        || activeAllocationMinor + fundingSnapshot.reduce((sum, funding) => sum + funding.unusedCreditMinor, 0) !== owned.payment.amount))) {
      throw new RefundPreparationError("This payment's canonical allocation evidence does not match the full refund amount", 409, "REFUND_ALLOCATION_EVIDENCE_MISMATCH");
    }
    // A funding-only V3 refund has no debt disposition to make. Persist the
    // same inert default for every such request so retries remain identical.
    const disposition = adoption && refundSourceAllocations.length === 0
      ? "still_owed"
      : requestedDisposition;
    if (disposition === null) {
      throw new RefundPreparationError("Choose whether the refunded amount is still owed or should be waived", 400, "DISPOSITION_REQUIRED");
    }
    const sourceObligationIds = [...new Set(refundSourceAllocations.map((allocation) => allocation.obligationId))];
    if (sourceObligationIds.length > 0) {
      const sourceObligations = await tx.select({ id: paymentObligations.id, payerBowlerId: paymentObligations.payerBowlerId, occurrenceId: paymentObligations.occurrenceId }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, owned.payment.leagueId),
        inArray(paymentObligations.id, sourceObligationIds),
      ));
      if (sourceObligations.length !== sourceObligationIds.length) {
        throw new RefundPreparationError("This payment's allocation evidence references a missing obligation", 409, "REFUND_ALLOCATION_EVIDENCE_MISMATCH");
      }
      const payerIds = [...new Set(sourceObligations
        .map((obligation) => obligation.payerBowlerId)
        .filter((payerBowlerId): payerBowlerId is number => payerBowlerId !== null))];
      const includesUnassignedPayer = sourceObligations.some((obligation) => obligation.payerBowlerId === null);
      const occurrenceIds = [...new Set(sourceObligations.map((obligation) => obligation.occurrenceId))];
      const samePayerWeekObligations = await tx.select({ id: paymentObligations.id, payerBowlerId: paymentObligations.payerBowlerId, occurrenceId: paymentObligations.occurrenceId }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, owned.payment.leagueId),
        payerIds.length > 0 && includesUnassignedPayer
          ? or(inArray(paymentObligations.payerBowlerId, payerIds), isNull(paymentObligations.payerBowlerId))
          : payerIds.length > 0
            ? inArray(paymentObligations.payerBowlerId, payerIds)
            : isNull(paymentObligations.payerBowlerId),
        inArray(paymentObligations.occurrenceId, occurrenceIds),
      ));
      const sourceKeys = new Set(sourceObligations.map((obligation) => `${obligation.payerBowlerId}:${obligation.occurrenceId}`));
      const affectedObligationIds = samePayerWeekObligations
        .filter((obligation) => sourceKeys.has(`${obligation.payerBowlerId}:${obligation.occurrenceId}`))
        .map((obligation) => obligation.id);
      const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
        eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, owned.payment.leagueId),
        eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        inArray(paymentOperationRosterSnapshotItems.obligationId, affectedObligationIds),
      )).limit(1).for("update");
      if (reservations.length > 0) {
        throw new RefundPreparationError("A payment operation is already collecting an affected obligation; retry the refund after it completes", 409, "REFUND_ALLOCATION_RESERVED");
      }
    }
    if (owned.payment.status === "refunded") {
      throw new RefundPreparationError("Payment has already been refunded", 400, "ALREADY_REFUNDED");
    }
    if (owned.payment.status !== "paid") {
      throw new RefundPreparationError("Only paid payments can be refunded", 400, "INVALID_STATUS");
    }
    if (locationId === null) {
      throw new RefundPreparationError(
        "Assign a location with Square configured before refunding this payment",
        422,
        "PROVIDER_NOT_CONFIGURED",
      );
    }

    const operation = await createOrGetRefundPaymentOperation({
      organizationId,
      leagueId: owned.payment.leagueId,
      paymentId: input.paymentId,
      amountMinor: owned.payment.amount,
      currency: "USD",
      providerName: "square",
      now: input.now,
    }, tx);
    const snapshot: RefundPaymentSemanticSnapshot = adoption ? {
      snapshotVersion: REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION,
      organizationId,
      amountMinor: owned.payment.amount,
      currency: "USD",
      providerName: "square",
      paymentId: input.paymentId,
      leagueId: owned.payment.leagueId,
      locationId,
      providerPaymentId: owned.payment.providerPaymentId,
      reason: normalizedReason.reason,
      requestedReason: normalizedReason.requestedReason,
      requestedByUserId: input.requestedByUserId,
      requestedByRole: input.requestedByRole,
      requestedByOrganizationId: input.requestedByOrganizationId,
      disposition,
      allocations: refundSourceAllocations.map((allocation) => ({
        allocationId: allocation.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        currency: allocation.currency as "USD",
      })),
      fundingSnapshot: fundingSnapshot ?? [],
    } : {
      snapshotVersion: REFUND_PAYMENT_SNAPSHOT_VERSION,
      organizationId,
      amountMinor: owned.payment.amount,
      currency: "USD",
      providerName: "square",
      paymentId: input.paymentId,
      leagueId: owned.payment.leagueId,
      locationId,
      providerPaymentId: owned.payment.providerPaymentId,
      reason: normalizedReason.reason,
      requestedReason: normalizedReason.requestedReason,
      requestedByUserId: input.requestedByUserId,
      requestedByRole: input.requestedByRole,
      requestedByOrganizationId: input.requestedByOrganizationId,
      disposition,
      allocations: refundSourceAllocations.map((allocation) => ({
        allocationId: allocation.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        currency: allocation.currency as "USD",
      })),
    };
    const storedSnapshot = await persistRefundPaymentOperationSnapshot(operation, snapshot, tx);
    return { operation, snapshot: storedSnapshot };
  });
}
