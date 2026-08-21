import { and, desc, eq, inArray } from "drizzle-orm";
import {
  autopaySetupRequests,
  bowlerLeagues,
  bowlers,
  leagues,
  paymentSchedules,
  canonicalCollectionGroups,
  canonicalCollectionGroupMembers,
  payments,
  type AutopaySetupRequest,
  type AutopaySetupSnapshot,
  type League,
  type PaymentSchedule,
} from "@shared/schema";
import { db } from "../db.js";
import { decrypt } from "../utils/crypto.js";
import { getAcceptedPartnerBowlerIds } from "../storage/bowler-payment-links.js";
import {
  AutopaySetupRequestImmutableMismatchError,
  AutopaySetupRequestValidationError,
  cancelAutopaySetupRequest,
  createOrGetAutopaySetupRequest,
  finalizeZeroDollarAutopaySetupRequest,
  getAutopaySetupRequestForOrganization,
} from "../storage/autopay-setup-requests.js";
import { getUserByBowlerId } from "../storage/users.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { ProviderNotConfiguredError } from "./payment-errors.js";
import { buildLineItems, computePaymentSplit } from "./payment-execution.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import {
  planWeeklyAutopaySetup,
  type CanonicalCollectionGroupPlan,
  type AutopaySetupPlan,
} from "./weekly-billing-occurrence-planner.js";
import { autopaySetupOperationExecutor } from "./autopay-setup-operation-executor.js";
import { scheduledPaymentOperationExecutor } from "./scheduled-payment-operation-executor.js";

export interface AutopaySetupQuote {
  quoteFingerprint: string;
  generatedAt: string;
  immediateAmountMinor: number;
  coveredOccurrences: Array<{
    bowlerId: number;
    occurrenceAt: string;
    localDate: string;
    classification: "past_due" | "due_today";
    amountMinor: number;
  }>;
  firstAutomaticAt: string | null;
  firstAutomaticLocalDate: string | null;
  firstAutomaticAmountMinor: number;
  recurringAmountMinor: number;
  timezone: string;
  competitionStartTime: string;
  resuming: boolean;
}

export class AutopaySetupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AutopaySetupError";
  }
}

interface SetupContext {
  organizationId: number;
  league: League;
  payer: typeof bowlers.$inferSelect;
  additionalBowlerIds: number[];
  paidByUserId: number | null;
  plan: AutopaySetupPlan;
}

function quoteFromPlan(plan: AutopaySetupPlan, resuming = false): AutopaySetupQuote {
  return {
    quoteFingerprint: plan.quoteFingerprint,
    generatedAt: plan.generatedAt,
    immediateAmountMinor: plan.immediateAmountMinor,
    coveredOccurrences: plan.allocations.map((allocation) => ({
      bowlerId: allocation.bowlerId,
      occurrenceAt: allocation.occurrenceAt,
      localDate: allocation.localDate,
      classification: allocation.classification,
      amountMinor: allocation.amountMinor,
    })),
    firstAutomaticAt: plan.firstAutomaticOccurrence?.occurrenceAt ?? null,
    firstAutomaticLocalDate: plan.firstAutomaticOccurrence?.localDate ?? null,
    firstAutomaticAmountMinor: plan.firstAutomaticAmountMinor,
    recurringAmountMinor: plan.recurringAmountMinor,
    timezone: plan.timezone,
    competitionStartTime: plan.competitionStartTime,
    resuming,
  };
}

function quoteFromRequest(request: AutopaySetupRequest): AutopaySetupQuote {
  const { snapshot } = request;
  return {
    quoteFingerprint: request.quoteFingerprint,
    generatedAt: request.createdAt,
    immediateAmountMinor: snapshot.immediateAmountMinor,
    coveredOccurrences: snapshot.allocations.map((allocation) => ({
      bowlerId: allocation.bowlerId,
      occurrenceAt: allocation.occurrenceAt,
      localDate: allocation.localDate,
      classification: allocation.classification,
      amountMinor: allocation.amountMinor,
    })),
    firstAutomaticAt: snapshot.firstAutomaticAt,
    firstAutomaticLocalDate: snapshot.firstAutomaticLocalDate,
    firstAutomaticAmountMinor: snapshot.firstAutomaticAmountMinor,
    recurringAmountMinor: snapshot.recurringAmountMinor,
    timezone: snapshot.timezone,
    competitionStartTime: snapshot.competitionStartTime,
    resuming: true,
  };
}

async function loadSetupContext(input: {
  payerBowlerId: number;
  leagueId: number;
  additionalBowlerIds?: number[];
  now?: Date;
}): Promise<SetupContext> {
  const [league] = await db.select().from(leagues)
    .where(eq(leagues.id, input.leagueId))
    .limit(1);
  if (!league) throw new AutopaySetupError("LEAGUE_NOT_FOUND", "League not found.", 404);
  if (!league.organizationId) {
    throw new AutopaySetupError("ORG_REQUIRED", "League is not assigned to an organization.");
  }
  if (league.paymentMode === "upfront") {
    throw new AutopaySetupError(
      "INVALID_PAYMENT_MODE",
      "Weekly auto-pay is unavailable for upfront leagues.",
    );
  }
  const organizationId = league.organizationId;
  const [payer] = await db.select().from(bowlers).where(and(
    eq(bowlers.id, input.payerBowlerId),
    eq(bowlers.organizationId, organizationId),
  )).limit(1);
  if (!payer) {
    throw new AutopaySetupError(
      "FORBIDDEN",
      "Bowler does not belong to the league organization.",
      403,
    );
  }
  const [payerRoster] = await db.select({ bowlerId: bowlerLeagues.bowlerId })
    .from(bowlerLeagues)
    .where(and(
      eq(bowlerLeagues.bowlerId, payer.id),
      eq(bowlerLeagues.leagueId, league.id),
      eq(bowlerLeagues.active, true),
    ))
    .limit(1);
  if (!payerRoster) {
    throw new AutopaySetupError(
      "BOWLER_NOT_IN_LEAGUE",
      "Bowler is not active in this league.",
    );
  }

  const additionalBowlerIds = [...new Set(input.additionalBowlerIds ?? [])]
    .filter((id) => id !== payer.id)
    .sort((left, right) => left - right);
  if (
    additionalBowlerIds.length > 24
    || additionalBowlerIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new AutopaySetupError("INVALID_PARTNER", "Linked bowler selection is invalid.");
  }
  if (additionalBowlerIds.length > 0) {
    const accepted = new Set(await getAcceptedPartnerBowlerIds(payer.id, organizationId));
    if (additionalBowlerIds.some((id) => !accepted.has(id))) {
      throw new AutopaySetupError(
        "INVALID_PARTNER",
        "A selected bowler is not an accepted payment partner.",
        403,
      );
    }
    const [ownedPartners, activeRosters] = await Promise.all([
      db.select({ id: bowlers.id }).from(bowlers).where(and(
        inArray(bowlers.id, additionalBowlerIds),
        eq(bowlers.organizationId, organizationId),
      )),
      db.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).where(and(
        eq(bowlerLeagues.leagueId, league.id),
        eq(bowlerLeagues.active, true),
        inArray(bowlerLeagues.bowlerId, additionalBowlerIds),
      )),
    ]);
    if (
      ownedPartners.length !== additionalBowlerIds.length
      || activeRosters.length !== additionalBowlerIds.length
    ) {
      throw new AutopaySetupError(
        "BOWLER_NOT_IN_LEAGUE",
        "A selected bowler is not active in this league.",
      );
    }
  }

  const payeeIds = [payer.id, ...additionalBowlerIds];
  const paymentRows = await db.select({
    bowlerId: payments.bowlerId,
    amount: payments.amount,
    status: payments.status,
    weekOf: payments.weekOf,
  }).from(payments).where(and(
    eq(payments.leagueId, league.id),
    inArray(payments.bowlerId, payeeIds),
  ));
  const canonicalGroupRows = league.canonicalScheduleRevision > 0
    ? await db.select({
      groupId: canonicalCollectionGroups.id,
      triggerLocalDate: canonicalCollectionGroups.triggerLocalDate,
      pairedLocalDate: canonicalCollectionGroups.pairedLocalDate,
      role: canonicalCollectionGroupMembers.role,
      amountMinor: canonicalCollectionGroupMembers.amountMinor,
    }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
      eq(canonicalCollectionGroupMembers.groupId, canonicalCollectionGroups.id),
      eq(canonicalCollectionGroupMembers.organizationId, organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, league.id),
      eq(canonicalCollectionGroupMembers.active, true),
    )).where(and(
      eq(canonicalCollectionGroups.organizationId, organizationId),
      eq(canonicalCollectionGroups.leagueId, league.id),
      eq(canonicalCollectionGroups.state, "published"),
    )).orderBy(canonicalCollectionGroups.groupOrdinal, canonicalCollectionGroupMembers.memberOrdinal)
    : [];
  const canonicalCollectionGroupsForPlanner: CanonicalCollectionGroupPlan[] = [];
  for (let index = 0; index < canonicalGroupRows.length; index += 2) {
    const first = canonicalGroupRows[index];
    const second = canonicalGroupRows[index + 1];
    if (!first || !second || first.groupId !== second.groupId || first.role !== "trigger" || second.role !== "paired") {
      throw new AutopaySetupError("CANONICAL_EVIDENCE_INCOMPLETE", "Canonical collection-group evidence is incomplete.", 409);
    }
    canonicalCollectionGroupsForPlanner.push({
      triggerLocalDate: first.triggerLocalDate,
      pairedLocalDate: first.pairedLocalDate,
      triggerAmountMinor: first.amountMinor,
      pairedAmountMinor: second.amountMinor,
    });
  }
  if (league.canonicalScheduleRevision > 0 && canonicalCollectionGroupsForPlanner.length !== league.doublePayDates.length) {
    throw new AutopaySetupError("CANONICAL_EVIDENCE_INCOMPLETE", "Canonical double-pay grouping evidence is incomplete.", 409);
  }
  const plan = planWeeklyAutopaySetup({
    league,
    now: input.now,
    canonicalCollectionGroups: canonicalCollectionGroupsForPlanner,
    payees: payeeIds.map((bowlerId) => ({
      bowlerId,
      payments: paymentRows.filter((row) => row.bowlerId === bowlerId),
    })),
  });
  const paidByUser = additionalBowlerIds.length > 0
    ? await getUserByBowlerId(payer.id)
    : undefined;
  return {
    organizationId,
    league,
    payer,
    additionalBowlerIds,
    paidByUserId: paidByUser?.id ?? null,
    plan,
  };
}

async function getActiveSetup(context: SetupContext): Promise<AutopaySetupRequest | undefined> {
  const [row] = await db.select({ request: autopaySetupRequests })
    .from(autopaySetupRequests)
    .innerJoin(leagues, and(
      eq(leagues.id, autopaySetupRequests.leagueId),
      eq(leagues.organizationId, autopaySetupRequests.organizationId),
    ))
    .where(and(
      eq(autopaySetupRequests.organizationId, context.organizationId),
      eq(autopaySetupRequests.payerBowlerId, context.payer.id),
      eq(autopaySetupRequests.leagueId, context.league.id),
      eq(autopaySetupRequests.workflowStatus, "pending"),
    ))
    .limit(1);
  return row?.request;
}

async function getCompletedSetup(input: {
  context: SetupContext;
  quoteFingerprint?: string;
}): Promise<{ request: AutopaySetupRequest; schedule: PaymentSchedule | null } | undefined> {
  const conditions = [
    eq(autopaySetupRequests.organizationId, input.context.organizationId),
    eq(autopaySetupRequests.payerBowlerId, input.context.payer.id),
    eq(autopaySetupRequests.leagueId, input.context.league.id),
    eq(autopaySetupRequests.workflowStatus, "completed"),
  ];
  if (input.quoteFingerprint) {
    conditions.push(eq(autopaySetupRequests.quoteFingerprint, input.quoteFingerprint));
  }
  const [row] = await db.select({ request: autopaySetupRequests })
    .from(autopaySetupRequests)
    .where(and(...conditions))
    .orderBy(desc(autopaySetupRequests.completedAt))
    .limit(1);
  const request = row?.request;
  if (
    !request
    || canonicalizePaymentOperationInput(request.snapshot.additionalBowlerIds)
      !== canonicalizePaymentOperationInput(input.context.additionalBowlerIds)
  ) {
    return undefined;
  }
  const schedule = request.paymentScheduleId === null
    ? null
    : await db.select().from(paymentSchedules).where(and(
      eq(paymentSchedules.id, request.paymentScheduleId),
      eq(paymentSchedules.active, true),
    )).limit(1).then((rows) => rows[0] ?? null);
  if (request.paymentScheduleId !== null && schedule === null) return undefined;
  return { request, schedule };
}

async function assertNoActiveSchedule(context: SetupContext): Promise<void> {
  const [schedule] = await db.select({ id: paymentSchedules.id })
    .from(paymentSchedules)
    .where(and(
      eq(paymentSchedules.bowlerId, context.payer.id),
      eq(paymentSchedules.leagueId, context.league.id),
      eq(paymentSchedules.active, true),
    ))
    .limit(1);
  if (schedule) {
    throw new AutopaySetupError(
      "SCHEDULE_EXISTS",
      "An active payment schedule already exists.",
      409,
    );
  }
}

export async function getWeeklyAutopaySetupQuote(input: {
  payerBowlerId: number;
  leagueId: number;
  additionalBowlerIds?: number[];
  now?: Date;
}): Promise<AutopaySetupQuote> {
  const context = await loadSetupContext(input);
  const active = await getActiveSetup(context);
  if (active) return quoteFromRequest(active);
  const completed = await getCompletedSetup({ context });
  if (completed) return quoteFromRequest(completed.request);
  await assertNoActiveSchedule(context);
  return quoteFromPlan(context.plan);
}

function buildSnapshot(
  context: SetupContext,
): Omit<
  AutopaySetupSnapshot,
  "snapshotVersion" | "organizationId" | "payerBowlerId" | "leagueId" | "sourceFingerprint"
> {
  const immediateAmountMinor = context.plan.immediateAmountMinor;
  const quantity = immediateAmountMinor > 0
    && immediateAmountMinor % context.league.weeklyFee === 0
    ? String(immediateAmountMinor / context.league.weeklyFee)
    : null;
  const lineItems = quantity === null ? [] : buildLineItems(context.league, quantity);
  return {
    locationId: context.league.locationId as number,
    providerName: "square",
    currency: "USD",
    additionalBowlerIds: context.additionalBowlerIds,
    immediateAmountMinor,
    allocations: context.plan.allocations.map((allocation, allocationIndex) => {
      const split = computePaymentSplit(allocation.amountMinor, context.league);
      const partner = allocation.bowlerId !== context.payer.id;
      return {
        allocationIndex,
        bowlerId: allocation.bowlerId,
        occurrenceAt: allocation.occurrenceAt,
        localDate: allocation.localDate,
        classification: allocation.classification,
        amountMinor: allocation.amountMinor,
        lineageAmountMinor: split.lineageAmount ?? null,
        prizeFundAmountMinor: split.prizeFundAmount ?? null,
        notes: (allocation.classification === "past_due" ? "Past-due" : "Due-today")
          + " auto-pay setup allocation"
          + (allocation.isDoublePay ? " (double-pay occurrence)" : ""),
        paidByUserId: partner ? context.paidByUserId : null,
      };
    }),
    firstAutomaticAt: context.plan.firstAutomaticOccurrence?.occurrenceAt ?? null,
    firstAutomaticLocalDate: context.plan.firstAutomaticOccurrence?.localDate ?? null,
    firstAutomaticAmountMinor: context.plan.firstAutomaticAmountMinor,
    recurringAmountMinor: context.plan.recurringAmountMinor,
    timezone: context.plan.timezone,
    competitionStartTime: context.plan.competitionStartTime,
    requestKind: immediateAmountMinor === 0
      ? null
      : lineItems.length > 0 ? "order" : "direct",
    lineItems,
  };
}

function snapshotInputFromRequest(
  request: AutopaySetupRequest,
): ReturnType<typeof buildSnapshot> {
  const {
    snapshotVersion: _snapshotVersion,
    organizationId: _organizationId,
    payerBowlerId: _payerBowlerId,
    leagueId: _leagueId,
    sourceFingerprint: _sourceFingerprint,
    ...snapshot
  } = request.snapshot;
  return snapshot;
}

function operationError(status: string, errorCode: string | null): AutopaySetupError {
  if (status === "action_required") {
    return new AutopaySetupError(
      "PAYMENT_ACTION_REQUIRED",
      "The card was declined. Choose another saved card and try again.",
      402,
    );
  }
  if (status === "provider_unknown" || status === "reconciliation_required") {
    return new AutopaySetupError(
      "PAYMENT_OUTCOME_PENDING",
      "The payment outcome is being verified. Do not submit another payment.",
      503,
    );
  }
  if (status === "retry_scheduled" || status === "leased" || status === "pending") {
    return new AutopaySetupError(
      "PAYMENT_RETRY_SCHEDULED",
      "The payment is still processing and will resume safely.",
      503,
    );
  }
  return new AutopaySetupError(
    errorCode ?? "PAYMENT_NOT_COMPLETED",
    "The payment could not be completed.",
    409,
  );
}

export async function setupWeeklyAutopay(input: {
  payerBowlerId: number;
  leagueId: number;
  additionalBowlerIds?: number[];
  quoteFingerprint: string;
  sourceId: string;
  buyerEmail?: string;
  now?: Date;
}): Promise<{
  quote: AutopaySetupQuote;
  request: AutopaySetupRequest;
  schedule: PaymentSchedule | null;
}> {
  const context = await loadSetupContext(input);
  const completed = await getCompletedSetup({
    context,
    quoteFingerprint: input.quoteFingerprint,
  });
  if (completed) {
    return {
      quote: quoteFromRequest(completed.request),
      request: completed.request,
      schedule: completed.schedule,
    };
  }
  let active = await getActiveSetup(context);
  if (active && active.quoteFingerprint !== input.quoteFingerprint) {
    throw new AutopaySetupError(
      "SETUP_IN_PROGRESS",
      "Another auto-pay setup is already in progress. Refresh to resume it safely.",
      409,
    );
  }
  if (active && decrypt(active.encryptedSourceId) !== input.sourceId) {
    const activeState = await getAutopaySetupRequestForOrganization(
      context.organizationId,
      active.id,
    );
    if (
      activeState?.operation
      && ["action_required", "failed_terminal", "canceled"].includes(
        activeState.operation.status,
      )
    ) {
      await cancelAutopaySetupRequest({
        organizationId: context.organizationId,
        requestId: active.id,
        now: input.now,
      });
      active = undefined;
    } else {
      throw new AutopaySetupError(
        "SETUP_IN_PROGRESS",
        "This auto-pay setup is already tied to another saved card. Refresh to resume it safely.",
        409,
      );
    }
  }
  if (!active) {
    await assertNoActiveSchedule(context);
    if (context.plan.quoteFingerprint !== input.quoteFingerprint) {
      throw new AutopaySetupError(
        "QUOTE_CHANGED",
        "The auto-pay amounts changed. Review the updated quote before confirming.",
        409,
      );
    }
  }
  if (context.league.locationId === null) {
    throw new AutopaySetupError(
      "PROVIDER_NOT_CONFIGURED",
      "Payment processing is not configured for this league.",
    );
  }

  let provider;
  try {
    provider = await getPaymentProvider(context.league.locationId);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      throw new AutopaySetupError(
        "PROVIDER_NOT_CONFIGURED",
        "Payment processing is not configured for this league.",
      );
    }
    throw error;
  }
  if (provider.providerName !== "square" || !provider.validateCardId(input.sourceId)) {
    throw new AutopaySetupError(
      "INVALID_PAYMENT_SOURCE",
      "Select a saved card for automatic payments.",
    );
  }
  const customerId = getProviderCustomerId(context.payer, provider);
  if (!customerId) {
    throw new AutopaySetupError(
      "PAYMENT_CUSTOMER_REQUIRED",
      "The payer does not have a payment customer account.",
    );
  }
  const cards = await provider.listCardsOnFile(customerId);
  if (!cards.some((card) => card.id === input.sourceId)) {
    throw new AutopaySetupError(
      "CARD_OWNERSHIP_MISMATCH",
      "The selected card does not belong to this payer.",
      403,
    );
  }
  const buyerEmail = active?.encryptedBuyerEmail
    ? decrypt(active.encryptedBuyerEmail)
    : context.payer.email || input.buyerEmail?.trim() || null;
  if (!buyerEmail) {
    throw new AutopaySetupError(
      "BUYER_EMAIL_REQUIRED",
      "A buyer email is required so Square can send payment receipts.",
    );
  }

  let created;
  try {
    created = await createOrGetAutopaySetupRequest({
      organizationId: context.organizationId,
      payerBowlerId: context.payer.id,
      leagueId: context.league.id,
      quoteFingerprint: input.quoteFingerprint,
      sourceId: input.sourceId,
      customerId: active?.encryptedCustomerId
        ? decrypt(active.encryptedCustomerId)
        : customerId,
      buyerEmail,
      snapshot: active ? snapshotInputFromRequest(active) : buildSnapshot(context),
      now: input.now,
    });
  } catch (error) {
    if (
      error instanceof AutopaySetupRequestImmutableMismatchError
      || error instanceof AutopaySetupRequestValidationError
    ) {
      throw new AutopaySetupError(
        "SETUP_CONFLICT",
        "Auto-pay setup changed or is already in progress. Refresh before trying again.",
        409,
      );
    }
    throw error;
  }

  if (created.operation === null) {
    const finalized = await finalizeZeroDollarAutopaySetupRequest({
      organizationId: context.organizationId,
      requestId: created.request.id,
      now: input.now,
    });
    return {
      quote: quoteFromRequest(finalized.request),
      request: finalized.request,
      schedule: finalized.schedule,
    };
  }

  try {
    await autopaySetupOperationExecutor.execute({
      organizationId: context.organizationId,
      operationId: created.operation.id,
      now: input.now,
    });
  } finally {
    // A provider success followed by a local transaction failure deliberately
    // leaves the fenced operation leased. Always re-arm so its expiry is
    // recovered without requiring the user to submit the setup again.
    await scheduledPaymentOperationExecutor.rearm();
  }
  const current = await getAutopaySetupRequestForOrganization(
    context.organizationId,
    created.request.id,
  );
  if (!current) {
    throw new AutopaySetupError("SETUP_NOT_FOUND", "Auto-pay setup could not be restored.", 500);
  }
  if (current.request.workflowStatus === "completed") {
    const schedule = current.request.paymentScheduleId === null
      ? null
      : await db.select().from(paymentSchedules)
        .where(eq(paymentSchedules.id, current.request.paymentScheduleId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    return {
      quote: quoteFromRequest(current.request),
      request: current.request,
      schedule,
    };
  }
  if (!current.operation) {
    throw new AutopaySetupError("SETUP_OPERATION_MISSING", "Payment operation is missing.", 500);
  }
  throw operationError(current.operation.status, current.operation.errorCode);
}
