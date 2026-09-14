import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import {
  bowlers,
  bowlerLeagues,
  bowlerPaymentLinks,
  leagues,
  paymentAllocations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  payments,
  occurrencePaymentResponsibilities,
  type PaymentOperation,
} from "@shared/schema";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { fifoCandidatesInTransaction, allocateAutomaticFifoPayment, RosterPaymentError, type RosterPaymentTransaction } from "./roster-payment-core.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { prepareInteractivePartnerPaymentOperation } from "./interactive-payment-operation-preparation.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { paymentOperationRetryExecutor } from "./payment-operation-retry-executor.js";
import { decrypt } from "../utils/crypto.js";
import { createLogger } from "../logger.js";
import type { InteractivePaymentRecipientSelectionV3, InteractivePaymentParticipantsResponseV3, InteractivePaymentQuoteAllocationV3, InteractivePaymentQuoteRecipientV3 } from "@shared/interactive-payment-v3-contract";
import type { InteractivePartnerPaymentEvidence } from "./interactive-partner-payment-snapshot.js";
import { buildOneTimePaymentOptions } from "@shared/one-time-payment-options";

type Link = typeof bowlerPaymentLinks.$inferSelect;
const log = createLogger("InteractivePartnerPayment");

function partnerLinkFingerprint(link: Pick<Link, "id" | "bowlerAId" | "bowlerBId" | "organizationId" | "status" | "respondedAt">): string {
  return `lvpartnerlink:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  })).digest("hex")}`;
}

/** PostgreSQL's `timestamp::text` uses a space separator. Normalize it before
 * comparing with the ISO trigger timestamps used by FIFO collection groups;
 * malformed database evidence must fail closed instead of using app time. */
export function normalizeInteractivePaymentTransactionTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The transaction timestamp evidence is missing", 503);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The transaction timestamp evidence is invalid", 503);
  }
  return parsed.toISOString();
}

function nowFromTransaction(rows: unknown): string {
  const row = (rows as { rows?: Array<{ now?: string }> })?.rows?.[0];
  return normalizeInteractivePaymentTransactionTimestamp(row?.now);
}

async function activePayer(tx: RosterPaymentTransaction, organizationId: number, leagueId: number, bowlerId: number): Promise<{ id: number; name: string; email: string | null } | undefined> {
  const [row] = await tx.select({ id: bowlers.id, name: bowlers.name, email: bowlers.email }).from(bowlers).innerJoin(bowlerLeagues, and(
    eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true),
  )).where(and(eq(bowlers.id, bowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true))).limit(1).for("share");
  return row;
}

async function resolveParticipantsInTransaction(tx: RosterPaymentTransaction, input: { organizationId: number; leagueId: number; payerBowlerId: number; now: string }) {
  const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).for("share");
  if (!league) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
  const payer = await activePayer(tx, input.organizationId, input.leagueId, input.payerBowlerId);
  if (!payer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is not an active member of this league", 403);
  // The league lock is acquired before this link lock. unlink uses the same
  // order, making accepted-link evidence a real prepare/unlink boundary.
  const links = await tx.select().from(bowlerPaymentLinks).where(and(
    eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"),
    or(eq(bowlerPaymentLinks.bowlerAId, input.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, input.payerBowlerId)),
  )).orderBy(asc(bowlerPaymentLinks.id)).for("update");
  const byPartner = new Map<number, Link>();
  for (const link of links) byPartner.set(link.bowlerAId === input.payerBowlerId ? link.bowlerBId : link.bowlerAId, link);
  const ids = [input.payerBowlerId, ...byPartner.keys()];
  const members = ids.length === 0 ? [] : await tx.select({ id: bowlers.id, name: bowlers.name, email: bowlers.email }).from(bowlers).innerJoin(bowlerLeagues, and(
    eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true),
  )).where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true), inArray(bowlers.id, ids))).orderBy(asc(bowlers.id)).for("share");
  const result = [];
  for (const member of members) {
    const candidates = await fifoCandidatesInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: member.id, now: input.now });
    const payableCandidates = candidates.filter((row) => row.outstandingMinor > 0);
    const remainingMinor = payableCandidates.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const payableOccurrenceCount = new Set(payableCandidates.map((row) => row.occurrenceId)).size;
    const pastDueMinor = candidates.filter((row) => new Date(row.pastDueAt).getTime() <= new Date(input.now).getTime()).reduce((sum, row) => sum + row.outstandingMinor, 0);
    const link = byPartner.get(member.id);
    result.push({
      bowlerId: member.id, name: member.name, role: member.id === input.payerBowlerId ? "self" as const : "partner" as const,
      remainingMinor, pastDueMinor,
      weeklyOptions: league.paymentMode === "upfront"
        ? (remainingMinor > 0 ? [{ weeks: Math.max(1, payableOccurrenceCount), amountMinor: remainingMinor }] : [])
        : buildOneTimePaymentOptions(candidates, remainingMinor).map((option) => ({ weeks: option.weekCount, amountMinor: option.amountMinor })),
      eligible: remainingMinor > 0,
      reason: remainingMinor > 0 ? null : "No remaining balance",
      candidates,
      link,
    });
  }
  return { league, payer, participants: result, byPartner };
}

export async function readInteractivePaymentParticipants(input: { organizationId: number; leagueId: number; payerBowlerId: number }): Promise<InteractivePaymentParticipantsResponseV3> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const nowResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const now = nowFromTransaction(nowResult);
    const resolved = await resolveParticipantsInTransaction(tx, { ...input, now });
    return {
      contractVersion: "interactive-payment-participants/3",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentMode: resolved.league.paymentMode,
      participants: resolved.participants.map(({ candidates: _candidates, link: _link, ...participant }) => participant),
    };
  });
}

function selectionsMatch(a: InteractivePaymentRecipientSelectionV3[], b: InteractivePaymentRecipientSelectionV3[]): boolean {
  const normalize = (rows: InteractivePaymentRecipientSelectionV3[]) => [...rows].sort((x, y) => x.bowlerId - y.bowlerId).map((row) => ({ bowlerId: row.bowlerId, weeks: row.weeks, fullBalance: row.fullBalance }));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export async function quoteInteractivePartnerPayments(input: { organizationId: number; leagueId: number; payerBowlerId: number; recipients: InteractivePaymentRecipientSelectionV3[]; transaction?: RosterPaymentTransaction }) {
  const run = async (tx: RosterPaymentTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const nowResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const now = nowFromTransaction(nowResult);
    const resolved = await resolveParticipantsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, now });
    const selectedIds = new Set(input.recipients.map((row) => row.bowlerId));
    if (selectedIds.size !== input.recipients.length) throw new RosterPaymentError("INVALID_RECIPIENT_SELECTION", "Each recipient may be selected only once", 422);
    const responsibilityIds = [...new Set(resolved.participants.flatMap((row) => row.candidates.map((candidate) => candidate.responsibilityId)))];
    const responsibilityRows = responsibilityIds.length === 0 ? [] : await tx.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId), eq(occurrencePaymentResponsibilities.leagueId, input.leagueId), eq(occurrencePaymentResponsibilities.state, "active"), inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
    )).for("share");
    const responsibilityVersionById = new Map(responsibilityRows.map((row) => [row.id, row.version]));
    const recipientRows: InteractivePaymentQuoteRecipientV3[] = [];
    const allAllocations: Array<{ allocationIndex: number; bowlerId: number; amountMinor: number; notes: string | null; paidByUserId: number | null; obligationId: string; responsibilityId: string; responsibilityVersion: number }> = [];
    const evidence: InteractivePartnerPaymentEvidence[] = [];
    let amountMinor = 0;
    for (const selection of [...input.recipients].sort((a, b) => a.bowlerId - b.bowlerId)) {
      const participant = resolved.participants.find((row) => row.bowlerId === selection.bowlerId);
      if (!participant) throw new RosterPaymentError("PARTNER_AUTHORIZATION_REQUIRED", "The selected recipient is not an active direct payment partner in this league", 403);
      const payableCandidates = participant.candidates.filter((row) => row.outstandingMinor > 0);
      const payableOccurrenceCount = new Set(payableCandidates.map((row) => row.occurrenceId)).size;
      if (payableCandidates.length === 0) throw new RosterPaymentError("NO_ELIGIBLE_OBLIGATIONS", "The selected recipient has no remaining payable balance", 422);
      if (resolved.league.paymentMode === "upfront" && !selection.fullBalance) throw new RosterPaymentError("UPFRONT_FULL_BALANCE_REQUIRED", "Upfront checkout must collect each selected recipient's full remaining balance", 422);
      const options = buildOneTimePaymentOptions(participant.candidates, participant.candidates.reduce((sum, row) => sum + row.outstandingMinor, 0));
      if (resolved.league.paymentMode === "upfront" && selection.weeks !== payableOccurrenceCount) throw new RosterPaymentError("FULL_BALANCE_SELECTION_INVALID", "The full-balance selection is stale", 409);
      const selectedOption = selection.fullBalance ? undefined : options.find((option) => option.weekCount === selection.weeks);
      const subtotal = selection.fullBalance ? participant.candidates.reduce((sum, row) => sum + row.outstandingMinor, 0) : selectedOption?.amountMinor ?? 0;
      if (selection.fullBalance && subtotal <= 0) throw new RosterPaymentError("FULL_BALANCE_SELECTION_INVALID", "The full-balance selection is stale", 409);
      if (selection.fullBalance && resolved.league.paymentMode === "weekly" && selection.weeks !== options.at(-1)?.weekCount) throw new RosterPaymentError("FULL_BALANCE_SELECTION_INVALID", "The full-balance selection is stale", 409);
      if (!selection.fullBalance && !selectedOption) throw new RosterPaymentError("WEEKS_SELECTION_INVALID", "The selected weeks exceed the recipient's payable balance", 409);
      // Always pass the complete recipient candidate set to FIFO. A scheduled
      // weekly amount can exceed an already-partially-settled oldest week and
      // must spill into the next oldest occurrence.
      const allocations = allocateAutomaticFifoPayment(subtotal, participant.candidates, resolved.league.paymentMode, now);
      const byId = new Map(participant.candidates.map((row) => [row.id, row]));
      const rows = allocations.map((allocation) => {
        const candidate = byId.get(allocation.obligationId);
        if (!candidate) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The FIFO allocation references missing obligation evidence", 503);
        return { ...allocation, candidate };
      });
      const link = participant.link;
      evidence.push({ recipientBowlerId: participant.bowlerId, role: participant.role, paymentLinkId: link?.id ?? null, linkFingerprint: link ? partnerLinkFingerprint(link) : null, selectedWeeks: selection.weeks, fullBalance: selection.fullBalance });
      const projectedAllocations: InteractivePaymentQuoteAllocationV3[] = rows.map((row) => {
        const occurrenceLocalDate = row.candidate.occurrenceLocalDate;
        if (!occurrenceLocalDate) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The FIFO allocation is missing its authoritative occurrence date", 503);
        return {
          obligationId: row.obligationId,
          amountMinor: row.amountMinor,
          occurrenceId: row.candidate.occurrenceId,
          occurrenceLocalDate,
          plannedOrdinal: row.candidate.plannedOrdinal ?? null,
          label: row.candidate.plannedOrdinal !== null && row.candidate.plannedOrdinal !== undefined
            ? `Week ${row.candidate.plannedOrdinal}`
            : `Week of ${occurrenceLocalDate}`,
        };
      });
      recipientRows.push({ bowlerId: participant.bowlerId, name: participant.name, role: participant.role, weeks: selection.weeks, fullBalance: selection.fullBalance, subtotalMinor: subtotal, allocations: projectedAllocations, coveredWeeks: projectedAllocations.map((allocation) => allocation.label) });
      for (const row of rows) {
        const candidate = byId.get(row.obligationId);
        if (!candidate) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The FIFO allocation references missing obligation evidence", 503);
        const responsibilityVersion = responsibilityVersionById.get(candidate.responsibilityId);
        if (responsibilityVersion === undefined) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The roster responsibility evidence is unavailable", 503);
        allAllocations.push({ allocationIndex: allAllocations.length, bowlerId: participant.bowlerId, amountMinor: row.amountMinor, notes: `Roster obligation ${row.obligationId}`, paidByUserId: null, obligationId: row.obligationId, responsibilityId: candidate.responsibilityId, responsibilityVersion });
      }
      amountMinor += subtotal;
    }
    if (amountMinor <= 0 || allAllocations.length === 0) throw new RosterPaymentError("NO_ELIGIBLE_OBLIGATIONS", "No eligible payment obligations remain", 422);
    const fingerprintInput = { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, recipients: evidence, allocations: allAllocations.map(({ allocationIndex, bowlerId, amountMinor: value, obligationId, responsibilityId, responsibilityVersion }) => ({ allocationIndex, bowlerId, amountMinor: value, obligationId, responsibilityId, responsibilityVersion })) };
    const fingerprint = `lvpartnerquote:v3:${createHash("sha256").update(canonicalizePaymentOperationInput(fingerprintInput)).digest("hex")}`;
    return { contractVersion: "interactive-payment-quote/3" as const, organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, currency: "USD" as const, amountMinor, recipients: recipientRows, allocations: allAllocations, partnerEvidence: evidence, fingerprint };
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

export async function chargeInteractivePartnerPayments(input: {
  organizationId: number; leagueId: number; actorUserId: number; payerBowlerId: number;
  request: { recipients: InteractivePaymentRecipientSelectionV3[]; sourceId: string; sourceKind: "new_card" | "saved_card" | "wallet"; buyerEmail?: string | null; storeCard?: boolean; idempotencyKey: string; requestFingerprint: string };
}) {
  const [league] = await db.select({ id: leagues.id, organizationId: leagues.organizationId, locationId: leagues.locationId }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
  const provider = await getPaymentProvider(league.locationId);
  const prepared = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "interactive_charge"), eq(paymentOperations.targetKey, `interactive-charge:${input.request.idempotencyKey}`))).limit(1).for("update");
    if (existing) {
      if (existing.authorizingUserId !== input.actorUserId) throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to another authorizing user", 409);
      const [stored] = await tx.select().from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.operationId, existing.id), eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId), eq(paymentOperationRosterSnapshots.snapshotKind, "interactive"))).limit(1).for("share");
      const sourceId = stored?.encryptedSourceId ? decrypt(stored.encryptedSourceId) : null;
      const storedEvidence = Array.isArray(stored?.partnerEvidence) ? stored.partnerEvidence : [];
      const selections = storedEvidence.flatMap((row) => typeof row === "object" && row !== null && "recipientBowlerId" in row && "selectedWeeks" in row && "fullBalance" in row ? [{ bowlerId: Number(row.recipientBowlerId), weeks: Number(row.selectedWeeks), fullBalance: row.fullBalance === true }] : []);
      if (!stored || stored.snapshotVersion !== 3 || stored.payerBowlerId !== input.payerBowlerId || sourceId !== input.request.sourceId || stored.sourceKind !== input.request.sourceKind || stored.storeCard !== (input.request.storeCard === true) || stored.quoteFingerprint !== input.request.requestFingerprint || !selectionsMatch(selections, input.request.recipients)) throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different payment identity or recipient selection", 409);
      return { operation: existing, reused: true };
    }
    const quote = await quoteInteractivePartnerPayments({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, recipients: input.request.recipients, transaction: tx });
    if (quote.fingerprint !== input.request.requestFingerprint) throw new RosterPaymentError("STALE_QUOTE", "The payment quote is stale; request a new quote", 409);
    const [payer] = await tx.select().from(bowlers).where(and(eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1).for("share");
    if (!payer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is unavailable", 403);
    const buyerEmail = (payer.email?.trim() || input.request.buyerEmail?.trim() || null);
    if (!buyerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyerEmail)) throw new RosterPaymentError("BUYER_EMAIL_REQUIRED", "A valid buyer email is required for Square payments", 422);
    const customerId = getProviderCustomerId(payer, provider);
    if (input.request.sourceKind === "saved_card" && !customerId) throw new RosterPaymentError("SAVED_CARD_CUSTOMER_REQUIRED", "The saved payment method is not available for this payer", 422);
    if (input.request.storeCard === true && input.request.sourceKind !== "new_card") throw new RosterPaymentError("INVALID_CARD_SAVE_REQUEST", "Only a new card can be saved", 422);
    if (input.request.storeCard === true && !customerId) throw new RosterPaymentError("CARD_CUSTOMER_REQUIRED", "A provider customer is required to save a card", 422);
    const responsibilityIds = [...new Set(quote.allocations.map((row) => row.responsibilityId))];
    // The quote already locks each obligation. Re-read authoritative versions
    // through the existing v2 preparation path's finalizer checks by carrying
    // the current version from a responsibility query below.
    const currentVersions = await tx.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId), eq(occurrencePaymentResponsibilities.leagueId, input.leagueId), eq(occurrencePaymentResponsibilities.state, "active"), inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
    )).for("share");
    const versionById = new Map(currentVersions.map((row) => [row.id, Number(row.version)]));
    if (responsibilityIds.some((id) => !versionById.has(id))) throw new RosterPaymentError("RESERVATION_STALE", "A roster responsibility changed while the quote was being prepared", 409);
    const operation = await prepareInteractivePartnerPaymentOperation({ organizationId: input.organizationId, authorizingUserId: input.actorUserId, requestKey: input.request.idempotencyKey, amountMinor: quote.amountMinor, currency: quote.currency, providerName: provider.providerName, leagueId: input.leagueId, locationId: league.locationId, providerLocationId: null, payerBowlerId: input.payerBowlerId, sourceId: input.request.sourceId, customerId: customerId ?? null, buyerEmail, storeCard: input.request.storeCard === true, sourceKind: input.request.sourceKind, allocations: quote.allocations.map((row) => ({ ...row, paidByUserId: input.actorUserId, responsibilityVersion: versionById.get(row.responsibilityId) ?? 0 })), partnerEvidence: quote.partnerEvidence, quoteFingerprint: quote.fingerprint, transaction: tx });
    await tx.insert(paymentOperationRosterSnapshotItems).values(quote.allocations.map((row) => ({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: row.obligationId, allocationIndex: row.allocationIndex, amountMinor: row.amountMinor, state: "reserved" as const })));
    return { operation, reused: false };
  });
  let executed: Awaited<ReturnType<typeof interactivePaymentOperationExecutor.execute>>;
  try { executed = await interactivePaymentOperationExecutor.execute({ organizationId: input.organizationId, operationId: prepared.operation.id }); }
  finally {
    await paymentOperationRetryExecutor.rearm().catch((error: unknown) => {
      log.error("Payment operation retry scheduler rearm failed after partner checkout", {
        organizationId: input.organizationId,
        operationId: prepared.operation.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
  if (!executed || executed.status !== "succeeded") {
    if (executed && ["failed_terminal", "action_required", "canceled"].includes(executed.status)) await db.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(eq(paymentOperationRosterSnapshotItems.operationId, prepared.operation.id), eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
    return { contractVersion: "interactive-payment-charge/3" as const, operationId: prepared.operation.id, status: executed?.status ?? prepared.operation.status, providerPaymentId: executed?.providerObjectId ?? null };
  }
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.id, prepared.operation.id), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId))).limit(1).for("share");
    if (!operation) throw new RosterPaymentError("NOT_FOUND", "The payment operation is unavailable", 404);
    const [payment] = await tx.select().from(payments).where(and(eq(payments.leagueId, input.leagueId), eq(payments.paymentOperationId, operation.id))).limit(1).for("share");
    const allocations = payment ? await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active"))).for("share") : [];
    if (operation.status === "reconciliation_required") return { contractVersion: "interactive-payment-charge/3" as const, operationId: operation.id, status: operation.status, providerPaymentId: operation.providerObjectId };
    if (!payment || payment.amount !== operation.amountMinor) throw new RosterPaymentError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete", 409);
    return { contractVersion: "interactive-payment-charge/3" as const, operationId: operation.id, status: operation.status, providerPaymentId: operation.providerObjectId, payment, allocations, records: allocations.map((allocation) => ({ payment, allocation })) };
  });
}
