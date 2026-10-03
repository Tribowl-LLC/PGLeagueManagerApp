import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  bowlers,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagues,
  paymentOperations,
  payments,
  type AccountPaymentFundingPortionV4,
  type PaymentOperation,
} from "@shared/schema";
import {
  accountPaymentFundingQuoteResponseV4Schema,
  resolveAccountPaymentFundingChargeAmountV4,
  type AccountPaymentFundingQuoteRequestV4,
  type AccountPaymentFundingQuoteResponseV4,
  type AccountPaymentFundingSelectionV4,
  type AccountPaymentParticipantsResponseV4,
} from "@shared/account-payment-v4-contract";
import { providerNameToPaymentType } from "@shared/schema/constants";
import { db } from "../db.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { ensureProviderCustomer, getProviderCustomerId } from "./payment-utils.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  getAccountPaymentOperationSnapshotForOrganization,
  getAccountPaymentOperationSnapshotInTransaction,
  getPaymentOperationForOrganization,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import { RosterPaymentError, fifoCandidatesInTransaction, type FifoPaymentCandidate } from "./roster-payment-core.js";
import { comparePublishedCollectionOrder } from "./automatic-fifo-allocation.js";
import {
  dueNowFifoPrefixMinor,
  normalizeInteractivePaymentTransactionTimestamp,
  partnerLinkFingerprint,
  resolveParticipantsInTransaction,
} from "./interactive-partner-payment.js";
import { buildOneTimePaymentOptions } from "@shared/one-time-payment-options";
import { effectiveCollectionPrefixMinor, projectStandingAccountFundingTarget, type StandingAccountFundingTarget } from "./account-payment-funding-targets.js";
import {
  readOwnedAccountBalancesInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  readConfirmedOwnedObligationsInTransaction,
} from "./owned-payment-ledger.js";
import { prepareAccountPaymentOperation } from "./account-payment-operation-preparation.js";
import { hasUnresolvedAccountFundingOverlapInTransaction } from "./account-payment-operation-guards.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { paymentOperationRetryExecutor } from "./payment-operation-retry-executor.js";
import type { AccountPaymentOperationExecutionSnapshot } from "./account-payment-operation-snapshot.js";
import type { AccountPaymentOperationPreparationInput } from "./account-payment-operation-snapshot.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { accountPaymentFundingSelectionV4Schema } from "@shared/account-payment-v4-contract";

function quoteFingerprintV4(value: unknown): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex");
  return `lvaccountfundquote:v4:${digest}`;
}

type ForecastParticipant = {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  confirmedDebtMinor: number;
  availableCreditMinor: number;
  forecastTargets: {
    currentCollectionMinor: number;
    selectedWeeks: Array<{ weeks: number; amountMinor: number }>;
    fullSeasonMinor: number;
  };
};

type AccountContext = {
  response: AccountPaymentParticipantsResponseV4;
  recipientById: Map<number, ForecastParticipant>;
  partnerLinkById: Map<number, { id: number; fingerprint: string } | null>;
};

async function addConfirmedLedgerCandidates(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
  participants: Array<{ bowlerId: number; candidates: FifoPaymentCandidate[] }>,
  debts: Awaited<ReturnType<typeof readConfirmedOwnedObligationsInTransaction>>,
): Promise<Map<number, FifoPaymentCandidate[]>> {
  const byOwner = new Map(participants.map((participant) => [participant.bowlerId, [...participant.candidates]]));
  const existingIds = new Set(participants.flatMap((participant) => participant.candidates.map((candidate) => candidate.id)));
  const missing = debts.filter((debt) => !existingIds.has(debt.obligationId));
  if (missing.length === 0) return byOwner;
  const occurrenceIds = [...new Set(missing.map((debt) => debt.occurrenceId))];
  const [occurrences, terms, members] = await Promise.all([
    tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, plannedOrdinal: leagueOccurrences.plannedOrdinal })
      .from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.id, occurrenceIds),
      )),
    tx.select({ occurrenceId: leagueOccurrenceBillingTerms.occurrenceId, billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal })
      .from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
        eq(leagueOccurrenceBillingTerms.state, "published"),
        inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
      )),
    tx.select({ groupId: canonicalCollectionGroupMembers.groupId, occurrenceId: canonicalCollectionGroupMembers.occurrenceId, role: canonicalCollectionGroupMembers.role, memberOrdinal: canonicalCollectionGroupMembers.memberOrdinal, billingOrdinal: canonicalCollectionGroupMembers.billingOrdinal })
      .from(canonicalCollectionGroupMembers).innerJoin(canonicalCollectionGroups, and(
        eq(canonicalCollectionGroups.id, canonicalCollectionGroupMembers.groupId),
        eq(canonicalCollectionGroups.organizationId, input.organizationId),
        eq(canonicalCollectionGroups.leagueId, input.leagueId),
        eq(canonicalCollectionGroups.state, "published"),
      )).where(and(
        eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
        eq(canonicalCollectionGroupMembers.active, true),
        inArray(canonicalCollectionGroupMembers.occurrenceId, occurrenceIds),
      )),
  ]);
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const billingByOccurrence = new Map<string, number>();
  for (const term of terms) {
    if (term.billingOrdinal !== null) billingByOccurrence.set(term.occurrenceId, term.billingOrdinal);
  }
  const memberByOccurrence = new Map(members.map((member) => [member.occurrenceId, member]));
  const groupIds = [...new Set(members.map((member) => member.groupId))];
  const triggerRows = groupIds.length === 0 ? [] : await tx.select({ groupId: canonicalCollectionGroupMembers.groupId, startAt: leagueOccurrences.startAt })
    .from(canonicalCollectionGroupMembers).innerJoin(leagueOccurrences, and(
      eq(leagueOccurrences.id, canonicalCollectionGroupMembers.occurrenceId),
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
    )).where(and(
      eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
      eq(canonicalCollectionGroupMembers.role, "trigger"),
      eq(canonicalCollectionGroupMembers.active, true),
      inArray(canonicalCollectionGroupMembers.groupId, groupIds),
    ));
  const triggerAtByGroup = new Map(triggerRows.map((row) => [row.groupId, new Date(row.startAt).toISOString()]));
  for (const debt of missing) {
    const occurrence = occurrenceById.get(debt.occurrenceId);
    if (!occurrence) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "A confirmed account debt is missing its canonical occurrence", 503);
    const member = memberByOccurrence.get(debt.occurrenceId);
    const triggerAt = member?.role === "paired" ? triggerAtByGroup.get(member.groupId) : undefined;
    if (member?.role === "paired" && !triggerAt) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "A confirmed paired fee is missing its published trigger", 503);
    const dueAt = new Date(debt.dueAt).toISOString();
    const candidate: FifoPaymentCandidate = {
      id: debt.obligationId,
      responsibilityId: debt.responsibilityId,
      occurrenceId: debt.occurrenceId,
      amountMinor: debt.amountMinor,
      state: debt.outstandingMinor === debt.amountMinor ? "open" : "partially_settled",
      outstandingMinor: debt.outstandingMinor,
      dueAt,
      pastDueAt: dueAt,
      payerBowlerId: debt.debtorBowlerId,
      currency: "USD",
      memberOrdinal: member?.memberOrdinal ?? 0,
      billingOrdinal: member?.billingOrdinal ?? billingByOccurrence.get(debt.occurrenceId) ?? occurrence.plannedOrdinal ?? 0,
      reservedMinor: 0,
      reviewRequired: debt.reviewRequired,
      pairedCollectionReady: member?.role === "paired" && triggerAt !== undefined,
      effectiveCollectionAt: triggerAt ?? dueAt,
      occurrenceLocalDate: debt.occurrenceLocalDate,
      plannedOrdinal: occurrence.plannedOrdinal,
    };
    byOwner.set(debt.debtorBowlerId, [...(byOwner.get(debt.debtorBowlerId) ?? []), candidate]);
  }
  for (const [bowlerId, candidates] of byOwner) byOwner.set(bowlerId, candidates.sort(comparePublishedCollectionOrder));
  return byOwner;
}

export type OwnedAccountFundingTargetEvidence = {
  recipientBowlerId: number;
  asOf: string;
  confirmedDebts: Awaited<ReturnType<typeof readConfirmedOwnedObligationsInTransaction>>;
  candidates: FifoPaymentCandidate[];
  availableCreditMinor: number;
  scopedTarget: StandingAccountFundingTarget;
};

/** Read canonical account evidence for an explicit owner scope and projection
 * time. This reader deliberately does not resolve or lock interactive partner
 * links. Candidate rows are locked by default for charge preparation, so those
 * callers must hold the league schedule lock. Read-only report projections
 * must explicitly set forUpdateCandidates:false; the remaining evidence
 * readers in this path do not lock rows. Callers select the occurrence scope
 * they are authorized to project and cannot turn unrelated forecasts into a
 * charge target. */
export async function readOwnedAccountFundingTargetEvidenceInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    recipientIds: number[];
    asOf: string;
    collectionRequirementOccurrenceIdsByRecipient: ReadonlyMap<number, readonly string[]>;
    forUpdateCandidates?: boolean;
  },
): Promise<Map<number, OwnedAccountFundingTargetEvidence>> {
  const parsedAsOf = new Date(input.asOf);
  if (!Number.isFinite(parsedAsOf.getTime())) throw new RosterPaymentError("INVALID_TIMESTAMP", "The account funding projection timestamp is invalid", 422);
  const asOf = parsedAsOf.toISOString();
  const recipientIds = [...new Set(input.recipientIds)];
  if (recipientIds.length === 0) return new Map();
  const [debts, balances, candidateLists] = await Promise.all([
    readConfirmedOwnedObligationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerIds: recipientIds }),
    readOwnedAccountBalancesInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerIds: recipientIds }),
    Promise.all(recipientIds.map(async (bowlerId) => ({
      bowlerId,
      candidates: await fifoCandidatesInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        payerBowlerId: bowlerId,
        forUpdate: input.forUpdateCandidates !== false,
      }),
    }))),
  ]);
  const candidatesByOwner = await addConfirmedLedgerCandidates(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  }, candidateLists, debts);
  const result = new Map<number, OwnedAccountFundingTargetEvidence>();
  for (const bowlerId of recipientIds) {
    const balance = balances.get(bowlerId);
    const requirementIds = input.collectionRequirementOccurrenceIdsByRecipient.get(bowlerId) ?? [];
    const ownerDebts = debts.filter((debt) => debt.debtorBowlerId === bowlerId).map((debt) => ({
      obligationId: debt.obligationId,
      occurrenceId: debt.occurrenceId,
      outstandingMinor: debt.outstandingMinor,
      reviewRequired: debt.reviewRequired,
    }));
    const candidates = candidatesByOwner.get(bowlerId) ?? [];
    const availableCreditMinor = balance?.availableCreditMinor ?? 0;
    const scopedTarget = projectStandingAccountFundingTarget({
      candidates,
      confirmedDebts: ownerDebts,
      availableCreditMinor,
      cutoffAt: asOf,
      collectionRequirementOccurrenceIds: requirementIds,
    });
    result.set(bowlerId, {
      recipientBowlerId: bowlerId,
      asOf,
      confirmedDebts: debts.filter((debt) => debt.debtorBowlerId === bowlerId),
      candidates,
      availableCreditMinor,
      scopedTarget,
    });
  }
  return result;
}

async function transactionNow(tx: PaymentOperationTransaction): Promise<string> {
  const result = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
  return normalizeInteractivePaymentTransactionTimestamp((result as { rows?: Array<{ now?: unknown }> }).rows?.[0]?.now);
}

export function forecastProjection(input: {
  candidates: FifoPaymentCandidate[];
  confirmedObligationIds: ReadonlySet<string>;
  confirmedDebtMinor: number;
  paymentMode: "weekly" | "upfront";
  now: string;
  forecastOccurrenceIds?: ReadonlySet<string>;
}) {
  const orderedCandidates = [...input.candidates].sort(comparePublishedCollectionOrder);
  const forecasts = orderedCandidates.filter((candidate) => !input.confirmedObligationIds.has(candidate.id)
    && (!input.forecastOccurrenceIds || input.forecastOccurrenceIds.has(candidate.occurrenceId)));
  if (forecasts.some((candidate) => candidate.reviewRequired)) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "Forecast payment evidence requires staff review", 503);
  }
  const forecastBalanceMinor = forecasts.reduce((sum, candidate) => sum + candidate.outstandingMinor, 0);
  const totalTargetMinor = input.confirmedDebtMinor + forecastBalanceMinor;
  const projectionCandidates = input.forecastOccurrenceIds
    ? orderedCandidates.filter((candidate) => input.confirmedObligationIds.has(candidate.id)
      || input.forecastOccurrenceIds?.has(candidate.occurrenceId))
    : orderedCandidates;
  const options = buildOneTimePaymentOptions(projectionCandidates, totalTargetMinor);
  const dueNowForecastMinor = effectiveCollectionPrefixMinor(forecasts, input.now);
  const currentCollectionMinor = input.paymentMode === "upfront"
    ? totalTargetMinor
    : input.confirmedDebtMinor + dueNowForecastMinor;
  return {
    forecasts,
    currentCollectionMinor,
    selectedWeeks: input.paymentMode === "weekly" ? options.map((option) => ({ weeks: option.weekCount, amountMinor: option.amountMinor })) : [],
    fullSeasonMinor: totalTargetMinor,
    forecastBalanceMinor,
  };
}

async function accountContextInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; payerBowlerId: number },
  options: { lock?: boolean; now?: string } = {},
): Promise<AccountContext> {
  if (options.lock !== false) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
  const now = options.now ?? await transactionNow(tx);
  const adoption = await readOwnedLedgerAdoptionInTransaction(tx, input);
  const resolved = await resolveParticipantsInTransaction(tx, { ...input, now });
  const base = {
    contractVersion: "interactive-payment-participants/4" as const,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
  };
  if (!adoption) {
    return {
      response: { ...base, accountingMode: "legacy_roster_v3" },
      recipientById: new Map(),
      partnerLinkById: new Map(),
    };
  }

  const recipientIds = resolved.participants.map((participant) => participant.bowlerId);
  const [debts, balances] = await Promise.all([
    readConfirmedOwnedObligationsInTransaction(tx, { ...input, bowlerIds: recipientIds }),
    readOwnedAccountBalancesInTransaction(tx, { ...input, bowlerIds: recipientIds }),
  ]);
  const candidatesByOwner = await addConfirmedLedgerCandidates(tx, input, resolved.participants, debts);
  const debtByOwner = new Map<number, number>();
  const obligationIdsByOwner = new Map<number, Set<string>>();
  for (const debt of debts) {
    debtByOwner.set(debt.debtorBowlerId, (debtByOwner.get(debt.debtorBowlerId) ?? 0) + debt.outstandingMinor);
    const ownerIds = obligationIdsByOwner.get(debt.debtorBowlerId) ?? new Set<string>();
    ownerIds.add(debt.obligationId);
    obligationIdsByOwner.set(debt.debtorBowlerId, ownerIds);
  }

  const recipientById = new Map<number, ForecastParticipant>();
  const partnerLinkById = new Map<number, { id: number; fingerprint: string } | null>();
  const recipients: ForecastParticipant[] = [];
  for (const participant of resolved.participants) {
    const ownerDebtIds = obligationIdsByOwner.get(participant.bowlerId) ?? new Set<string>();
    const projected = forecastProjection({
      candidates: candidatesByOwner.get(participant.bowlerId) ?? participant.candidates,
      confirmedObligationIds: ownerDebtIds,
      confirmedDebtMinor: debtByOwner.get(participant.bowlerId) ?? 0,
      paymentMode: resolved.league.paymentMode,
      now,
    });
    const balance = balances.get(participant.bowlerId);
    const response: ForecastParticipant = {
      bowlerId: participant.bowlerId,
      name: participant.name,
      role: participant.role,
      confirmedDebtMinor: debtByOwner.get(participant.bowlerId) ?? 0,
      availableCreditMinor: balance?.availableCreditMinor ?? 0,
      forecastTargets: {
        currentCollectionMinor: projected.currentCollectionMinor,
        selectedWeeks: projected.selectedWeeks,
        fullSeasonMinor: projected.fullSeasonMinor,
      },
    };
    recipients.push(response);
    recipientById.set(response.bowlerId, response);
    partnerLinkById.set(response.bowlerId, participant.link
      ? { id: participant.link.id, fingerprint: partnerLinkFingerprint(participant.link) }
      : null);
  }
  const contractResponse = {
    ...base,
    accountingMode: "confirmed_account_v4" as const,
    paymentMode: resolved.league.paymentMode,
    recipients,
  };
  return {
    response: contractResponse,
    recipientById,
    partnerLinkById,
  };
}

function assertRequestPayerMatches(input: {
  payerBowlerId: number;
  request: Pick<AccountPaymentFundingQuoteRequestV4, "payerBowlerId">;
}): void {
  if (input.request.payerBowlerId !== undefined && input.request.payerBowlerId !== input.payerBowlerId) {
    throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The selected payer does not match the authorized payer", 403);
  }
}

export async function readInteractivePaymentParticipantsV4(input: {
  organizationId: number;
  leagueId: number;
  payerBowlerId: number;
}): Promise<AccountPaymentParticipantsResponseV4> {
  return db.transaction(async (tx) => (await accountContextInTransaction(tx, input)).response);
}

function selectedCollectionTargets(
  selection: AccountPaymentFundingSelectionV4,
  participant: ForecastParticipant,
  paymentMode: "weekly" | "upfront",
): { collectionTargetMinor: number; forecastCollectionTargetMinor: number } {
  if (selection.kind === "explicit_amount") return { collectionTargetMinor: 0, forecastCollectionTargetMinor: 0 };
  if (selection.kind === "confirmed_debt_balance") return { collectionTargetMinor: participant.confirmedDebtMinor, forecastCollectionTargetMinor: 0 };
  if (paymentMode === "upfront" && selection.scope === "selected_weeks") {
    throw new RosterPaymentError("UPFRONT_FULL_BALANCE_REQUIRED", "Upfront checkout must use the full-season forecast target", 422);
  }
  const collectionTargetMinor = selection.scope === "current_collection"
    ? participant.forecastTargets.currentCollectionMinor
    : selection.scope === "full_season"
      ? participant.forecastTargets.fullSeasonMinor
      : participant.forecastTargets.selectedWeeks.find((item) => item.weeks === selection.weeks)?.amountMinor ?? -1;
  if (collectionTargetMinor < 0) throw new RosterPaymentError("WEEKS_SELECTION_INVALID", "The selected forecast weeks are unavailable", 409);
  return {
    collectionTargetMinor,
    forecastCollectionTargetMinor: Math.max(0, collectionTargetMinor - participant.confirmedDebtMinor),
  };
}

export async function quoteAccountPaymentFundingV4(input: {
  organizationId: number;
  leagueId: number;
  payerBowlerId: number;
  request: AccountPaymentFundingQuoteRequestV4;
  transaction?: PaymentOperationTransaction;
}): Promise<AccountPaymentFundingQuoteResponseV4> {
  assertRequestPayerMatches(input);
  const run = async (tx: PaymentOperationTransaction) => {
    const context = await accountContextInTransaction(tx, input, { lock: !input.transaction });
    if (context.response.accountingMode !== "confirmed_account_v4") {
      throw new RosterPaymentError("ACCOUNT_PAYMENT_V4_REQUIRED", "This league uses legacy payment checkout", 409);
    }
    const paymentMode = context.response.paymentMode;
    const selectionById = new Map(input.request.recipients.map((recipient) => [recipient.bowlerId, recipient.selection]));
    if (selectionById.size !== input.request.recipients.length) throw new RosterPaymentError("INVALID_RECIPIENT_SELECTION", "Each recipient may be selected only once", 422);
    const quoteRecipients = [...input.request.recipients].sort((a, b) => a.bowlerId - b.bowlerId).map(({ bowlerId, selection: rawSelection }) => {
      const participant = context.recipientById.get(bowlerId);
      if (!participant) throw new RosterPaymentError("PARTNER_AUTHORIZATION_REQUIRED", "The selected recipient is not an active direct payment partner in this league", 403);
      const selection = accountPaymentFundingSelectionV4Schema.parse(rawSelection);
      const targets = selectedCollectionTargets(selection, participant, paymentMode);
      const providerChargeAmountMinor = resolveAccountPaymentFundingChargeAmountV4({
        selection,
        confirmedDebtMinor: participant.confirmedDebtMinor,
        availableCreditMinor: participant.availableCreditMinor,
        collectionTargetMinor: targets.collectionTargetMinor,
        forecastCollectionTargetMinor: targets.forecastCollectionTargetMinor,
      });
      return {
        bowlerId,
        name: participant.name,
        role: participant.role,
        selection,
        confirmedDebtMinor: participant.confirmedDebtMinor,
        availableCreditMinor: participant.availableCreditMinor,
        ...targets,
        providerChargeAmountMinor,
      };
    });
    const unsigned = {
      contractVersion: "account-payment-funding-quote/4" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      currency: "USD" as const,
      recipients: quoteRecipients,
      providerChargeAmountMinor: quoteRecipients.reduce((sum, recipient) => sum + recipient.providerChargeAmountMinor, 0),
    };
    const quote = accountPaymentFundingQuoteResponseV4Schema.parse({
      ...unsigned,
      quoteFingerprint: quoteFingerprintV4(unsigned),
    });
    return quote;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

export type AccountPaymentChargeResultV4 = {
  contractVersion: "account-payment-funding-charge/4";
  operationId: string;
  status: PaymentOperation["status"];
  providerPaymentId: string | null;
  payment?: { id: number; bowlerId: number; leagueId: number | null; amount: number; currency: string; createdAt: string; status: string; type: string };
  recipientFunding?: Array<{ bowlerId: number; amountMinor: number }>;
};

function accountReplayMatches(input: {
  snapshot: AccountPaymentOperationExecutionSnapshot;
  operation: PaymentOperation;
  actorUserId: number;
  payerBowlerId: number;
  request: AccountPaymentFundingQuoteRequestV4 & {
    sourceId: string;
    sourceKind: "new_card" | "saved_card" | "wallet";
    storeCard: boolean;
    quoteFingerprint: string;
  };
}): boolean {
  if (input.operation.authorizingUserId !== input.actorUserId
    || input.snapshot.authorizingUserId !== input.actorUserId
    || input.snapshot.payerBowlerId !== input.payerBowlerId
    || input.snapshot.sourceId !== input.request.sourceId
    || input.snapshot.sourceKind !== input.request.sourceKind
    || input.snapshot.storeCard !== input.request.storeCard
    || input.snapshot.quoteFingerprint !== input.request.quoteFingerprint) return false;
  const selections = new Map(input.request.recipients.map((recipient) => [recipient.bowlerId, recipient.selection]));
  if (selections.size !== input.request.recipients.length || selections.size !== input.snapshot.recipientEvidence.length) return false;
  return input.snapshot.recipientEvidence.every((evidence) => {
    const selection = selections.get(evidence.recipientBowlerId);
    return selection !== undefined
      && canonicalizePaymentOperationInput(selection) === canonicalizePaymentOperationInput(evidence.selection);
  });
}

export async function chargeAccountPaymentFundingV4(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  payerBowlerId: number;
  request: AccountPaymentFundingQuoteRequestV4 & {
    sourceId: string;
    sourceKind: "new_card" | "saved_card" | "wallet";
    buyerEmail?: string | null;
    storeCard: boolean;
    idempotencyKey: string;
    quoteFingerprint: string;
  };
}): Promise<AccountPaymentChargeResultV4> {
  assertRequestPayerMatches(input);
  const [league] = await db.select({ id: leagues.id, organizationId: leagues.organizationId, locationId: leagues.locationId })
    .from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
  const provider = await getPaymentProvider(league.locationId);
  let ensuredCustomerId: string | undefined;
  const [existingRequest] = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "interactive_charge"),
    eq(paymentOperations.targetKey, `interactive-charge:${input.request.idempotencyKey}`),
  )).limit(1);
  if (!existingRequest && input.request.storeCard && input.request.sourceKind === "new_card") {
    const [payerForCustomer] = await db.select().from(bowlers).where(and(
      eq(bowlers.id, input.payerBowlerId),
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlers.active, true),
    )).limit(1);
    if (!payerForCustomer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is unavailable", 403);
    if (!payerForCustomer.paymentCustomerId) {
      ensuredCustomerId = await ensureProviderCustomer(provider, payerForCustomer);
      if (ensuredCustomerId && payerForCustomer.paymentCustomerId !== ensuredCustomerId) {
        const [persistedPayer] = await db.select({ paymentCustomerId: bowlers.paymentCustomerId }).from(bowlers).where(and(
          eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId),
        )).limit(1);
        if (persistedPayer?.paymentCustomerId !== ensuredCustomerId) throw new RosterPaymentError("CARD_CUSTOMER_PERSISTENCE_FAILED", "The provider customer could not be saved for this payer", 503);
      }
    }
  }

  const prepared = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [existing] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.targetKey, `interactive-charge:${input.request.idempotencyKey}`),
    )).limit(1).for("update");
    if (existing) {
      const stored = await getAccountPaymentOperationSnapshotInTransaction(tx, existing);
      if (!stored || !accountReplayMatches({ snapshot: stored, operation: existing, actorUserId: input.actorUserId, payerBowlerId: input.payerBowlerId, request: input.request })) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different payment identity or recipient selection", 409);
      }
      return { operation: existing, reused: true };
    }
    const adoption = await readOwnedLedgerAdoptionInTransaction(tx, input);
    if (!adoption) throw new RosterPaymentError("ACCOUNT_PAYMENT_V4_REQUIRED", "This league has not adopted account-based payment", 409);
    const quote = await quoteAccountPaymentFundingV4({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      request: input.request,
      transaction: tx,
    });
    if (quote.quoteFingerprint !== input.request.quoteFingerprint) throw new RosterPaymentError("STALE_QUOTE", "The payment quote is stale; request a new quote", 409);
    if (quote.providerChargeAmountMinor <= 0) throw new RosterPaymentError("ACCOUNT_ALREADY_COVERED", "The selected account targets are already covered by available credit", 409);
    const chargedRecipientIds = quote.recipients
      .filter((recipient) => recipient.providerChargeAmountMinor > 0)
      .map((recipient) => recipient.bowlerId);
    if (await hasUnresolvedAccountFundingOverlapInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      creditedBowlerIds: chargedRecipientIds,
    })) {
      throw new RosterPaymentError("PAYMENT_IN_PROGRESS", "A payment for one of these accounts is still being confirmed", 409);
    }
    const [payer] = await tx.select().from(bowlers).where(and(
      eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true),
    )).limit(1).for("share");
    if (!payer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is unavailable", 403);
    if (ensuredCustomerId && payer.paymentCustomerId !== ensuredCustomerId) throw new RosterPaymentError("CARD_CUSTOMER_PERSISTENCE_FAILED", "The provider customer could not be saved for this payer", 503);
    const buyerEmail = payer.email?.trim() || input.request.buyerEmail?.trim() || null;
    if (!buyerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyerEmail)) throw new RosterPaymentError("BUYER_EMAIL_REQUIRED", "A valid buyer email is required for payment", 422);
    const customerId = ensuredCustomerId ?? getProviderCustomerId(payer, provider);
    if (input.request.sourceKind === "saved_card" && !customerId) throw new RosterPaymentError("SAVED_CARD_CUSTOMER_REQUIRED", "The saved payment method is not available for this payer", 422);
    if (input.request.storeCard && input.request.sourceKind !== "new_card") throw new RosterPaymentError("INVALID_CARD_SAVE_REQUEST", "Only a new card can be saved", 422);
    if (input.request.storeCard && !customerId) throw new RosterPaymentError("CARD_CUSTOMER_REQUIRED", "A provider customer is required to save a card", 422);
    const context = await accountContextInTransaction(tx, input, { lock: false });
    if (context.response.accountingMode !== "confirmed_account_v4") throw new RosterPaymentError("ACCOUNT_PAYMENT_V4_REQUIRED", "This league has not adopted account-based payment", 409);
    const evidence = quote.recipients.map((recipient) => {
      const link = context.partnerLinkById.get(recipient.bowlerId) ?? null;
      return {
        recipientBowlerId: recipient.bowlerId,
        role: recipient.role,
        paymentLinkId: link?.id ?? null,
        linkFingerprint: link?.fingerprint ?? null,
        selection: recipient.selection,
      };
    });
    const fundingPortions: AccountPaymentFundingPortionV4[] = quote.recipients
      .filter((recipient) => recipient.providerChargeAmountMinor > 0)
      .map((recipient, portionIndex) => ({ portionIndex, creditedBowlerId: recipient.bowlerId, amountMinor: recipient.providerChargeAmountMinor }));
    const preparationInput: AccountPaymentOperationPreparationInput = {
      requestKey: input.request.idempotencyKey,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      amountMinor: quote.providerChargeAmountMinor,
      fundingPortions,
      recipientEvidence: evidence,
      currency: quote.currency,
      providerName: provider.providerName,
      locationId: league.locationId,
      providerLocationId: null,
      authorizingUserId: input.actorUserId,
      sourceKind: input.request.sourceKind,
      sourceId: input.request.sourceId,
      customerId: customerId ?? null,
      buyerEmail,
      storeCard: input.request.storeCard,
      quoteFingerprint: quote.quoteFingerprint,
    };
    const operation = await prepareAccountPaymentOperation(preparationInput, tx);
    return { operation, reused: false };
  });

  let executed: PaymentOperation | undefined;
  try {
    executed = await interactivePaymentOperationExecutor.execute({ organizationId: input.organizationId, operationId: prepared.operation.id });
  } finally {
    await paymentOperationRetryExecutor.rearm().catch(() => undefined);
  }
  const operation = executed ?? await getPaymentOperationForOrganization(input.organizationId, prepared.operation.id) ?? prepared.operation;
  if (operation.status !== "succeeded") {
    return { contractVersion: "account-payment-funding-charge/4", operationId: operation.id, status: operation.status, providerPaymentId: operation.providerObjectId };
  }
  const [payment] = await db.select().from(payments).where(and(
    eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId), eq(payments.paymentOperationId, operation.id),
  )).limit(1);
  const stored = await getAccountPaymentOperationSnapshotForOrganization(input.organizationId, operation.id);
  if (!payment || !stored || payment.amount !== operation.amountMinor) {
    return { contractVersion: "account-payment-funding-charge/4", operationId: operation.id, status: "reconciliation_required", providerPaymentId: operation.providerObjectId };
  }
  return {
    contractVersion: "account-payment-funding-charge/4",
    operationId: operation.id,
    status: operation.status,
    providerPaymentId: operation.providerObjectId,
    payment: {
      id: payment.id,
      bowlerId: payment.bowlerId,
      leagueId: payment.leagueId,
      amount: payment.amount,
      currency: payment.currency,
      createdAt: payment.createdAt,
      status: payment.status,
      type: payment.type,
    },
    recipientFunding: stored.fundingPortions.map(({ creditedBowlerId, amountMinor }) => ({ bowlerId: creditedBowlerId, amountMinor })),
  };
}
