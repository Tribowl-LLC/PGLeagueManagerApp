import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerLeagues,
  bowlerPaymentLinks,
  bowlers,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  financialCommands,
  leagueOccurrences,
  leagues,
  occurrencePaymentResponsibilities,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  teams,
  users,
  type PaymentOperation,
} from "@shared/schema";
import type {
  StandingAutopayConsentRequest,
  StandingAutopayQuoteWire,
  StandingAutopayRevokeRequest,
} from "@shared/standing-autopay-contract";
import { buildPaymentOperationIdentity, canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { db } from "../db.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { rosterStandingAutopayEnabled, scheduledPaymentExecutionMode } from "../config.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { validateRosterSnapshotForDispatchInTransaction } from "./roster-payment-finalizer.js";

const CONSENT_FP_PREFIX = "lvstandingconsent:v1:";
const PARTNER_FP_PREFIX = "lvpartnerlink:v1:";
const CUTOFF_FP_PREFIX = "lvstandingcutoff:v1:";
const COMMAND_CONSENT = "standing_autopay_consent";
const COMMAND_REVOKE = "standing_autopay_revoke";
const COMMAND_CUTOFF = "standing_autopay_cutoff";
let rearmStandingAutopayWake: () => Promise<void> = async () => undefined;

export function configureStandingAutopayRuntime(input: { rearm: () => Promise<void> }): void {
  rearmStandingAutopayWake = input.rearm;
}

async function notifyStandingAutopayMutation(): Promise<void> {
  await rearmStandingAutopayWake();
}

export class StandingAutopayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "StandingAutopayError";
  }
}

export class StandingAutopayReplay extends StandingAutopayError {
  constructor(public readonly result: unknown) {
    super("IDEMPOTENCY_REPLAY", "The standing automatic-payment command was already applied", 200);
  }
}

type StandingTx = PaymentOperationTransaction;

function digest(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex")}`;
}

function iso(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StandingAutopayError("INVALID_TIMESTAMP", "The standing cutoff timestamp is invalid", 422);
  return parsed.toISOString();
}

async function beginCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; actorUserId: number; commandType: string; key: string; fingerprint: string },
): Promise<void> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  )).limit(1).for("update");
  if (existing) {
    if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== input.fingerprint) {
      throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
    }
    if (existing.state === "applied" && existing.result !== null) throw new StandingAutopayReplay(existing.result);
    if (existing.state === "failed") throw new StandingAutopayError(existing.errorCode ?? "COMMAND_FAILED", "The standing command previously failed");
    return;
  }
  await tx.insert(financialCommands).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: input.commandType,
    idempotencyKey: input.key,
    requestFingerprint: input.fingerprint,
    state: "accepted",
  });
}

async function applyCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; commandType: string; key: string; result: unknown },
): Promise<void> {
  await tx.update(financialCommands).set({ state: "applied", result: input.result }).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  ));
}

async function leagueFor(tx: StandingTx, organizationId: number, leagueId: number) {
  const [league] = await tx.select().from(leagues).where(and(eq(leagues.organizationId, organizationId), eq(leagues.id, leagueId))).limit(1);
  if (!league) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.payingLineupSize === null) throw new StandingAutopayError("ROSTER_PAYMENTS_REQUIRED", "Standing automatic payments require a roster-configured league");
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are weekly only for upfront leagues", 422);
  return league;
}

async function activeMembership(tx: StandingTx, organizationId: number, leagueId: number, bowlerIds: number[]): Promise<boolean> {
  if (bowlerIds.length === 0) return false;
  const rows = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(
    eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true),
  )).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, bowlerIds)));
  return new Set(rows.map((row) => row.bowlerId)).size === new Set(bowlerIds).size;
}

function linkFingerprint(link: Pick<typeof bowlerPaymentLinks.$inferSelect, "id" | "bowlerAId" | "bowlerBId" | "organizationId" | "status" | "respondedAt">): string {
  return digest(PARTNER_FP_PREFIX, {
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  });
}

async function consentPartners(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId: string; consentVersion: number; payerBowlerId: number }): Promise<Array<typeof autopayConsentPartners.$inferSelect>> {
  const rows = await tx.select({ evidence: autopayConsentPartners, link: bowlerPaymentLinks }).from(autopayConsentPartners).innerJoin(bowlerPaymentLinks, and(
    eq(bowlerPaymentLinks.id, autopayConsentPartners.paymentLinkId), eq(bowlerPaymentLinks.organizationId, input.organizationId),
  )).where(and(
    eq(autopayConsentPartners.organizationId, input.organizationId), eq(autopayConsentPartners.leagueId, input.leagueId),
    eq(autopayConsentPartners.consentId, input.consentId), eq(autopayConsentPartners.consentVersion, input.consentVersion),
  )).orderBy(asc(autopayConsentPartners.partnerBowlerId)).for("update");
  for (const row of rows) {
    if (row.link.status !== "accepted" || row.evidence.linkFingerprint !== linkFingerprint(row.link)) throw new StandingAutopayError("PARTNER_AUTHORIZATION_CHANGED", "An accepted payment partner authorization changed");
    if (![row.link.bowlerAId, row.link.bowlerBId].includes(input.payerBowlerId) || ![row.link.bowlerAId, row.link.bowlerBId].includes(row.evidence.partnerBowlerId) || row.link.bowlerAId === row.link.bowlerBId) throw new StandingAutopayError("PARTNER_AUTHORIZATION_INVALID", "The standing partner authorization is invalid");
  }
  return rows.map((row) => row.evidence);
}

async function activeConsent(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId?: string; payerBowlerId?: number }) {
  const conditions = [eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.state, "active" as const)];
  if (input.consentId) conditions.push(eq(autopayConsents.id, input.consentId));
  if (input.payerBowlerId) conditions.push(eq(autopayConsents.payerBowlerId, input.payerBowlerId));
  const [consent] = await tx.select().from(autopayConsents).where(and(...conditions)).limit(1).for("update");
  if (!consent) return undefined;
  if (consent.paymentMode !== "weekly" || !consent.providerName || !consent.providerLocationId || !consent.encryptedSourceId || !consent.encryptedCustomerId || consent.revokedAt !== null) throw new StandingAutopayError("CONSENT_INVALID", "The standing consent is not dispatchable");
  return consent;
}

async function eligibleRows(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; cutoffAt: string },
): Promise<Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number }>> {
  const obligations = await tx.select({ obligation: paymentObligations })
    .from(paymentObligations)
    .innerJoin(occurrencePaymentResponsibilities, and(
      eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ))
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
      inArray(paymentObligations.state, ["open", "partially_settled"] as const),
      lte(paymentObligations.dueAt, input.cutoffAt),
    )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  const result: Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number }> = [];
  for (const row of obligations) {
    const [allocated] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, row.obligation.id), eq(paymentAllocations.state, "active"),
    ));
    const [reserved] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentOperationRosterSnapshotItems.amountMinor}), 0)` }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.obligationId, row.obligation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    ));
    const outstandingMinor = row.obligation.amountMinor - Number(allocated?.total ?? 0) - Number(reserved?.total ?? 0);
    if (outstandingMinor > 0) result.push({ obligation: row.obligation, outstandingMinor });
  }
  return result;
}

async function groupForCutoff(tx: StandingTx, input: { organizationId: number; leagueId: number; cutoffAt: string; obligations: Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number }> }): Promise<{ mode: "weekly" | "double_pay"; groupId: string | null; occurrenceIds: string[] }> {
  const occurrenceIds = [...new Set(input.obligations.map((row) => row.obligation.occurrenceId))];
  const groups = await tx.select({ group: canonicalCollectionGroups, member: canonicalCollectionGroupMembers }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
    eq(canonicalCollectionGroupMembers.groupId, canonicalCollectionGroups.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true),
  )).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.state, "published"), inArray(canonicalCollectionGroupMembers.occurrenceId, occurrenceIds))).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroupMembers.memberOrdinal)).for("share");
  const trigger = groups.find((row) => row.member.role === "trigger" && occurrenceIds.includes(row.member.occurrenceId));
  if (!trigger) return { mode: "weekly", groupId: null, occurrenceIds };
  const members = groups.filter((row) => row.group.id === trigger.group.id).map((row) => row.member.occurrenceId);
  const pairIds = [...new Set(members)];
  return { mode: "double_pay", groupId: trigger.group.id, occurrenceIds: pairIds };
}

async function addPairedRows(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; cutoffAt: string; groupId: string; existing: Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number }> },
): Promise<Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number }>> {
  const members = await tx.select({ occurrenceId: canonicalCollectionGroupMembers.occurrenceId }).from(canonicalCollectionGroupMembers).where(and(
    eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.groupId, input.groupId), eq(canonicalCollectionGroupMembers.active, true),
  )).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal));
  const missing = members.map((row) => row.occurrenceId).filter((id) => !input.existing.some((row) => row.obligation.occurrenceId === id));
  if (missing.length === 0) return input.existing;
  const paired = await tx.select({ obligation: paymentObligations }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.occurrenceId, missing), inArray(paymentObligations.payerBowlerId, input.payerBowlerIds), inArray(paymentObligations.state, ["open", "partially_settled"] as const),
  )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  const result = [...input.existing];
  for (const row of paired) {
    const [allocated] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, row.obligation.id), eq(paymentAllocations.state, "active")));
    const [reserved] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentOperationRosterSnapshotItems.amountMinor}), 0)` }).from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.obligationId, row.obligation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
    const outstandingMinor = row.obligation.amountMinor - Number(allocated?.total ?? 0) - Number(reserved?.total ?? 0);
    if (outstandingMinor > 0) result.push({ obligation: row.obligation, outstandingMinor });
  }
  return result.sort((a, b) => a.obligation.dueAt.localeCompare(b.obligation.dueAt) || a.obligation.payerBowlerId - b.obligation.payerBowlerId || a.obligation.id.localeCompare(b.obligation.id));
}

function consentWire(consent: typeof autopayConsents.$inferSelect | undefined, partners: number[], organizationId: number, leagueId: number, payerBowlerId: number) {
  return {
    contractVersion: "standing-autopay-consent/1" as const,
    organizationId, leagueId, payerBowlerId,
    consentId: consent?.id ?? null,
    consentVersion: consent?.consentVersion ?? null,
    state: consent?.state ?? "none",
    paymentMode: "weekly" as const,
    providerName: consent?.providerName ?? null,
    providerLocationId: consent?.providerLocationId ?? null,
    partnerBowlerIds: partners,
  };
}

export async function readStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") {
    return consentWire(undefined, [], input.organizationId, input.leagueId, input.payerBowlerId);
  }
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, input);
    const partners = consent ? await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId }) : [];
    return consentWire(consent, partners.map((row) => row.partnerBowlerId), input.organizationId, input.leagueId, input.payerBowlerId);
  });
}

export async function activateStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayConsentRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const league = await db.select({ locationId: leagues.locationId, paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).then((rows) => rows[0]);
  if (!league || league.locationId === null) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are disabled for upfront leagues", 422);
  const [payer] = await db.select().from(bowlers).where(and(eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
  const customerId = payer?.paymentCustomerId ?? null;
  if (!payer || !customerId || (input.request.customerId !== undefined && payer.paymentCustomerId !== input.request.customerId)) throw new StandingAutopayError("PAYMENT_CUSTOMER_MISMATCH", "The payment method belongs to another payer", 403);
  const provider = await getPaymentProvider(league.locationId);
  if (provider.providerName !== input.request.providerName || String(provider.locationId) !== input.request.providerLocationId || !provider.validateCardId(input.request.sourceId) || !provider.hasCardOnFile) throw new StandingAutopayError("PAYMENT_METHOD_INVALID", "The saved payment method is unavailable", 422);
  if (!(await provider.hasCardOnFile(customerId, input.request.sourceId))) throw new StandingAutopayError("PAYMENT_METHOD_NOT_OWNED", "The saved payment method is unavailable", 403);
  const partnerIds = [...new Set(input.request.partnerBowlerIds)].filter((id) => id !== input.payerBowlerId).sort((a, b) => a - b);
  const commandFingerprint = digest("lvstandingcommand:v1:", { leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, sourceId: input.request.sourceId, customerId, providerName: input.request.providerName, providerLocationId: input.request.providerLocationId, partnerIds });
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_CONSENT, key: input.request.commandKey, fingerprint: commandFingerprint });
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, [input.payerBowlerId, ...partnerIds]))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "Every standing payer must be an active league member", 403);
    const links = partnerIds.length === 0 ? [] : await tx.select().from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(...partnerIds.map((id) => or(and(eq(bowlerPaymentLinks.bowlerAId, input.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, id)), and(eq(bowlerPaymentLinks.bowlerAId, id), eq(bowlerPaymentLinks.bowlerBId, input.payerBowlerId))))))).for("update");
    if (links.length !== partnerIds.length) throw new StandingAutopayError("PARTNER_AUTHORIZATION_REQUIRED", "Every selected partner must have an accepted same-tenant payment link", 403);
    const consentFingerprint = digest(CONSENT_FP_PREFIX, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, paymentMode: "weekly", providerName: input.request.providerName, providerLocationId: input.request.providerLocationId, sourceId: input.request.sourceId, customerId, partners: links.map((link) => ({ bowlerAId: link.bowlerAId, bowlerBId: link.bowlerBId, id: link.id, fingerprint: linkFingerprint(link) })) });
    const [existing] = await tx.select().from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId), eq(autopayConsents.state, "active"))).limit(1).for("update");
    const nextVersion = (await tx.select({ max: sql<number>`COALESCE(MAX(${autopayConsents.consentVersion}), 0)` }).from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId))))[0]?.max ?? 0;
    if (existing) await tx.update(autopayConsents).set({ state: "revoked", revokedAt: new Date().toISOString() }).where(and(eq(autopayConsents.id, existing.id), eq(autopayConsents.state, "active")));
    const [consent] = await tx.insert(autopayConsents).values({
      organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, consentVersion: Number(nextVersion) + 1, state: "active", paymentMode: "weekly", consentFingerprint,
      providerName: input.request.providerName, providerLocationId: input.request.providerLocationId, encryptedSourceId: encrypt(input.request.sourceId), encryptedCustomerId: encrypt(customerId), createdByUserId: input.actorUserId,
    }).returning();
    if (!consent) throw new StandingAutopayError("CONSENT_WRITE_FAILED", "The standing consent could not be saved", 500);
    if (links.length > 0) await tx.insert(autopayConsentPartners).values(links.map((link) => ({ organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId: link.bowlerAId === input.payerBowlerId ? link.bowlerBId : link.bowlerAId, paymentLinkId: link.id, linkFingerprint: linkFingerprint(link) })));
    const result = consentWire(consent, partnerIds, input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CONSENT, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function revokeStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayRevokeRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const fingerprint = digest("lvstandingrevoke:v1:", { leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_REVOKE, key: input.request.commandKey, fingerprint });
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    if (consent) {
      const revokedAt = new Date().toISOString();
      const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id)).where(and(
        eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "standing_autopay_charge"), eq(paymentOperationStandingAutopayBindings.consentId, consent.id), eq(paymentOperationStandingAutopayBindings.consentVersion, consent.consentVersion),
      )).for("update");
      await tx.update(autopayConsents).set({ state: "revoked", revokedAt }).where(and(eq(autopayConsents.id, consent.id), eq(autopayConsents.state, "active")));
      for (const { operation } of operations) {
        if (["pending", "leased", "retry_scheduled"].includes(operation.status) && operation.dispatchClaimedAt === null && operation.providerObjectId === null) {
          await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.operationId, operation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
          await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, dispatchClaimedAt: null, errorClassification: "invalid_request", errorCode: "CONSENT_REVOKED_BEFORE_DISPATCH", updatedAt: revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
        } else if (["leased", "provider_unknown", "retry_scheduled", "pending"].includes(operation.status) && (operation.dispatchClaimedAt !== null || operation.providerObjectId !== null)) {
          await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "CONSENT_REVOKED_AFTER_DISPATCH", updatedAt: revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
        }
      }
    }
    const result = consentWire(consent ? { ...consent, state: "revoked" as const, revokedAt: new Date().toISOString() } : undefined, [], input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_REVOKE, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function quoteStandingAutopay(input: { organizationId: number; leagueId: number; payerBowlerId: number }): Promise<StandingAutopayQuoteWire> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const league = await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    if (!consent) throw new StandingAutopayError("CONSENT_NOT_ACTIVE", "Standing automatic payments are not active", 404);
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId });
    const payerIds = [input.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "The standing payer is not an active league member", 403);
    const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (timestampResult.rows[0] as { as_of?: string } | undefined)?.as_of;
    if (!asOf) throw new StandingAutopayError("QUOTE_TIME_UNAVAILABLE", "The standing quote could not establish a database timestamp", 503);
    const rows = await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, cutoffAt: new Date(asOf).toISOString() });
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const cutoffAt = rows[0]?.obligation.dueAt ?? null;
    const group = cutoffAt ? await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt, obligations: rows }) : { mode: "weekly" as const, groupId: null, occurrenceIds: [] };
    const result = { contractVersion: "standing-autopay-quote/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, collectionMode: rows.length ? group.mode : null, amountMinor, obligations: rows.map((row) => ({ obligationId: row.obligation.id, occurrenceId: row.obligation.occurrenceId, payerBowlerId: row.obligation.payerBowlerId, amountMinor: row.obligation.amountMinor, outstandingMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, collectionGroupId: group.groupId })), fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, groupId: group.groupId, rows: rows.map((row) => [row.obligation.id, row.outstandingMinor]) }) };
    void league;
    return result;
  });
}

export async function prepareStandingAutopayCutoff(input: { organizationId: number; leagueId: number; consentId: string; cutoffAt: string | Date; now?: Date }): Promise<PaymentOperation | undefined> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return undefined;
  const cutoffAt = iso(input.cutoffAt);
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: input.consentId });
    if (!consent) return undefined;
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    const payerIds = [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "A standing payer is no longer active in the league", 409);
    const rows = await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, cutoffAt });
    if (rows.length === 0) {
      const key = `${consent.id}:${consent.consentVersion}:${cutoffAt}`;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, empty: true });
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (user) {
        try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: user.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
        await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "no_op", cutoffAt, consentId: consent.id } });
      }
      return undefined;
    }
    let group = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt, obligations: rows });
    if (group.mode === "double_pay" && group.groupId) {
      const expanded = await addPairedRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, cutoffAt, groupId: group.groupId, existing: rows });
      rows.splice(0, rows.length, ...expanded);
      group = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt, obligations: rows });
    }
    const now = input.now ?? new Date();
    const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
    if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const targetKey = `standing-autopay:${input.organizationId}:${input.leagueId}:${consent.payerBowlerId}:${cutoffAt}:${group.groupId ?? group.occurrenceIds.join(".")}`;
    const identity = buildPaymentOperationIdentity({ organizationId: input.organizationId, operationType: "standing_autopay_charge", targetKey, amountMinor, currency: "USD", providerName: consent.providerName ?? "square" });
    const evidenceFingerprint = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, mode: group.mode, groupId: group.groupId, groupOccurrenceIds: group.occurrenceIds, obligations: rows.map((row) => ({ id: row.obligation.id, responsibilityId: row.obligation.responsibilityId, occurrenceId: row.obligation.occurrenceId, amountMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, payerBowlerId: row.obligation.payerBowlerId })), partners: partners.map((row) => ({ partnerBowlerId: row.partnerBowlerId, paymentLinkId: row.paymentLinkId, linkFingerprint: row.linkFingerprint })) });
    const commandKey = `${consent.id}:${consent.consentVersion}:${cutoffAt}:${group.groupId ?? "weekly"}`;
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key: commandKey, fingerprint: evidenceFingerprint });
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.targetKey, targetKey), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("update");
    if (existing) { await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: existing.id, status: existing.status, cutoffAt } }); return existing; }
    const [operation] = await tx.insert(paymentOperations).values({
      organizationId: input.organizationId, authorizingUserId: payerUser.id, operationType: "standing_autopay_charge", targetKey, leagueId: input.leagueId, amountMinor, currency: "USD", requestFingerprint: identity.requestFingerprint, providerIdempotencyKey: identity.providerIdempotencyKey, providerName: consent.providerName ?? "square", status: "pending", nextAttemptAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), attemptCount: 0,
    }).returning();
    if (!operation) throw new StandingAutopayError("OPERATION_WRITE_FAILED", "The standing payment operation could not be created", 500);
    const snapshotRows = rows.map((row, index) => ({ allocationIndex: index, obligationId: row.obligation.id, amountMinor: row.outstandingMinor, occurrenceId: row.obligation.occurrenceId, responsibilityId: row.obligation.responsibilityId, payerBowlerId: row.obligation.payerBowlerId, dueAt: row.obligation.dueAt }));
    await tx.insert(paymentOperationRosterSnapshots).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, snapshotVersion: 1, snapshotKind: "standing_autopay", collectionMode: group.mode, cutoffAt, amountMinor, currency: "USD", obligations: snapshotRows, snapshotFingerprint: evidenceFingerprint });
    await tx.insert(paymentOperationStandingAutopayBindings).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, collectionMode: group.mode, evidenceFingerprint });
    await tx.insert(paymentOperationRosterSnapshotItems).values(snapshotRows.map((row) => ({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: row.obligationId, allocationIndex: row.allocationIndex, amountMinor: row.amountMinor, state: "reserved" as const })));
    await tx.insert(paymentOperationStandingAutopayParticipants).values(snapshotRows.map((row) => {
      const partner = partners.find((candidate) => candidate.partnerBowlerId === row.payerBowlerId);
      return { operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, allocationIndex: row.allocationIndex, bowlerId: row.payerBowlerId, role: partner ? "partner" as const : "payer" as const, paymentLinkId: partner?.paymentLinkId ?? null, linkFingerprint: partner?.linkFingerprint ?? null, consentVersion: consent.consentVersion };
    }));
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: operation.id, status: operation.status, cutoffAt, amountMinor } });
    return operation;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function getStandingAutopayExecutionSnapshot(input: { organizationId: number; operationId: string }) {
  const [row] = await db.select({ operation: paymentOperations, binding: paymentOperationStandingAutopayBindings, snapshot: paymentOperationRosterSnapshots, consent: autopayConsents, locationId: leagues.locationId }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, and(eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id), eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId))).innerJoin(paymentOperationRosterSnapshots, and(eq(paymentOperationRosterSnapshots.operationId, paymentOperations.id), eq(paymentOperationRosterSnapshots.organizationId, input.organizationId))).innerJoin(autopayConsents, and(eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId), eq(autopayConsents.organizationId, input.organizationId))).innerJoin(leagues, and(eq(leagues.id, paymentOperations.leagueId), eq(leagues.organizationId, input.organizationId))).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1);
  if (!row) return undefined;
  const items = await db.select({ item: paymentOperationRosterSnapshotItems, obligation: paymentObligations }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId), eq(paymentObligations.organizationId, input.organizationId))).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.operationId, input.operationId))).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
  return { ...row, items, sourceId: decrypt(row.consent.encryptedSourceId ?? ""), customerId: decrypt(row.consent.encryptedCustomerId ?? "") };
}

export async function standingPaymentRows(input: { organizationId: number; operationId: string; providerPaymentId: string; providerName: string; actorUserId: number | null }) {
  const snapshot = await getStandingAutopayExecutionSnapshot(input);
  if (!snapshot) throw new StandingAutopayError("SNAPSHOT_NOT_FOUND", "The standing operation snapshot is unavailable", 409);
  return snapshot.items.map((row) => ({ allocationIndex: row.item.allocationIndex, values: { bowlerId: row.obligation.payerBowlerId, leagueId: snapshot.operation.leagueId ?? snapshot.binding.leagueId, amount: row.item.amountMinor, lineageAmount: null, prizeFundAmount: null, weekOf: row.obligation.dueAt, status: "paid" as const, type: snapshot.operation.providerName === "square" ? "square" as const : "credit_card" as const, providerPaymentId: input.providerPaymentId, receiptEmailMissing: false, combinedChargeGroupId: snapshot.binding.collectionMode === "double_pay" ? snapshot.operation.id : null, paidByUserId: input.actorUserId, notes: "Roster standing automatic payment" } }));
}

export async function validateStandingConsentForDispatchInTransaction(tx: StandingTx, input: { organizationId: number; leagueId: number; operationId: string; leagueIdAlreadyLocked?: boolean }) {
    if (!input.leagueIdAlreadyLocked) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [binding] = await tx.select().from(paymentOperationStandingAutopayBindings).where(and(eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId), eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId), eq(paymentOperationStandingAutopayBindings.operationId, input.operationId))).limit(1).for("update");
    if (!binding) throw new StandingAutopayError("STANDING_BINDING_MISSING", "The standing operation binding is unavailable");
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: binding.consentId });
    if (!consent || consent.consentVersion !== binding.consentVersion) throw new StandingAutopayError("CONSENT_REVOKED", "Standing consent changed before dispatch");
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)]))) throw new StandingAutopayError("PARTICIPANT_INACTIVE", "A standing payer is no longer active");
    const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId), eq(paymentOperationRosterSnapshots.operationId, input.operationId), eq(paymentOperationRosterSnapshots.snapshotKind, "standing_autopay"))).limit(1).for("share");
    if (!snapshot || snapshot.snapshotFingerprint !== binding.evidenceFingerprint) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is invalid");
    if (!await validateRosterSnapshotForDispatchInTransaction(tx, input)) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is unavailable");
    return true;
}

export async function validateStandingConsentForDispatch(input: { organizationId: number; leagueId: number; operationId: string }) {
  return db.transaction((tx) => validateStandingConsentForDispatchInTransaction(tx, input));
}
