import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagues,
  paymentAllocations,
  autopayConsents,
  refundAllocationAdjustments,
  paymentObligations,
  payments,
  financialCommands,
  occurrencePaymentResponsibilities,
  rotatingOccurrenceAssignments,
  teamPaymentRotationMembers,
  teamPaymentRotationMemberRevisions,
  teamPaymentPolicies,
  teamPaymentPolicyRevisions,
  teamPaymentSlotRevisions,
  teamPaymentSlots,
  teams,
  paymentOperations,
  paymentDisputes,
  paymentOperationStandingAutopayBindings,
  paymentObligationOwnerRevisions,
  refundPaymentOperationSnapshots,
  rotatingCreditFundings,
  rotatingCreditApplications,
  rotatingCreditApplicationReversals,
  paymentOperationRosterSnapshots,
  paymentOperationRosterSnapshotItems,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  leagueOccurrenceBillingTerms,
  paymentVoids,
  users,
  emailSchema,
  type TeamPaymentPolicy,
} from "@shared/schema";
import {
  serializeCanonicalResponsibilityFingerprint,
  serializeCanonicalRotatingRosterFingerprint,
  serializeRotatingOccurrenceAssignmentFingerprint,
} from "@shared/roster-payment-contract";
import type {
  CanonicalCorrectionRequest,
  CanonicalManualRecordRequest,
  OccurrenceResponsibilityInput,
  RosterPaymentResponsibilityRequest,
  RosterPaymentResponsibilityRequestV2,
  RosterPaymentResponsibilityReadContractV2,
  RotatingOccurrenceAssignmentRequest,
  calculateRosterPaymentTiming,
} from "@shared/roster-payment-contract";
import type { FinancialReadContract, FinancialReadContractV3, FinancialReadRowContractV3 } from "@shared/financial-contract";
import {
  canonicalHistoricalCashAllocationRepairFingerprint,
  historicalCashAllocationFingerprint,
  type HistoricalCashAllocationRepairRequest,
} from "@shared/historical-payment-repair";
export {
  canonicalHistoricalCashAllocationRepairFingerprint,
  historicalCashAllocationFingerprint,
} from "@shared/historical-payment-repair";
export type {
  HistoricalCashAllocationFingerprintRow,
  HistoricalCashAllocationRepairRequest,
} from "@shared/historical-payment-repair";
export type HistoricalCashPaymentAllowlist = {
  paymentAmountsMinor: Readonly<Record<string, number>>;
};
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { prepareInteractivePaymentOperation } from "./interactive-payment-operation-preparation.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { paymentOperationRetryExecutor } from "./payment-operation-retry-executor.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { decrypt } from "../utils/crypto.js";
import { assertOpenRosterEvidenceCanBeReplaced, deriveRosterPaymentTimingInTransaction, materializeRosterPaymentOccurrencesInTransaction, revokeStandingAutopayForBowlerInTransaction } from "./roster-payment-materializer.js";
import { createLogger } from "../logger.js";
import { allocateAutomaticFifoPayment as allocateFifo, comparePublishedCollectionOrder, type FifoPaymentCandidate as BaseFifoPaymentCandidate, AutomaticFifoAllocationError } from "./automatic-fifo-allocation.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { resolveCanonicalLocalDateTime } from "@shared/canonical-dst-resolver";
import { isCurrentBowlerOwnedObligationSql, resolvePaymentObligationOwnerInTransaction, resolvePaymentObligationOwnersInTransaction, type EffectivePaymentObligationOwner, PaymentObligationOwnerError } from "./roster-obligation-owners.js";
import { reverseRotatingCreditApplicationsForAssignmentChangeInTransaction } from "./rotating-credit-applications.js";
import { applyRotatingCreditToConfirmedObligationsInTransaction } from "./rotating-credit-applications.js";
import { readConfirmedRotatingObligationsForCredit } from "./rotating-team-payments.js";

export { calculateRosterPaymentTiming };

const log = createLogger("RosterPaymentCore");

export class RosterPaymentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

export class RosterPaymentReplay extends RosterPaymentError {
  constructor(public readonly result: unknown) {
    super("IDEMPOTENCY_REPLAY", "The command was already applied", 200);
  }
}

function resolveInteractiveBuyerEmail(providerName: string, requestedEmail: string | null | undefined, payerEmail: string | null | undefined): string | null {
  // The payer profile is authoritative when it contains an address. The
  // request value is only the explicit checkout fallback for a payer without
  // one on file; this prevents an admin/browser payload from silently
  // replacing the payer's stored receipt address.
  const candidate = payerEmail?.trim() || requestedEmail?.trim() || null;
  if (providerName !== "square") return candidate;
  const parsed = emailSchema.max(255).safeParse(candidate);
  if (!parsed.success) throw new RosterPaymentError("BUYER_EMAIL_REQUIRED", "A valid buyer email is required for Square payments", 422);
  return parsed.data;
}

export type RosterPaymentTransaction = PaymentOperationTransaction;

async function assertPaymentIsNotRotatingCreditFundingInTransaction(
  tx: RosterPaymentTransaction,
  input: { organizationId: number; leagueId: number; paymentId: number },
): Promise<void> {
  const [funding] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
    eq(rotatingCreditFundings.paymentId, input.paymentId),
  )).limit(1);
  if (funding) {
    throw new RosterPaymentError("ROTATING_CREDIT_TENDER_IMMUTABLE", "Credit funding tenders can only be refunded through their personal credit balance", 409);
  }
}

async function beginFinancialCommand(
  tx: RosterPaymentTransaction,
  input: { organizationId: number; leagueId: number; actorUserId: number; commandType: string; idempotencyKey: string; requestFingerprint: string },
): Promise<void> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.idempotencyKey),
  )).limit(1).for("update");
  if (existing) {
    if (existing.actorUserId !== input.actorUserId) throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to another actor", 409);
    if (existing.requestFingerprint !== input.requestFingerprint) throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request", 409);
    if (existing.state === "applied" && existing.result !== null) throw new RosterPaymentReplay(existing.result);
    if (existing.state === "failed") throw new RosterPaymentError(existing.errorCode ?? "COMMAND_FAILED", "The command previously failed", 409);
    return;
  }
  await tx.insert(financialCommands).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: input.commandType,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    state: "accepted",
  });
}

async function completeFinancialCommand(tx: RosterPaymentTransaction, input: { organizationId: number; leagueId: number; commandType: string; idempotencyKey: string; result: unknown }): Promise<void> {
  await tx.update(financialCommands).set({ state: "applied", result: input.result }).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.idempotencyKey),
  ));
}

function quoteFingerprint(obligations: Array<{ id: string; amountMinor: number; dueAt: string; effectiveCollectionAt: string; payerBowlerId: number; pairedCollectionReady?: boolean }>): string {
  const value = obligations.map((row) => [row.id, row.amountMinor, row.dueAt, row.effectiveCollectionAt, row.payerBowlerId, row.pairedCollectionReady === true]).join("|");
  return `lvrosterquote:v1:${createHash("sha256").update(value).digest("hex")}`;
}

function commandFingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function serializedCommandFingerprint(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

function paymentLocalDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function canonicalRosterFingerprint(request: RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy }): string {
  return commandFingerprint("lvroster:v1", {
    lineupSize: request.lineupSize,
    policy: request.policy ?? "main_pays_full",
    slots: [...request.slots].sort((a, b) => a.slotIndex - b.slotIndex).map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
  });
}

export function canonicalRotatingRosterFingerprint(request: RosterPaymentResponsibilityRequestV2 & { policy?: TeamPaymentPolicy }): string {
  return serializedCommandFingerprint("lvroster:v2", serializeCanonicalRotatingRosterFingerprint(request));
}

export function canonicalRotatingAssignmentFingerprint(request: RotatingOccurrenceAssignmentRequest): string {
  return serializedCommandFingerprint("lvrotationassignment:v1", serializeRotatingOccurrenceAssignmentFingerprint(request.assignments));
}

export function canonicalResponsibilityFingerprint(rows: OccurrenceResponsibilityInput[]): string {
  return serializedCommandFingerprint("lvresponsibility:v1", serializeCanonicalResponsibilityFingerprint(rows));
}

type CanonicalCorrectionInput = CanonicalCorrectionRequest;

export function canonicalCorrectionFingerprint(request: CanonicalCorrectionInput): string {
  return commandFingerprint("lvcorrection:v3", {
    paymentId: request.paymentId ?? null,
    correctionMode: request.correctionMode,
    reason: request.reason,
  });
}

export function canonicalCashPaymentEditFingerprint(request: Pick<CanonicalCorrectionInput, "paymentId" | "correctionMode" | "reason" | "amountMinor" | "paymentDate">): string {
  return commandFingerprint("lvcashedit:v1", {
    paymentId: request.paymentId,
    correctionMode: request.correctionMode,
    amountMinor: request.amountMinor,
    paymentDate: request.paymentDate,
    reason: request.reason,
  });
}

async function leagueScope(organizationId: number, leagueId: number): Promise<{ id: number; organizationId: number; locationId: number | null; payingLineupSize: number | null; paymentMode: "weekly" | "upfront"; weeklyFee: number; substituteAccess: "team_only" | "floating"; substitutePaymentRegime: "team_choice" | "league_lineage_prize_split"; lineageFee: number | null; prizeFundFee: number | null }> {
  const [league] = await db.select({ id: leagues.id, organizationId: leagues.organizationId, locationId: leagues.locationId, payingLineupSize: leagues.payingLineupSize, paymentMode: leagues.paymentMode, weeklyFee: leagues.weeklyFee, substituteAccess: leagues.substituteAccess, substitutePaymentRegime: leagues.substitutePaymentRegime, lineageFee: leagues.lineageFee, prizeFundFee: leagues.prizeFundFee })
    .from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, organizationId))).limit(1);
  if (!league || league.organizationId !== organizationId) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
  return { ...league, organizationId };
}

export async function readRosterPaymentResponsibility(input: { organizationId: number; leagueId: number }) {
  const league = await leagueScope(input.organizationId, input.leagueId);
  const teamRows = await db.select({ id: teams.id, name: teams.name, number: teams.number })
    .from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true))).orderBy(asc(teams.displayOrder), asc(teams.number), asc(teams.id));
  const slots = await db.select({
    teamId: teamPaymentSlots.teamId,
    slotIndex: teamPaymentSlots.slotIndex,
    occupant: teamPaymentSlots.occupant,
    mainBowlerId: teamPaymentSlots.mainBowlerId,
  }).from(teamPaymentSlots)
    .where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId)))
    .orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
  const policyRows = await db.select().from(teamPaymentPolicies)
    .where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId)));
  const substituteBowlerOptions = await db.select({ id: bowlers.id, name: bowlers.name, teamId: bowlerLeagues.teamId })
    .from(bowlers)
    .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true)))
    .where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true)))
    .orderBy(asc(bowlers.name), asc(bowlers.id));
  const occurrences = await db.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, status: leagueOccurrences.status })
    .from(leagueOccurrences)
    .where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
      inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
    ))
    .orderBy(asc(leagueOccurrences.startAt), asc(leagueOccurrences.id));
  const occurrenceResponsibilities = await db.select({
    occurrenceId: occurrencePaymentResponsibilities.occurrenceId,
    teamId: occurrencePaymentResponsibilities.teamId,
    slotIndex: occurrencePaymentResponsibilities.slotIndex,
    positionIndex: occurrencePaymentResponsibilities.positionIndex,
    responsibilityKind: occurrencePaymentResponsibilities.responsibilityKind,
    mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId,
    substituteBowlerId: occurrencePaymentResponsibilities.substituteBowlerId,
    payerBowlerId: occurrencePaymentResponsibilities.payerBowlerId,
    policy: occurrencePaymentResponsibilities.policy,
    amountMinor: occurrencePaymentResponsibilities.amountMinor,
    lineageAmountMinor: occurrencePaymentResponsibilities.lineageAmountMinor,
    prizeFundAmountMinor: occurrencePaymentResponsibilities.prizeFundAmountMinor,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).orderBy(asc(occurrencePaymentResponsibilities.occurrenceId), asc(occurrencePaymentResponsibilities.teamId), asc(occurrencePaymentResponsibilities.slotIndex), asc(occurrencePaymentResponsibilities.positionIndex));
  const slotsByTeam = new Map<number, typeof slots>();
  for (const slot of slots) slotsByTeam.set(slot.teamId, [...(slotsByTeam.get(slot.teamId) ?? []), slot]);
  const activeMainRows = await db.select({ bowlerId: bowlerLeagues.bowlerId, teamId: bowlerLeagues.teamId })
    .from(bowlerLeagues)
    .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
    .where(and(
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlerLeagues.leagueId, input.leagueId),
      eq(bowlerLeagues.active, true),
      eq(bowlers.active, true),
    ));
  const activeMainKeys = new Set(activeMainRows.map((row) => `${row.teamId}:${row.bowlerId}`));
  const incompleteTeams = teamRows.filter((team) => {
    const rows = slotsByTeam.get(team.id) ?? [];
    return league.payingLineupSize === null || rows.length !== league.payingLineupSize || rows.some((row) => row.occupant === "unassigned" || (row.occupant === "main" && (row.mainBowlerId === null || !activeMainKeys.has(`${row.teamId}:${row.mainBowlerId}`))));
  }).map((team) => team.id);
  return {
    contractVersion: "roster-payment-responsibility/1" as const,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payingLineupSize: league.payingLineupSize,
    weeklyFee: league.weeklyFee,
    lineageFee: league.lineageFee,
    prizeFundFee: league.prizeFundFee,
    substituteAccess: league.substituteAccess,
    substitutePaymentRegime: league.substitutePaymentRegime,
    ready: league.payingLineupSize !== null && incompleteTeams.length === 0,
    incompleteTeamIds: incompleteTeams,
    occurrences: occurrences.map((occurrence) => ({ id: occurrence.id, startAt: occurrence.startAt, status: occurrence.status })),
    occurrenceResponsibilities,
    substituteBowlerOptions,
    teams: teamRows.map((team) => ({
      ...team,
      policy: policyRows.find((policy) => policy.teamId === team.id)?.defaultPolicy ?? "main_pays_full",
      slots: slotsByTeam.get(team.id) ?? [],
    })),
  };
}

export async function readRosterPaymentResponsibilityV2(input: { organizationId: number; leagueId: number }): Promise<RosterPaymentResponsibilityReadContractV2> {
  const legacy = await readRosterPaymentResponsibility(input);
  const slots = await db.select({
    id: teamPaymentSlots.id,
    teamId: teamPaymentSlots.teamId,
    slotIndex: teamPaymentSlots.slotIndex,
    occupant: teamPaymentSlots.occupant,
    mainBowlerId: teamPaymentSlots.mainBowlerId,
    currentRevision: teamPaymentSlots.currentRevision,
  }).from(teamPaymentSlots).where(and(
    eq(teamPaymentSlots.organizationId, input.organizationId),
    eq(teamPaymentSlots.leagueId, input.leagueId),
  )).orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
  const slotByKey = new Map(slots.map((slot) => [`${slot.teamId}:${slot.slotIndex}`, slot]));
  const poolRows = await db.select({ teamId: teamPaymentRotationMembers.teamId, bowlerId: teamPaymentRotationMembers.bowlerId })
    .from(teamPaymentRotationMembers)
    .innerJoin(bowlers, and(eq(bowlers.id, teamPaymentRotationMembers.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true)))
    .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.teamId, teamPaymentRotationMembers.teamId), eq(bowlerLeagues.active, true)))
    .where(and(
      eq(teamPaymentRotationMembers.organizationId, input.organizationId),
      eq(teamPaymentRotationMembers.leagueId, input.leagueId),
      eq(teamPaymentRotationMembers.active, true),
    )).orderBy(asc(teamPaymentRotationMembers.teamId), asc(teamPaymentRotationMembers.bowlerId));
  const eligibleIdsByTeam = new Map<number, number[]>();
  for (const row of poolRows) eligibleIdsByTeam.set(row.teamId, [...(eligibleIdsByTeam.get(row.teamId) ?? []), row.bowlerId]);
  const rawOccurrenceRows = await db.select({
    id: leagueOccurrences.id,
    startAt: leagueOccurrences.startAt,
    occurrenceLocalDate: leagueOccurrences.authoritativeLocalDate,
    plannedOrdinal: leagueOccurrences.plannedOrdinal,
    status: leagueOccurrences.status,
  }).from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
    inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
    inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
  )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.id));
  const occurrenceRows = rawOccurrenceRows.map((row) => {
    if (row.occurrenceLocalDate === null || row.plannedOrdinal === null) {
      throw new RosterPaymentError("CANONICAL_OCCURRENCE_ORDER_MISSING", "A published date is missing its canonical local date or planned order", 503);
    }
    return { ...row, occurrenceLocalDate: row.occurrenceLocalDate, plannedOrdinal: row.plannedOrdinal, status: row.status as "scheduled" | "completed" };
  });
  const billingRows = occurrenceRows.length === 0 ? [] : await db.select({
    occurrenceId: leagueOccurrenceBillingTerms.occurrenceId,
    billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal,
  }).from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
    eq(leagueOccurrenceBillingTerms.state, "published"),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceRows.map((row) => row.id)),
  ));
  const billingByOccurrence = new Map<string, number>();
  for (const row of billingRows) {
    if (row.billingOrdinal === null || billingByOccurrence.has(row.occurrenceId)) continue;
    billingByOccurrence.set(row.occurrenceId, row.billingOrdinal);
  }
  const rotatingSlots = slots.filter((slot) => slot.occupant === "rotating");
  const rotatingTeamIds = [...new Set(rotatingSlots.map((slot) => slot.teamId))];
  const responsibilityRows = occurrenceRows.length === 0 || rotatingTeamIds.length === 0 ? [] : await db.select({
    id: occurrencePaymentResponsibilities.id,
    occurrenceId: occurrencePaymentResponsibilities.occurrenceId,
    teamId: occurrencePaymentResponsibilities.teamId,
    slotIndex: occurrencePaymentResponsibilities.slotIndex,
    state: occurrencePaymentResponsibilities.state,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
    inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceRows.map((row) => row.id)),
    inArray(occurrencePaymentResponsibilities.teamId, rotatingTeamIds),
  ));
  const responsibilityByKey = new Map(responsibilityRows.map((row) => [
    `${row.occurrenceId}:${row.teamId}:${row.slotIndex}`,
    row,
  ]));
  const currentResponsibilityIds = responsibilityRows.map((row) => row.id);
  const obligationRows = currentResponsibilityIds.length === 0 ? [] : await db.select({
    id: paymentObligations.id,
    responsibilityId: paymentObligations.responsibilityId,
  }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, currentResponsibilityIds),
  )).orderBy(asc(paymentObligations.component), asc(paymentObligations.id));
  const obligationIdsByResponsibility = new Map<string, string[]>();
  for (const row of obligationRows) obligationIdsByResponsibility.set(row.responsibilityId, [...(obligationIdsByResponsibility.get(row.responsibilityId) ?? []), row.id]);
  const assignmentRows = occurrenceRows.length === 0 || rotatingTeamIds.length === 0 ? [] : await db.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
    inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceRows.map((row) => row.id)),
    inArray(rotatingOccurrenceAssignments.teamId, rotatingTeamIds),
  )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version));
  const assignmentByKey = new Map<string, typeof assignmentRows[number]>();
  for (const row of assignmentRows) {
    const key = `${row.occurrenceId}:${row.teamId}:${row.slotIndex}`;
    if (!assignmentByKey.has(key)) assignmentByKey.set(key, row);
  }
  const rotationAssignments = occurrenceRows.flatMap((occurrence) => rotatingSlots.map((slot) => {
    const key = `${occurrence.id}:${slot.teamId}:${slot.slotIndex}`;
    const responsibility = responsibilityByKey.get(key);
    const assignment = assignmentByKey.get(key);
    if (assignment && (!responsibility || assignment.responsibilityId !== responsibility.id)) {
      throw new RosterPaymentError("ROTATING_ASSIGNMENT_EVIDENCE_INVALID", "A rotating assignment does not match the current canonical responsibility", 503);
    }
    return {
      occurrenceId: occurrence.id,
      teamId: slot.teamId,
      slotIndex: slot.slotIndex,
      responsibilityId: responsibility?.id ?? null,
      obligationIds: responsibility ? obligationIdsByResponsibility.get(responsibility.id) ?? [] : [],
      assignmentId: assignment?.id ?? null,
      actualBowlerId: assignment?.actualBowlerId ?? null,
      revision: assignment?.version ?? null,
      assignedAt: assignment?.createdAt ?? null,
      recordedByUserId: assignment?.recordedByUserId ?? null,
    };
  }));
  const teams = legacy.teams.map((team) => ({
    ...team,
    eligibleRotatingBowlerIds: eligibleIdsByTeam.get(team.id) ?? [],
    slots: team.slots.map((slot) => ({
      ...slot,
      currentRevision: slotByKey.get(`${team.id}:${slot.slotIndex}`)?.currentRevision ?? 1,
    })),
  }));
  const incompleteTeamIds = [...new Set([
    ...legacy.incompleteTeamIds,
    ...teams.filter((team) => team.slots.some((slot) => slot.occupant === "rotating") && team.eligibleRotatingBowlerIds.length === 0).map((team) => team.id),
  ])];
  return {
    ...legacy,
    contractVersion: "roster-payment-responsibility/2" as const,
    payingLineupSize: legacy.payingLineupSize === 3 || legacy.payingLineupSize === 4 ? legacy.payingLineupSize : null,
    ready: legacy.payingLineupSize !== null && incompleteTeamIds.length === 0,
    incompleteTeamIds,
    occurrences: occurrenceRows.map((occurrence) => ({
      ...occurrence,
      billingOrdinal: billingByOccurrence.get(occurrence.id) ?? null,
    })),
    teams,
    rotationAssignments,
  };
}

async function assertUnusedRotatingSlotsCanBeDisabledInTransaction(
  tx: RosterPaymentTransaction,
  input: { organizationId: number; leagueId: number; teamId: number; slotIndexes: number[] },
): Promise<void> {
  if (input.slotIndexes.length === 0) return;
  const assignments = await tx.select({ id: rotatingOccurrenceAssignments.id }).from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
    eq(rotatingOccurrenceAssignments.teamId, input.teamId),
    inArray(rotatingOccurrenceAssignments.slotIndex, input.slotIndexes),
  )).limit(1);
  if (assignments.length > 0) {
    throw new RosterPaymentError("ROTATING_SLOT_HAS_ASSIGNMENT_HISTORY", "Clear or reconcile every dated rotating assignment before turning this position off", 409);
  }
  const activeResponsibilities = await tx.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.teamId, input.teamId),
    inArray(occurrencePaymentResponsibilities.slotIndex, input.slotIndexes),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  const responsibilityIds = activeResponsibilities.map((row) => row.id);
  if (responsibilityIds.length === 0) return;
  const obligations = await tx.select({
    id: paymentObligations.id,
    state: paymentObligations.state,
    dueAt: paymentObligations.dueAt,
    occurrenceStartAt: leagueOccurrences.startAt,
  }).from(paymentObligations).innerJoin(leagueOccurrences, and(
    eq(leagueOccurrences.id, paymentObligations.occurrenceId),
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
  )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, responsibilityIds),
  ));
  const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
  const now = (timestampResult.rows[0] as { now?: string } | undefined)?.now;
  if (!now) throw new RosterPaymentError("ROTATING_SLOT_TIME_UNAVAILABLE", "The rotating position change could not establish a database time", 503);
  if (obligations.some((row) => row.state !== "open"
    || new Date(row.dueAt).getTime() <= new Date(now).getTime()
    || new Date(row.occurrenceStartAt).getTime() <= new Date(now).getTime())) {
    throw new RosterPaymentError("ROTATING_SLOT_HAS_FINANCIAL_HISTORY", "A rotating position cannot be turned off after a bowling date has occurred, come due, or been partially paid; settle or reconcile this slot first", 409);
  }
  const obligationIds = obligations.map((row) => row.id);
  if (obligationIds.length === 0) return;
  const [allocation, operationItem, fundingApp] = await Promise.all([
    tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(paymentAllocations.obligationId, obligationIds),
    )).limit(1),
    tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
    )).limit(1),
    tx.select({ id: rotatingCreditApplications.id }).from(rotatingCreditApplications).where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
      inArray(rotatingCreditApplications.obligationId, obligationIds),
    )).limit(1),
  ]);
  if (allocation.length > 0 || operationItem.length > 0 || fundingApp.length > 0) {
    throw new RosterPaymentError("ROTATING_SLOT_HAS_FINANCIAL_HISTORY", "This rotating position has payment or provider evidence and cannot be turned off", 409);
  }
}

export async function saveTeamRoster(input: {
  organizationId: number;
  leagueId: number;
  teamId: number;
  actorUserId: number;
  payerBowlerId?: number;
  request: (RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy })
    | (RosterPaymentResponsibilityRequestV2 & { policy?: TeamPaymentPolicy });
}) {
  const league = await leagueScope(input.organizationId, input.leagueId);
  const isV2 = "eligibleRotatingBowlerIds" in input.request;
  const request = input.request as (RosterPaymentResponsibilityRequestV2 & { policy?: TeamPaymentPolicy })
    & { slots: Array<{ slotIndex: number; occupant: "main" | "vacant" | "unassigned" | "rotating"; mainBowlerId?: number | null }> };
  const expectedFingerprint = isV2
    ? canonicalRotatingRosterFingerprint(request)
    : canonicalRosterFingerprint(request as RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy });
  if (request.requestFingerprint !== expectedFingerprint) throw new RosterPaymentError("INVALID_FINGERPRINT", "The roster request fingerprint is invalid", 422);
  if (league.payingLineupSize !== request.lineupSize) throw new RosterPaymentError("LINEUP_SIZE_MISMATCH", "Roster lineup size does not match league setup", 409);
  if (isV2 && request.slots.some((slot) => slot.occupant === "rotating")
    && (league.paymentMode === "upfront" || league.weeklyFee <= 0)) {
    throw new RosterPaymentError("ROTATING_BILLING_UNAVAILABLE", "Rotating positions require a positive weekly league fee", 409);
  }
  if (request.policy === "special_split" && league.substitutePaymentRegime !== "league_lineage_prize_split") {
    throw new RosterPaymentError("POLICY_NOT_AVAILABLE", "Special split requires the league lineage/prize split regime", 422);
  }
  const slots = [...request.slots].sort((a, b) => a.slotIndex - b.slotIndex);
  if (slots.length !== request.lineupSize || slots.some((slot, index) => slot.slotIndex !== index)) throw new RosterPaymentError("INCOMPLETE_ROSTER", "Every stable lineup slot must be supplied", 422);
  if (slots.filter((slot) => slot.occupant === "main").some((slot) => slot.mainBowlerId === null || slot.mainBowlerId === undefined)) throw new RosterPaymentError("INVALID_MAIN", "A Main slot requires a bowler", 422);
  if (slots.some((slot) => slot.occupant !== "main" && slot.mainBowlerId !== null && slot.mainBowlerId !== undefined)) {
    throw new RosterPaymentError("INVALID_SLOT_IDENTITY", "Only a Main slot may contain a Main bowler identity", 422);
  }
  const eligibleRotatingBowlerIds = isV2 ? [...request.eligibleRotatingBowlerIds].sort((a, b) => a - b) : [];
  if (new Set(eligibleRotatingBowlerIds).size !== eligibleRotatingBowlerIds.length) {
    throw new RosterPaymentError("DUPLICATE_ROTATING_MEMBER", "A rotating bowler may appear only once in the eligibility pool", 422);
  }
  const mainBowlerIds = slots.flatMap((slot) => slot.mainBowlerId ? [slot.mainBowlerId] : []);
  if (eligibleRotatingBowlerIds.some((bowlerId) => mainBowlerIds.includes(bowlerId))) {
    throw new RosterPaymentError("ROTATING_MAIN_OVERLAP", "A bowler cannot be both a fixed Main and a rotating pool member on this team", 422);
  }
  if (isV2 && slots.some((slot) => slot.occupant === "rotating") && eligibleRotatingBowlerIds.length === 0) {
    throw new RosterPaymentError("ROTATING_POOL_REQUIRED", "Add at least one eligible rotating bowler before enabling this position", 422);
  }
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const commandType = isV2 ? "roster_payment.save_team_roster_v2" : "roster_payment.save_team_roster";
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType,
      idempotencyKey: request.commandKey,
      requestFingerprint: request.requestFingerprint,
    });
    const [team] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, input.leagueId), eq(teams.active, true))).limit(1).for("update");
    if (!team) throw new RosterPaymentError("NOT_FOUND", "Team not found", 404);
    const selectedBowlerIds = mainBowlerIds;
    if (new Set(selectedBowlerIds).size !== selectedBowlerIds.length) throw new RosterPaymentError("DUPLICATE_MAIN", "A bowler may occupy only one Main slot", 422);
    if (selectedBowlerIds.length > 0) {
      const members = await tx.select({ id: bowlers.id }).from(bowlers)
        .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.teamId, input.teamId), eq(bowlerLeagues.active, true)))
        .where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true), inArray(bowlers.id, selectedBowlerIds)));
      if (members.length !== selectedBowlerIds.length) throw new RosterPaymentError("BOWLER_NOT_IN_LEAGUE", "Main must be an active member of this league", 422);
    }
    const existing = await tx.select().from(teamPaymentSlots).where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId), eq(teamPaymentSlots.teamId, input.teamId))).orderBy(asc(teamPaymentSlots.slotIndex)).for("update");
    if (!isV2 && existing.some((row) => row.occupant === "rotating")) {
      throw new RosterPaymentError("ROTATING_CONFIGURATION_REQUIRES_V2", "This team uses rotating payments. Update it through the roster contract v2.", 409);
    }
    if (existing.some((row) => row.slotIndex >= request.lineupSize)) throw new RosterPaymentError("LINEUP_SIZE_LOCKED", "Existing stable slots prevent reducing the league lineup size", 409);
    const currentRotatingSlots = existing.filter((row) => row.occupant === "rotating");
    const turningOff = currentRotatingSlots.filter((row) => slots.find((slot) => slot.slotIndex === row.slotIndex)?.occupant !== "rotating");
    if (turningOff.length > 0) await assertUnusedRotatingSlotsCanBeDisabledInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      teamId: input.teamId,
      slotIndexes: turningOff.map((slot) => slot.slotIndex),
    });
    if (isV2 && eligibleRotatingBowlerIds.length > 0) {
      const poolMembers = await tx.select({ bowlerId: bowlers.id }).from(bowlers)
        .innerJoin(bowlerLeagues, and(
          eq(bowlerLeagues.bowlerId, bowlers.id),
          eq(bowlerLeagues.leagueId, input.leagueId),
          eq(bowlerLeagues.teamId, input.teamId),
          eq(bowlerLeagues.active, true),
        ))
        .where(and(
          eq(bowlers.organizationId, input.organizationId),
          eq(bowlers.active, true),
          inArray(bowlers.id, eligibleRotatingBowlerIds),
        ));
      if (poolMembers.length !== eligibleRotatingBowlerIds.length) {
        throw new RosterPaymentError("ROTATING_MEMBER_NOT_IN_TEAM", "Every rotating pool member must be an active member of this team and league", 422);
      }
      if (!slots.some((slot) => slot.occupant === "rotating") && eligibleRotatingBowlerIds.length > 0) {
        throw new RosterPaymentError("ROTATING_POOL_WITHOUT_SLOT", "A rotating eligibility pool requires at least one rotating slot", 422);
      }
    }
    const saved = [];
    for (const value of slots) {
      const current = existing.find((row) => row.slotIndex === value.slotIndex);
      if (current) {
        if (current.lineupSize !== request.lineupSize || current.occupant !== value.occupant || current.mainBowlerId !== (value.mainBowlerId ?? null)) {
          const [updated] = await tx.update(teamPaymentSlots).set({ lineupSize: request.lineupSize, occupant: value.occupant, mainBowlerId: value.mainBowlerId ?? null, currentRevision: current.currentRevision + 1, updatedAt: new Date().toISOString() }).where(eq(teamPaymentSlots.id, current.id)).returning();
          await tx.insert(teamPaymentSlotRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, slotId: current.id, revisionNumber: updated.currentRevision, beforeSnapshot: current, afterSnapshot: updated, recordedByUserId: input.actorUserId });
          saved.push(updated);
        } else saved.push(current);
      } else {
        const [created] = await tx.insert(teamPaymentSlots).values({ organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, slotIndex: value.slotIndex, lineupSize: request.lineupSize, occupant: value.occupant, mainBowlerId: value.mainBowlerId ?? null, recordedByUserId: input.actorUserId }).returning();
        await tx.insert(teamPaymentSlotRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, slotId: created.id, revisionNumber: 1, beforeSnapshot: null, afterSnapshot: created, recordedByUserId: input.actorUserId });
        saved.push(created);
      }
    }
    if (isV2) {
      const existingMembers = await tx.select().from(teamPaymentRotationMembers).where(and(
        eq(teamPaymentRotationMembers.organizationId, input.organizationId),
        eq(teamPaymentRotationMembers.leagueId, input.leagueId),
        eq(teamPaymentRotationMembers.teamId, input.teamId),
      )).orderBy(asc(teamPaymentRotationMembers.bowlerId)).for("update");
      const desiredPool = new Set(eligibleRotatingBowlerIds);
      const removedMembers = existingMembers.filter((member) => member.active && !desiredPool.has(member.bowlerId));
      if (removedMembers.length > 0) {
        const removedIds = removedMembers.map((member) => member.bowlerId);
        const activeAssignmentRows = await tx.select().from(rotatingOccurrenceAssignments).where(and(
          eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
          eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
          eq(rotatingOccurrenceAssignments.teamId, input.teamId),
        )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version));
        const latestBySlot = new Map<string, typeof activeAssignmentRows[number]>();
        for (const assignment of activeAssignmentRows) {
          const key = `${assignment.occurrenceId}:${assignment.slotIndex}`;
          if (!latestBySlot.has(key)) latestBySlot.set(key, assignment);
        }
        const removedCurrentAssignments = [...latestBySlot.values()].filter((assignment) => assignment.actualBowlerId !== null && removedIds.includes(assignment.actualBowlerId));
        if (removedCurrentAssignments.length > 0) {
          const openRows = await tx.select({ id: paymentObligations.id }).from(paymentObligations).where(and(
            eq(paymentObligations.organizationId, input.organizationId),
            eq(paymentObligations.leagueId, input.leagueId),
            inArray(paymentObligations.responsibilityId, removedCurrentAssignments.map((assignment) => assignment.responsibilityId)),
            inArray(paymentObligations.state, ["open", "partially_settled"] as const),
          ));
          if (openRows.length > 0) throw new RosterPaymentError("ROTATING_MEMBER_HAS_OPEN_ASSIGNMENT", "A rotating member with an outstanding confirmed date must remain eligible until that date is corrected or settled", 409);
        }
      }
      const memberByBowler = new Map(existingMembers.map((member) => [member.bowlerId, member]));
      for (const member of existingMembers) {
        const shouldBeActive = desiredPool.has(member.bowlerId);
        if (member.active === shouldBeActive) continue;
        const [updated] = await tx.update(teamPaymentRotationMembers).set({
          active: shouldBeActive,
          currentRevision: member.currentRevision + 1,
          updatedAt: new Date().toISOString(),
        }).where(eq(teamPaymentRotationMembers.id, member.id)).returning();
        await tx.insert(teamPaymentRotationMemberRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          memberId: member.id,
          revisionNumber: updated.currentRevision,
          beforeSnapshot: member,
          afterSnapshot: updated,
          recordedByUserId: input.actorUserId,
        });
      }
      for (const bowlerId of eligibleRotatingBowlerIds) {
        if (memberByBowler.has(bowlerId)) continue;
        const [created] = await tx.insert(teamPaymentRotationMembers).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          teamId: input.teamId,
          bowlerId,
          active: true,
          recordedByUserId: input.actorUserId,
        }).returning();
        await tx.insert(teamPaymentRotationMemberRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          memberId: created.id,
          revisionNumber: 1,
          beforeSnapshot: null,
          afterSnapshot: created,
          recordedByUserId: input.actorUserId,
        });
      }
      // A former fixed payer must not retain an active league-wide standing
      // consent after losing every fixed Main position. Pending dispatched
      // work is a hard gate: resolve it before changing the configuration.
      const formerMainIds = existing.flatMap((row) => row.occupant === "main" && row.mainBowlerId !== null && !selectedBowlerIds.includes(row.mainBowlerId) ? [row.mainBowlerId] : []);
      for (const bowlerId of [...new Set(formerMainIds)]) {
        const remainingMain = await tx.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots).where(and(
          eq(teamPaymentSlots.organizationId, input.organizationId),
          eq(teamPaymentSlots.leagueId, input.leagueId),
          eq(teamPaymentSlots.occupant, "main"),
          eq(teamPaymentSlots.mainBowlerId, bowlerId),
        )).limit(1);
        if (remainingMain.length > 0) continue;
        const inFlight = await tx.select({ id: paymentOperations.id }).from(autopayConsents)
          .innerJoin(paymentOperationStandingAutopayBindings, and(
            eq(paymentOperationStandingAutopayBindings.consentId, autopayConsents.id),
            eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
            eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
          ))
          .innerJoin(paymentOperations, and(
            eq(paymentOperations.id, paymentOperationStandingAutopayBindings.operationId),
            eq(paymentOperations.organizationId, input.organizationId),
            eq(paymentOperations.leagueId, input.leagueId),
          )).where(and(
            eq(autopayConsents.organizationId, input.organizationId),
            eq(autopayConsents.leagueId, input.leagueId),
            eq(autopayConsents.payerBowlerId, bowlerId),
            eq(autopayConsents.state, "active"),
            inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"] as const),
            or(isNotNull(paymentOperations.dispatchClaimedAt), isNotNull(paymentOperations.providerObjectId), eq(paymentOperations.status, "provider_unknown"), eq(paymentOperations.status, "reconciliation_required")),
          )).limit(1).for("update");
        if (inFlight.length > 0) throw new RosterPaymentError("AUTOPAY_OPERATION_IN_FLIGHT", "Resolve the dispatched standing payment before removing this Main payer from the lineup", 409);
        await revokeStandingAutopayForBowlerInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerId, includePartner: !isV2 });
      }
    }
    if (request.policy) {
      const [existingPolicy] = await tx.select().from(teamPaymentPolicies).where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId), eq(teamPaymentPolicies.teamId, input.teamId))).limit(1).for("update");
      if (existingPolicy) {
        if (existingPolicy.defaultPolicy !== request.policy) {
          const [updated] = await tx.update(teamPaymentPolicies).set({ defaultPolicy: request.policy, currentRevision: existingPolicy.currentRevision + 1, updatedAt: new Date().toISOString() }).where(eq(teamPaymentPolicies.id, existingPolicy.id)).returning();
          await tx.insert(teamPaymentPolicyRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, policyId: existingPolicy.id, revisionNumber: updated.currentRevision, beforeSnapshot: existingPolicy, afterSnapshot: updated, recordedByUserId: input.actorUserId });
        }
      } else {
        const [created] = await tx.insert(teamPaymentPolicies).values({ organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, defaultPolicy: request.policy, recordedByUserId: input.actorUserId }).returning();
        await tx.insert(teamPaymentPolicyRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, policyId: created.id, revisionNumber: 1, beforeSnapshot: null, afterSnapshot: created, recordedByUserId: input.actorUserId });
      }
    }
    // Default materialization is centralized in the publication primitive.
    // Saving one team refreshes only that team's stable positions; incomplete
    // teams and unassigned positions do not block other configured evidence.
    const occurrences = await tx.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
      inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
    )).orderBy(asc(leagueOccurrences.startAt), asc(leagueOccurrences.id));
    try {
      await materializeRosterPaymentOccurrencesInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceIds: occurrences.map((occurrence) => occurrence.id),
        actorUserId: input.actorUserId,
        teamId: input.teamId,
        mode: "roster",
      });
    } catch (error) {
      if (error instanceof Error && error.message === "RESERVED_EVIDENCE_LOCKED") {
        throw new RosterPaymentError("OBLIGATION_RESERVED", "A payment operation has reserved this roster responsibility", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_OWNER_REVIEW_REQUIRED") {
        throw new RosterPaymentError("ROTATING_OWNER_REVIEW_REQUIRED", "A tender, refund, or dispute on this date requires review before ownership can be converted", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_OWNER_REFUND_EVIDENCE_PRESENT") {
        throw new RosterPaymentError("ROTATING_OWNER_REFUND_EVIDENCE_PRESENT", "A refund attempt or refund history exists for this date. Reconcile that evidence before converting ownership", 409);
      }
      if (error instanceof Error && error.message === "PAID_EVIDENCE_LOCKED") {
        throw new RosterPaymentError("PAID_EVIDENCE_LOCKED", "A responsibility with settled or partially settled evidence cannot be replaced", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_CONVERSION_RESPONSIBILITY_UNSUPPORTED") {
        throw new RosterPaymentError("ROTATING_CONVERSION_UNSUPPORTED", "Substitute and split responsibilities require financial reconciliation before the slot can rotate", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_CONVERSION_COMPONENTS_UNSUPPORTED") {
        throw new RosterPaymentError("ROTATING_CONVERSION_COMPONENTS_UNSUPPORTED", "This date has multiple payment components and cannot be converted to one rotating weekly share", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_CONVERSION_VOIDED_OBLIGATION") {
        throw new RosterPaymentError("ROTATING_CONVERSION_VOIDED_OBLIGATION", "This date has a voided financial obligation. Resolve its correction evidence before converting the slot", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_SCHEDULE_EVIDENCE_LOCKED") {
        throw new RosterPaymentError("ROTATING_SCHEDULE_EVIDENCE_LOCKED", "This rotating date has assignment or payment history and cannot be rescheduled until that evidence is reconciled", 409);
      }
      if (error instanceof Error && error.message === "ROTATING_OWNER_EVIDENCE_INVALID") {
        throw new RosterPaymentError("ROTATING_OWNER_EVIDENCE_INVALID", "Current payment ownership evidence is incomplete. Reconcile this date before converting the slot", 409);
      }
      throw error;
    }
    const result = isV2
      ? {
        contractVersion: "roster-payment-responsibility/2" as const,
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        teamId: input.teamId,
        ready: saved.every((row) => row.occupant !== "unassigned") && (!saved.some((row) => row.occupant === "rotating") || eligibleRotatingBowlerIds.length > 0),
        slots: saved,
        eligibleRotatingBowlerIds,
      }
      : { contractVersion: "roster-payment-responsibility/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, ready: saved.every((row) => row.occupant !== "unassigned"), slots: saved };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType, idempotencyKey: request.commandKey, result });
    return result;
  });
}

export async function saveTeamRosterV2(input: {
  organizationId: number;
  leagueId: number;
  teamId: number;
  actorUserId: number;
  request: RosterPaymentResponsibilityRequestV2 & { policy?: TeamPaymentPolicy };
}) {
  return saveTeamRoster(input);
}

export async function saveRotatingOccurrenceAssignments(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  request: RotatingOccurrenceAssignmentRequest;
}) {
  const expectedFingerprint = canonicalRotatingAssignmentFingerprint(input.request);
  if (input.request.requestFingerprint !== expectedFingerprint) {
    throw new RosterPaymentError("INVALID_FINGERPRINT", "The assignment request fingerprint is invalid", 422);
  }
  const league = await leagueScope(input.organizationId, input.leagueId);
  if (league.weeklyFee <= 0) throw new RosterPaymentError("ROTATING_FEE_UNAVAILABLE", "Rotating slots require a positive weekly fee", 409);
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const commandType = "roster_payment.save_rotating_assignments_v1";
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType,
      idempotencyKey: input.request.commandKey,
      requestFingerprint: input.request.requestFingerprint,
    });
    const ordered = [...input.request.assignments].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId)
      || a.teamId - b.teamId
      || a.slotIndex - b.slotIndex);
    const occurrenceIds = [...new Set(ordered.map((row) => row.occurrenceId))];
    const teamIds = [...new Set(ordered.map((row) => row.teamId))];
    const occurrences = await tx.select({
      id: leagueOccurrences.id,
      status: leagueOccurrences.status,
      lifecycle: leagueOccurrences.lifecycle,
    }).from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.id, occurrenceIds),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
      inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
    ));
    const occurrenceById = new Map(occurrences.map((row) => [row.id, row]));
    if (occurrenceById.size !== occurrenceIds.length) {
      throw new RosterPaymentError("CANONICAL_OCCURRENCE_NOT_FOUND", "Every rotating assignment must target a published canonical league date", 404);
    }
    const billingRows = await tx.select({ occurrenceId: leagueOccurrenceBillingTerms.occurrenceId })
      .from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
        eq(leagueOccurrenceBillingTerms.state, "published"),
        inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
        isNotNull(leagueOccurrenceBillingTerms.billingOrdinal),
      ));
    const billedOccurrences = new Set(billingRows.map((row) => row.occurrenceId));
    if (occurrenceIds.some((id) => !billedOccurrences.has(id))) {
      throw new RosterPaymentError("ROTATING_BILLING_ORDER_MISSING", "A selected date has no published billing order. Refresh the schedule before confirming participation.", 409);
    }
    const slots = await tx.select().from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, input.organizationId),
      eq(teamPaymentSlots.leagueId, input.leagueId),
      inArray(teamPaymentSlots.teamId, teamIds),
    )).orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex)).for("update");
    const slotByKey = new Map(slots.map((slot) => [`${slot.teamId}:${slot.slotIndex}`, slot]));
    const requestedTeams = await tx.select({ id: teams.id }).from(teams).where(and(
      eq(teams.leagueId, input.leagueId),
      eq(teams.active, true),
      inArray(teams.id, teamIds),
    ));
    if (requestedTeams.length !== teamIds.length) throw new RosterPaymentError("NOT_FOUND", "A selected team was not found in this league", 404);
    for (const row of ordered) {
      const slot = slotByKey.get(`${row.teamId}:${row.slotIndex}`);
      if (!slot || slot.occupant !== "rotating") {
        throw new RosterPaymentError("ROTATING_SLOT_NOT_FOUND", "The selected lineup position is not an active rotating slot", 409);
      }
    }
    const rotatingSlots = slots.filter((slot) => slot.occupant === "rotating");
    const rotatingTeamIds = [...new Set(rotatingSlots.map((slot) => slot.teamId))];
    const responsibilities = await tx.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
      inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceIds),
      inArray(occurrencePaymentResponsibilities.teamId, rotatingTeamIds),
    )).orderBy(asc(occurrencePaymentResponsibilities.occurrenceId), asc(occurrencePaymentResponsibilities.teamId), asc(occurrencePaymentResponsibilities.slotIndex), asc(occurrencePaymentResponsibilities.positionIndex)).for("update");
    const responsibilityByKey = new Map(responsibilities.map((responsibility) => [
      `${responsibility.occurrenceId}:${responsibility.teamId}:${responsibility.slotIndex}`,
      responsibility,
    ]));
    const targetResponsibilities = ordered.map((row) => {
      const responsibility = responsibilityByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
      if (!responsibility) throw new RosterPaymentError("ROTATING_RESPONSIBILITY_NOT_FOUND", "The selected date has no current rotating-slot responsibility. Save the team roster and retry.", 409);
      const slot = slotByKey.get(`${row.teamId}:${row.slotIndex}`);
      if (!slot || slot.occupant !== "rotating") {
        throw new RosterPaymentError("ROTATING_SLOT_NOT_FOUND", "The selected lineup position is not an active rotating slot", 409);
      }
      return { row, responsibility, slot };
    });
    const targetResponsibilityIds = [...new Set(targetResponsibilities.map((item) => item.responsibility.id))];
    const obligationRows = targetResponsibilityIds.length === 0 ? [] : await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.responsibilityId, targetResponsibilityIds),
    )).orderBy(asc(paymentObligations.id)).for("update");
    const ownersByObligation = await resolvePaymentObligationOwnersInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligations: obligationRows,
    });
    for (const { responsibility } of targetResponsibilities) {
      const openObligations = obligationRows.filter((obligation) => obligation.responsibilityId === responsibility.id
        && (obligation.state === "open" || obligation.state === "partially_settled"));
      if (openObligations.some((obligation) => {
        const owner = ownersByObligation.get(obligation.id);
        return owner?.kind !== "team" || owner.teamId !== responsibility.teamId;
      })) {
        throw new RosterPaymentError("ROTATING_OWNER_EVIDENCE_MISSING", "This rotating date is not backed by a team-owned balance. Save the team roster or resolve its payment evidence first.", 409);
      }
    }
    const assignmentRows = await tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
      inArray(rotatingOccurrenceAssignments.teamId, rotatingTeamIds),
    )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version)).for("update");
    const currentByKey = new Map<string, typeof assignmentRows[number]>();
    for (const assignment of assignmentRows) {
      const key = `${assignment.occurrenceId}:${assignment.teamId}:${assignment.slotIndex}`;
      if (!currentByKey.has(key)) currentByKey.set(key, assignment);
    }
    for (const { row, responsibility } of targetResponsibilities) {
      const current = currentByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
      if ((current?.version ?? null) !== row.expectedRevision) {
        throw new RosterPaymentError("ASSIGNMENT_REVISION_MISMATCH", "The lineup changed since it was loaded. Refresh and review before saving.", 409);
      }
      if (current && current.responsibilityId !== responsibility.id) {
        throw new RosterPaymentError("ROTATING_ASSIGNMENT_EVIDENCE_INVALID", "The current assignment does not match this canonical lineup position", 409);
      }
      if (current && current.actualBowlerId !== row.actualBowlerId && !row.correctionReason) {
        throw new RosterPaymentError("ROTATING_CORRECTION_REASON_REQUIRED", "Provide a reason when changing or clearing a confirmed rotating bowler", 422);
      }
      if (row.actualBowlerId !== null) {
        const [eligible] = await tx.select({ bowlerId: teamPaymentRotationMembers.bowlerId }).from(teamPaymentRotationMembers)
          .innerJoin(bowlers, and(
            eq(bowlers.id, teamPaymentRotationMembers.bowlerId),
            eq(bowlers.organizationId, input.organizationId),
            eq(bowlers.active, true),
          ))
          .innerJoin(bowlerLeagues, and(
            eq(bowlerLeagues.bowlerId, teamPaymentRotationMembers.bowlerId),
            eq(bowlerLeagues.leagueId, input.leagueId),
            eq(bowlerLeagues.teamId, row.teamId),
            eq(bowlerLeagues.active, true),
          ))
          .where(and(
            eq(teamPaymentRotationMembers.organizationId, input.organizationId),
            eq(teamPaymentRotationMembers.leagueId, input.leagueId),
            eq(teamPaymentRotationMembers.teamId, row.teamId),
            eq(teamPaymentRotationMembers.bowlerId, row.actualBowlerId),
            eq(teamPaymentRotationMembers.active, true),
          )).limit(1).for("share");
        if (!eligible) throw new RosterPaymentError("ROTATING_MEMBER_NOT_ELIGIBLE", "The selected bowler is not an active rotating member of this team", 422);
        const fixedMain = slots.find((slot) => slot.teamId === row.teamId && slot.occupant === "main" && slot.mainBowlerId === row.actualBowlerId);
        if (fixedMain) throw new RosterPaymentError("ROTATING_MAIN_OVERLAP", "A fixed Main bowler cannot be assigned to a rotating slot for the same date", 409);
      }
    }
    const actualBySlot = new Map<string, number | null>();
    for (const slot of rotatingSlots) {
      const slotKey = `${slot.teamId}:${slot.slotIndex}`;
      for (const occurrenceId of occurrenceIds) {
        const key = `${occurrenceId}:${slot.teamId}:${slot.slotIndex}`;
        actualBySlot.set(key, currentByKey.get(key)?.actualBowlerId ?? null);
      }
    }
    for (const { row } of targetResponsibilities) actualBySlot.set(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`, row.actualBowlerId);
    for (const occurrenceId of occurrenceIds) {
      for (const teamId of teamIds) {
        const participantsByPosition = new Map<number, Set<number>>();
        for (const responsibility of responsibilities) {
          if (responsibility.occurrenceId !== occurrenceId || responsibility.teamId !== teamId) continue;
          const slot = slots.find((candidate) => candidate.teamId === teamId && candidate.slotIndex === responsibility.slotIndex);
          if (!slot || slot.occupant === "rotating") continue;
          const participants = participantsByPosition.get(slot.slotIndex) ?? new Set<number>();
          for (const bowlerId of [responsibility.mainBowlerId, responsibility.substituteBowlerId, responsibility.payerBowlerId, responsibility.lineagePayerBowlerId, responsibility.prizePayerBowlerId]) {
            if (bowlerId !== null) participants.add(bowlerId);
          }
          participantsByPosition.set(slot.slotIndex, participants);
        }
        for (const slot of rotatingSlots) {
          if (slot.teamId !== teamId) continue;
          const actualBowlerId = actualBySlot.get(`${occurrenceId}:${teamId}:${slot.slotIndex}`) ?? null;
          if (actualBowlerId !== null) participantsByPosition.set(slot.slotIndex, new Set([actualBowlerId]));
        }
        const allAssigned = [...participantsByPosition.values()].flatMap((participants) => [...participants]);
        if (new Set(allAssigned).size !== allAssigned.length) {
          throw new RosterPaymentError("ROTATING_BOWLER_DUPLICATE_FOR_DATE", "A bowler can occupy only one paying position on a team for the same date", 409);
        }
      }
    }
    const changed = targetResponsibilities.filter(({ row }) => {
      const current = currentByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
      return current?.actualBowlerId !== row.actualBowlerId || !current;
    });
    const reopenedObligationIds = new Set<string>();
    const releasedCreditBowlerIds = new Set<number>();
    for (const { row } of changed) {
      const current = currentByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
      if (!current || current.actualBowlerId === null || current.actualBowlerId === row.actualBowlerId) continue;
      try {
        const reversed = await reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          assignmentId: current.id,
          actorUserId: input.actorUserId,
          reason: row.correctionReason ?? "Manager corrected rotating participation",
        });
        for (const obligationId of reversed) reopenedObligationIds.add(obligationId);
        if (reversed.length > 0) releasedCreditBowlerIds.add(current.actualBowlerId);
      } catch {
        throw new RosterPaymentError("ROTATING_CREDIT_REVERSAL_BLOCKED", "This assignment cannot be changed while its payment or credit evidence is under review. Resolve the tender review, refund, or dispute first.", 409);
      }
    }
    for (const obligationId of reopenedObligationIds) {
      const [obligation] = await tx.select().from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligationId),
      )).limit(1).for("update");
      if (!obligation) throw new RosterPaymentError("ROTATING_CREDIT_REVERSAL_EVIDENCE_INVALID", "A reversed credit allocation has no matching obligation", 503);
      const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        eq(paymentAllocations.obligationId, obligationId),
        eq(paymentAllocations.state, "active"),
      ));
      const activeAdjustments = active.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
        eq(refundAllocationAdjustments.organizationId, input.organizationId),
        eq(refundAllocationAdjustments.leagueId, input.leagueId),
        inArray(refundAllocationAdjustments.sourceAllocationId, active.map((allocation) => allocation.id)),
      ));
      const balance = canonicalObligationBalance({
        amountMinor: obligation.amountMinor,
        state: obligation.state,
        grossAllocatedMinor: active.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        adjustments: activeAdjustments.map((adjustment) => ({ amountMinor: adjustment.amountMinor, disposition: adjustment.disposition })),
      });
      const nextState = balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor === 0 ? "open" : "partially_settled";
      if (nextState !== obligation.state) await tx.update(paymentObligations).set({ state: nextState }).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligationId),
      ));
    }
    const savedAssignments: Array<typeof rotatingOccurrenceAssignments.$inferSelect> = [];
    for (const { row, responsibility, slot } of changed) {
      const current = currentByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
      const [created] = await tx.insert(rotatingOccurrenceAssignments).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: row.occurrenceId,
        teamId: row.teamId,
        slotId: slot.id,
        slotIndex: row.slotIndex,
        responsibilityId: responsibility.id,
        version: (current?.version ?? 0) + 1,
        actualBowlerId: row.actualBowlerId,
        correctionReason: row.correctionReason ?? null,
        recordedByUserId: input.actorUserId,
      }).returning();
      savedAssignments.push(created);
    }
    const creditApplicationIds: string[] = [];
    const newlyConfirmedBowlerIds = [...new Set([
      ...changed.flatMap(({ row }) => row.actualBowlerId === null ? [] : [row.actualBowlerId]),
      ...releasedCreditBowlerIds,
    ])].sort((a, b) => a - b);
    for (const bowlerId of newlyConfirmedBowlerIds) {
      try {
        creditApplicationIds.push(...await applyRotatingCreditToConfirmedObligationsInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          bowlerId,
          actorUserId: input.actorUserId,
        }));
      } catch {
        throw new RosterPaymentError("ROTATING_CREDIT_APPLICATION_BLOCKED", "The bowler was confirmed, but their available credit could not be applied because its ledger evidence requires review", 409);
      }
    }
    const result = {
      contractVersion: "rotating-occurrence-assignment/1" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      commandKey: input.request.commandKey,
      requestFingerprint: input.request.requestFingerprint,
      assignments: ordered.map((row) => {
        const current = currentByKey.get(`${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
        const created = savedAssignments.find((item) => item.occurrenceId === row.occurrenceId && item.teamId === row.teamId && item.slotIndex === row.slotIndex);
        return created ?? current ?? null;
      }),
      creditApplicationIds,
    };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType, idempotencyKey: input.request.commandKey, result });
    return result;
  });
}

export async function readCanonicalDuePastDue(input: { organizationId: number; leagueId: number; payerBowlerId?: number }): Promise<FinancialReadContract> {
  await leagueScope(input.organizationId, input.leagueId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (asOfResult.rows[0] as { as_of?: string } | undefined)?.as_of ?? new Date().toISOString();
    const now = new Date(asOf).getTime();
    const conditions = [eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)];
    if (input.payerBowlerId !== undefined) {
      conditions.push(eq(paymentObligations.payerBowlerId, input.payerBowlerId));
      conditions.push(isCurrentBowlerOwnedObligationSql({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        obligationId: paymentObligations.id,
        payerBowlerId: paymentObligations.payerBowlerId,
        bowlerId: input.payerBowlerId,
      }));
    }
    let obligations = await tx.select().from(paymentObligations).where(and(...conditions)).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id));
    if (input.payerBowlerId === undefined && obligations.length > 0) {
      const owners = await resolvePaymentObligationOwnersInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        obligations,
      });
      obligations = obligations.filter((obligation) => owners.get(obligation.id)?.kind === "bowler");
    }
    const responsibilities = obligations.length === 0 ? [] : await tx.select({ id: occurrencePaymentResponsibilities.id, teamId: occurrencePaymentResponsibilities.teamId }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, obligations.map((obligation) => obligation.responsibilityId)),
    ));
    const teamByResponsibilityId = new Map(responsibilities.map((responsibility) => [responsibility.id, responsibility.teamId]));
    if (responsibilities.length !== new Set(obligations.map((obligation) => obligation.responsibilityId)).size) {
      throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its canonical responsibility", 503);
    }
    const allocations = obligations.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, obligations.map((obligation) => obligation.id)),
    ));
    const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((allocation) => allocation.id)),
    ));
    const adjustmentsByAllocationId = new Map(adjustments.map((adjustment) => [adjustment.sourceAllocationId, adjustment]));
    const rows = obligations.map((obligation) => {
      if (obligation.payerBowlerId === null) {
        throw new RosterPaymentError("OWNER_EVIDENCE_INVALID", "A legacy due response cannot include a team-owned obligation", 503);
      }
      const linked = allocations.filter((allocation) => allocation.obligationId === obligation.id);
      const balance = canonicalObligationBalance({
        amountMinor: obligation.amountMinor,
        state: obligation.state,
        grossAllocatedMinor: linked.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        adjustments: linked.flatMap((allocation) => {
          const adjustment = adjustmentsByAllocationId.get(allocation.id);
          return adjustment ? [{ amountMinor: adjustment.amountMinor, disposition: adjustment.disposition }] : [];
        }),
      });
      const reviewRequired = linked.some((allocation) => allocation.reviewRequired);
      const classification = reviewRequired
        ? "review_required" as const
        : obligation.state === "voided"
          ? "voided" as const
          : balance.outstandingMinor === 0
          ? "settled" as const
          : now < new Date(obligation.dueAt).getTime()
            ? "future" as const
            : now < new Date(obligation.pastDueAt).getTime()
              ? "due" as const
              : "past_due" as const;
      const teamId = teamByResponsibilityId.get(obligation.responsibilityId);
      if (teamId === undefined) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its canonical team", 503);
      return { ...obligation, payerBowlerId: obligation.payerBowlerId, currency: "USD" as const, teamId, allocatedMinor: balance.effectiveAllocatedMinor, grossAllocatedMinor: balance.grossAllocatedMinor, refundedMinor: balance.refundedMinor, waivedMinor: balance.waivedMinor, stillOwed: balance.stillOwed, outstandingMinor: balance.outstandingMinor, classification, reviewRequired };
    });
    return {
    contractVersion: "canonical-due-past-due/2" as const,
    orderVersion: "due-at,payer,occurrence,obligation/2" as const,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    authoritativeSource: "payment_obligations" as const,
    asOf,
    rows,
    totals: {
      amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
      allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
      collectiblePastDueMinor: rows.filter((row) => row.classification === "past_due" && !row.reviewRequired).reduce((sum, row) => sum + row.outstandingMinor, 0),
      reviewCount: rows.filter((row) => row.reviewRequired).length,
      settledCount: rows.filter((row) => row.classification === "settled").length,
      voidedCount: rows.filter((row) => row.classification === "voided").length,
    },
    };
  });
}

export async function readCanonicalDuePastDueV3(input: { organizationId: number; leagueId: number; bowlerId?: number }): Promise<FinancialReadContractV3> {
  await leagueScope(input.organizationId, input.leagueId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    if (input.bowlerId !== undefined) {
      const [member] = await tx.select({ id: bowlers.id }).from(bowlers).innerJoin(bowlerLeagues, and(
        eq(bowlerLeagues.bowlerId, bowlers.id),
        eq(bowlerLeagues.leagueId, input.leagueId),
        eq(bowlerLeagues.active, true),
        isNotNull(bowlerLeagues.teamId),
      )).where(and(
        eq(bowlers.organizationId, input.organizationId),
        eq(bowlers.id, input.bowlerId),
        eq(bowlers.active, true),
      )).limit(1);
      if (!member) throw new RosterPaymentError("NOT_FOUND", "Bowler is not an active team member in this league", 404);
    }
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (asOfResult.rows[0] as { as_of?: string } | undefined)?.as_of ?? new Date().toISOString();
    const now = new Date(asOf).getTime();
    const obligations = await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id));
    const responsibilityIds = [...new Set(obligations.map((row) => row.responsibilityId))];
    const responsibilities = responsibilityIds.length === 0 ? [] : await tx.select({
      id: occurrencePaymentResponsibilities.id,
      teamId: occurrencePaymentResponsibilities.teamId,
      slotIndex: occurrencePaymentResponsibilities.slotIndex,
      occurrenceId: occurrencePaymentResponsibilities.occurrenceId,
      state: occurrencePaymentResponsibilities.state,
    }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
    ));
    const responsibilityById = new Map(responsibilities.map((row) => [row.id, row]));
    if (responsibilityById.size !== responsibilityIds.length) {
      throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its canonical responsibility", 503);
    }
    const owners = await resolvePaymentObligationOwnersInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligations,
    });
    const occurrenceIds = [...new Set(obligations.map((row) => row.occurrenceId))];
    const occurrenceRows = occurrenceIds.length === 0 ? [] : await tx.select({
      id: leagueOccurrences.id,
      occurrenceLocalDate: leagueOccurrences.authoritativeLocalDate,
      plannedOrdinal: leagueOccurrences.plannedOrdinal,
    }).from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.id, occurrenceIds),
    ));
    const occurrenceById = new Map(occurrenceRows.map((row) => [row.id, row]));
    const billingTerms = occurrenceIds.length === 0 ? [] : await tx.select({
      occurrenceId: leagueOccurrenceBillingTerms.occurrenceId,
      billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal,
    }).from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
      eq(leagueOccurrenceBillingTerms.state, "published"),
      inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
    ));
    const billingByOccurrence = new Map<string, number>();
    for (const row of billingTerms) {
      if (row.billingOrdinal !== null && !billingByOccurrence.has(row.occurrenceId)) billingByOccurrence.set(row.occurrenceId, row.billingOrdinal);
    }
    const teamIds = [...new Set(responsibilities.map((row) => row.teamId))];
    const assignmentRows = occurrenceIds.length === 0 || teamIds.length === 0 ? [] : await tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
      inArray(rotatingOccurrenceAssignments.teamId, teamIds),
    )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version));
    const latestAssignmentByKey = new Map<string, typeof assignmentRows[number]>();
    for (const assignment of assignmentRows) {
      const key = `${assignment.occurrenceId}:${assignment.teamId}:${assignment.slotIndex}`;
      if (!latestAssignmentByKey.has(key)) latestAssignmentByKey.set(key, assignment);
    }
    const assignmentByResponsibility = new Map<string, typeof assignmentRows[number]>();
    for (const responsibility of responsibilities) {
      const assignment = latestAssignmentByKey.get(`${responsibility.occurrenceId}:${responsibility.teamId}:${responsibility.slotIndex}`);
      if (!assignment) continue;
      if (assignment.responsibilityId !== responsibility.id) {
        const hasCurrentTeamLiability = responsibility.state === "active" && obligations.some((obligation) =>
          obligation.responsibilityId === responsibility.id
          && (obligation.state === "open" || obligation.state === "partially_settled")
          && owners.get(obligation.id)?.kind === "team");
        if (hasCurrentTeamLiability) {
          throw new RosterPaymentError("ROTATING_ASSIGNMENT_EVIDENCE_INVALID", "An active team obligation does not match its current assignment responsibility", 503);
        }
        continue;
      }
      assignmentByResponsibility.set(responsibility.id, assignment);
    }
    const allocations = obligations.length === 0 ? [] : await tx.select({
      id: paymentAllocations.id,
      paymentId: paymentAllocations.paymentId,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      reviewRequired: paymentAllocations.reviewRequired,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, obligations.map((row) => row.id)),
    ));
    const adjustments = allocations.length === 0 ? [] : await tx.select({
      sourceAllocationId: refundAllocationAdjustments.sourceAllocationId,
      amountMinor: refundAllocationAdjustments.amountMinor,
      disposition: refundAllocationAdjustments.disposition,
    }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
    ));
    const adjustmentsByAllocation = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
    const allocationsByObligation = new Map<string, typeof allocations>();
    for (const allocation of allocations) allocationsByObligation.set(allocation.obligationId, [...(allocationsByObligation.get(allocation.obligationId) ?? []), allocation]);
    const paymentIds = [...new Set(allocations.map((row) => row.paymentId))];
    const paymentRows = paymentIds.length === 0 ? [] : await tx.select({
      id: payments.id,
      status: payments.status,
      disputeId: payments.disputeId,
      disputedAt: payments.disputedAt,
      paymentOperationId: payments.paymentOperationId,
    }).from(payments).where(and(
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
      inArray(payments.id, paymentIds),
    ));
    const paymentById = new Map(paymentRows.map((row) => [row.id, row]));
    const paymentOperationIds = [...new Set(paymentRows.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []))];
    const disputeRows = paymentOperationIds.length === 0 ? [] : await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, input.organizationId),
      inArray(paymentDisputes.paymentOperationId, paymentOperationIds),
      sql`${paymentDisputes.state} NOT IN ('WON', 'INQUIRY_CLOSED')`,
    ));
    const disputedOperations = new Set(disputeRows.map((row) => row.operationId));
    const operationRows = paymentOperationIds.length === 0 ? [] : await tx.select({ id: paymentOperations.id, status: paymentOperations.status }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      inArray(paymentOperations.id, paymentOperationIds),
    ));
    const operationById = new Map(operationRows.map((row) => [row.id, row]));
    const unresolvedRefundRows = paymentIds.length === 0 ? [] : await tx.select({ paymentId: refundPaymentOperationSnapshots.paymentId }).from(refundPaymentOperationSnapshots)
      .innerJoin(paymentOperations, and(
        eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      )).where(and(
        eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
        inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
        inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"] as const),
      ));
    const unresolvedRefundPaymentIds = new Set(unresolvedRefundRows.map((row) => row.paymentId));
    const allRows: FinancialReadRowContractV3[] = [];
    for (const obligation of obligations) {
      const owner = owners.get(obligation.id);
      const responsibility = responsibilityById.get(obligation.responsibilityId);
      const occurrence = occurrenceById.get(obligation.occurrenceId);
      if (!owner || !responsibility || !occurrence || occurrence.occurrenceLocalDate === null) {
        throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing canonical owner or date evidence", 503);
      }
      const billingOrdinal = billingByOccurrence.get(obligation.occurrenceId) ?? occurrence.plannedOrdinal;
      if (owner.kind === "team" && (obligation.state === "open" || obligation.state === "partially_settled")
        && !billingByOccurrence.has(obligation.occurrenceId)) {
        throw new RosterPaymentError("ROTATING_BILLING_ORDER_MISSING", "An obligation has no published canonical billing order", 503);
      }
      if (owner.kind === "bowler" && obligation.payerBowlerId === null) {
        throw new RosterPaymentError("OWNER_EVIDENCE_INVALID", "A bowler-owned obligation has no historical payer", 503);
      }
      const linked = allocationsByObligation.get(obligation.id) ?? [];
      const balance = canonicalObligationBalance({
        amountMinor: obligation.amountMinor,
        state: obligation.state,
        grossAllocatedMinor: linked.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        adjustments: linked.flatMap((allocation) => {
          const adjustment = adjustmentsByAllocation.get(allocation.id);
          return adjustment ? [{ amountMinor: adjustment.amountMinor, disposition: adjustment.disposition }] : [];
        }),
      });
      let reviewRequired = linked.some((allocation) => allocation.reviewRequired);
      for (const allocation of linked) {
        const payment = paymentById.get(allocation.paymentId);
        if (!payment) {
          reviewRequired = true;
          continue;
        }
        if (payment.disputeId !== null || payment.disputedAt !== null || payment.status === "disputed") reviewRequired = true;
        if (payment.paymentOperationId) {
          const operation = operationById.get(payment.paymentOperationId);
          if (!operation || operation.status !== "succeeded" || disputedOperations.has(payment.paymentOperationId)) reviewRequired = true;
        }
        if (unresolvedRefundPaymentIds.has(payment.id)) reviewRequired = true;
      }
      const assignment = assignmentByResponsibility.get(responsibility.id);
      const actualBowlerId = owner.kind === "team" ? assignment?.actualBowlerId ?? null : null;
      if (input.bowlerId !== undefined && !(owner.kind === "bowler" && owner.bowlerId === input.bowlerId)
        && !(owner.kind === "team" && actualBowlerId === input.bowlerId)) continue;
      const classification = reviewRequired
        ? "review_required" as const
        : obligation.state === "voided"
          ? "voided" as const
          : balance.outstandingMinor === 0
            ? "settled" as const
            : now < new Date(obligation.dueAt).getTime()
              ? "future" as const
              : now < new Date(obligation.pastDueAt).getTime()
                ? "due" as const
                : "past_due" as const;
      const plannedOrdinal = occurrence.plannedOrdinal ?? billingByOccurrence.get(obligation.occurrenceId) ?? 0;
      const effectiveBillingOrdinal = billingByOccurrence.get(obligation.occurrenceId) ?? plannedOrdinal;
      allRows.push({
        id: obligation.id,
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: obligation.occurrenceId,
        responsibilityId: obligation.responsibilityId,
        teamId: responsibility.teamId,
        slotIndex: responsibility.slotIndex,
        component: obligation.component,
        payerBowlerId: obligation.payerBowlerId,
        owner,
        actualBowlerId,
        occurrenceLocalDate: occurrence.occurrenceLocalDate,
        plannedOrdinal,
        billingOrdinal: effectiveBillingOrdinal,
        amountMinor: obligation.amountMinor,
        currency: "USD",
        dueAt: obligation.dueAt,
        pastDueAt: obligation.pastDueAt,
        state: obligation.state,
        allocatedMinor: balance.effectiveAllocatedMinor,
        grossAllocatedMinor: balance.grossAllocatedMinor,
        refundedMinor: balance.refundedMinor,
        waivedMinor: balance.waivedMinor,
        stillOwed: balance.stillOwed,
        outstandingMinor: balance.outstandingMinor,
        classification,
        reviewRequired,
      });
    }
    allRows.sort((a, b) => a.dueAt.localeCompare(b.dueAt)
      || (a.owner.kind === "team" ? `team:${a.owner.teamId}` : `bowler:${a.owner.bowlerId}`).localeCompare(b.owner.kind === "team" ? `team:${b.owner.teamId}` : `bowler:${b.owner.bowlerId}`)
      || a.occurrenceId.localeCompare(b.occurrenceId)
      || a.id.localeCompare(b.id));
    return {
      contractVersion: "canonical-due-past-due/3" as const,
      orderVersion: "due-at,owner,occurrence,obligation/3" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      authoritativeSource: "payment_obligations" as const,
      asOf,
      rows: allRows,
      totals: {
        amountMinor: allRows.reduce((sum, row) => sum + row.amountMinor, 0),
        allocatedMinor: allRows.reduce((sum, row) => sum + row.allocatedMinor, 0),
        outstandingMinor: allRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
        collectiblePastDueMinor: allRows.filter((row) => row.classification === "past_due" && !row.reviewRequired).reduce((sum, row) => sum + row.outstandingMinor, 0),
        reviewCount: allRows.filter((row) => row.reviewRequired).length,
        settledCount: allRows.filter((row) => row.classification === "settled").length,
        voidedCount: allRows.filter((row) => row.classification === "voided").length,
      },
    };
  });
}

/** Resolve one published occurrence from explicit roster payment evidence. */
export async function recordOccurrenceResponsibilities(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  commandKey: string;
  requestFingerprint: string;
  responsibilities: OccurrenceResponsibilityInput[];
  transaction?: RosterPaymentTransaction;
}) {
    const league = await leagueScope(input.organizationId, input.leagueId);
    if (league.payingLineupSize === null) throw new RosterPaymentError("INCOMPLETE_ROSTER", "League lineup size is not configured", 422);
    const lineupSize = league.payingLineupSize;
  if (input.requestFingerprint !== canonicalResponsibilityFingerprint(input.responsibilities)) throw new RosterPaymentError("INVALID_FINGERPRINT", "The responsibility request fingerprint is invalid", 422);
  const run = async (tx: RosterPaymentTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const requestedTeamIds = [...new Set(input.responsibilities.map((row) => row.teamId))];
    const requestedPositionKeys = new Set(input.responsibilities.map((row) => `${row.teamId}:${row.slotIndex}`));
    const rotatingTargets = requestedTeamIds.length === 0 ? [] : await tx.select({ teamId: teamPaymentSlots.teamId, slotIndex: teamPaymentSlots.slotIndex }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, input.organizationId),
      eq(teamPaymentSlots.leagueId, input.leagueId),
      inArray(teamPaymentSlots.teamId, requestedTeamIds),
      eq(teamPaymentSlots.occupant, "rotating"),
    ));
    if (rotatingTargets.some((slot) => requestedPositionKeys.has(`${slot.teamId}:${slot.slotIndex}`))) {
      throw new RosterPaymentError("ROTATING_CONFIGURATION_REQUIRES_V2", "Use the roster contract v2 to manage a rotating position", 409);
    }
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.record_responsibilities",
      idempotencyKey: input.commandKey,
      requestFingerprint: input.requestFingerprint,
    });
    const occurrenceIds = [...new Set(input.responsibilities.map((row) => row.occurrenceId))];
    const occurrences = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, status: leagueOccurrences.status }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), inArray(leagueOccurrences.id, occurrenceIds), inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const), inArray(leagueOccurrences.status, ["scheduled", "completed"] as const)));
    if (occurrences.length !== occurrenceIds.length) throw new RosterPaymentError("OCCURRENCE_NOT_PUBLISHED", "Responsibilities require published canonical occurrences", 422);
    const teamIds = [...new Set(input.responsibilities.map((row) => row.teamId))];
    const slots = await tx.select().from(teamPaymentSlots).where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId), inArray(teamPaymentSlots.teamId, teamIds))).orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
    const activeResponsibilities = await tx.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, teamId: occurrencePaymentResponsibilities.teamId, slotIndex: occurrencePaymentResponsibilities.slotIndex, positionIndex: occurrencePaymentResponsibilities.positionIndex, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, substituteBowlerId: occurrencePaymentResponsibilities.substituteBowlerId }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceIds),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    const rotatingSlotRows = teamIds.length === 0 ? [] : await tx.select({ teamId: teamPaymentSlots.teamId, slotIndex: teamPaymentSlots.slotIndex }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, input.organizationId),
      eq(teamPaymentSlots.leagueId, input.leagueId),
      inArray(teamPaymentSlots.teamId, teamIds),
      eq(teamPaymentSlots.occupant, "rotating"),
    ));
    const rotatingTeamIds = [...new Set(rotatingSlotRows.map((slot) => slot.teamId))];
    const rotatingAssignments = occurrenceIds.length === 0 || rotatingTeamIds.length === 0 ? [] : await tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
      inArray(rotatingOccurrenceAssignments.teamId, rotatingTeamIds),
    )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version)).for("share");
    const latestRotationBySlot = new Map<string, typeof rotatingAssignments[number]>();
    for (const assignment of rotatingAssignments) {
      const key = `${assignment.occurrenceId}:${assignment.teamId}:${assignment.slotIndex}`;
      if (!latestRotationBySlot.has(key)) latestRotationBySlot.set(key, assignment);
    }
    const rotatingParticipantKeys = new Set([...latestRotationBySlot.values()].flatMap((assignment) => assignment.actualBowlerId === null
      ? []
      : [`${assignment.occurrenceId}:${assignment.actualBowlerId}`]));
    const seenPositions = new Set<string>();
    const seenSubs = new Set<string>();
    const seenBowlers = new Set<string>();
    const mainRosterBowlerIds = new Set(slots.filter((slot) => slot.occupant === "main" && slot.mainBowlerId !== null).map((slot) => slot.mainBowlerId as number));
    const result = [];
    for (const row of input.responsibilities) {
      const slot = slots.find((candidate) => candidate.teamId === row.teamId && candidate.slotIndex === row.slotIndex);
      if (!slot) throw new RosterPaymentError("INVALID_SLOT", "Responsibility slot is not part of this team roster", 422);
      if (slot.occupant === "unassigned") throw new RosterPaymentError("INCOMPLETE_ROSTER", "A responsibility target slot must be configured", 422);
      if (row.positionIndex >= lineupSize) throw new RosterPaymentError("INVALID_POSITION", "Position is outside the configured paying lineup", 422);
      const positionKey = `${row.occurrenceId}:${row.teamId}:${row.positionIndex}`;
      if (seenPositions.has(positionKey)) throw new RosterPaymentError("DUPLICATE_POSITION", "A bowler may occupy only one position per occurrence", 422);
      seenPositions.add(positionKey);
      if (row.kind === "substitute" || row.kind === "split") {
        if (!row.substituteBowlerId || row.substituteBowlerId === slot.mainBowlerId) throw new RosterPaymentError("INVALID_SUBSTITUTE", "A substitute must be an active non-Main league member", 422);
        if (mainRosterBowlerIds.has(row.substituteBowlerId)) throw new RosterPaymentError("DUPLICATE_POSITION", "A Main bowler cannot also fill a Substitute position", 422);
        const subKey = `${row.occurrenceId}:${row.teamId}:${row.slotIndex}`;
        if (seenSubs.has(subKey)) throw new RosterPaymentError("DUPLICATE_SUBSTITUTE", "Only one Substitute may fill a slot", 422);
        seenSubs.add(subKey);
        const substituteMembership = await tx.select({ teamId: bowlerLeagues.teamId }).from(bowlerLeagues).where(and(
          eq(bowlerLeagues.bowlerId, row.substituteBowlerId),
          eq(bowlerLeagues.leagueId, input.leagueId),
          eq(bowlerLeagues.active, true),
          league.substituteAccess === "team_only" ? eq(bowlerLeagues.teamId, row.teamId) : undefined,
        )).limit(1);
        if (substituteMembership.length === 0) {
          throw new RosterPaymentError("SUBSTITUTE_ACCESS_DENIED", "This substitute is not eligible for the selected team", 422);
        }
      }
      if (row.kind === "main" && slot.occupant !== "main") throw new RosterPaymentError("MAIN_NOT_ASSIGNED", "A Main responsibility requires a Main slot", 422);
      if (row.kind === "vacant" && slot.occupant !== "vacant") throw new RosterPaymentError("VACANT_NOT_ASSIGNED", "VACANT evidence requires an explicit VACANT slot", 422);
      if (row.kind === "vacant" && (row.mainBowlerId != null || row.substituteBowlerId != null || row.payerBowlerId != null)) throw new RosterPaymentError("VACANT_IDENTITY_FORBIDDEN", "VACANT evidence cannot contain a bowler identity", 422);
      if (row.kind === "main" && row.mainBowlerId !== null && row.mainBowlerId !== undefined && row.mainBowlerId !== slot.mainBowlerId) throw new RosterPaymentError("MAIN_MISMATCH", "Main responsibility does not match the stable roster slot", 422);
      if ((row.kind === "substitute" || row.kind === "split") && row.mainBowlerId !== null && row.mainBowlerId !== undefined && row.mainBowlerId !== slot.mainBowlerId) throw new RosterPaymentError("MAIN_MISMATCH", "Substitute responsibility does not match the stable roster Main", 422);
      if (row.kind === "split" && league.substitutePaymentRegime !== "league_lineage_prize_split") throw new RosterPaymentError("POLICY_NOT_AVAILABLE", "Split responsibility requires the league lineage/prize split regime", 422);
      if (row.kind === "substitute" && row.policy === "special_split") throw new RosterPaymentError("INVALID_SPLIT", "Special split responsibilities must use kind=split", 422);
      if (row.kind === "split" && (!row.substituteBowlerId || !slot.mainBowlerId || row.amountMinor <= 0 || row.substituteBowlerId === slot.mainBowlerId)) throw new RosterPaymentError("INVALID_SPLIT", "Split responsibility requires distinct Main and Substitute", 422);
      // A stable VACANT slot is itself valid zero-obligation evidence. A
      // Substitute may additionally fill it for an occurrence, in which case
      // the substitute row is the billable responsibility.
      if (slot.occupant === "vacant" && row.kind !== "substitute" && row.kind !== "vacant") throw new RosterPaymentError("VACANT_REQUIRES_SUBSTITUTE", "A VACANT slot can only be filled by a Substitute", 422);
      if (slot.occupant === "vacant" && row.kind === "substitute" && !row.substituteBowlerId) throw new RosterPaymentError("INVALID_SUBSTITUTE", "A Substitute is required to fill a VACANT slot", 422);
      const effectivePolicy = slot.occupant === "vacant" && row.kind === "substitute" ? "sub_pays_full" as const : row.policy;
      const occurrence = occurrences.find((candidate) => candidate.id === row.occurrenceId);
      if (!occurrence) throw new RosterPaymentError("OCCURRENCE_NOT_PUBLISHED", "Occurrence not found", 422);
      const { dueAt: authoritativeDueAt, pastDueAt: authoritativePastDueAt } = await deriveRosterPaymentTimingInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentMode: league.paymentMode,
        occurrenceStartAt: occurrence.startAt,
      });
      const authoritativeAmountMinor = row.kind === "vacant" ? 0 : league.weeklyFee;
      if (row.kind === "split" && (league.lineageFee === null || league.prizeFundFee === null)) throw new RosterPaymentError("INVALID_SPLIT", "The league split fees are not configured", 422);
      const candidateBowlerIds = [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId].filter((id): id is number => id !== null && id !== undefined);
      if (candidateBowlerIds.length > 0) {
        const members = await tx.select({ id: bowlers.id }).from(bowlers).innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true))).where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true), inArray(bowlers.id, [...new Set(candidateBowlerIds)])));
        if (members.length !== new Set(candidateBowlerIds).size) throw new RosterPaymentError("BOWLER_NOT_IN_LEAGUE", "Responsibility bowler is not an active league member", 422);
      }
      const mainBowlerId = row.mainBowlerId ?? slot.mainBowlerId ?? null;
      const payerBowlerId = row.kind === "vacant" ? null : (row.payerBowlerId ?? (row.kind === "substitute" ? row.substituteBowlerId : mainBowlerId));
      if ((row.kind === "main" || row.kind === "split") && row.mainBowlerId != null && row.mainBowlerId !== slot.mainBowlerId) throw new RosterPaymentError("MAIN_MISMATCH", "Responsibility does not match the stable roster Main", 422);
      if (row.kind === "main" && payerBowlerId !== mainBowlerId) throw new RosterPaymentError("PAYER_POLICY_MISMATCH", "Main positions are always paid by Main", 422);
      if (row.kind === "substitute" && effectivePolicy === "main_pays_full" && payerBowlerId !== mainBowlerId) throw new RosterPaymentError("PAYER_POLICY_MISMATCH", "Main-pays policy requires the Main bowler as payer", 422);
      if (row.kind === "substitute" && effectivePolicy === "sub_pays_full" && payerBowlerId !== row.substituteBowlerId) throw new RosterPaymentError("PAYER_POLICY_MISMATCH", "Sub-pays policy requires the Substitute as payer", 422);
      const lineageAmountMinor = row.kind === "split" ? league.lineageFee : null;
      const prizeFundAmountMinor = row.kind === "split" ? league.prizeFundFee : null;
      if (row.kind === "split" && (lineageAmountMinor === null || prizeFundAmountMinor === null || lineageAmountMinor < 0 || prizeFundAmountMinor < 0 || lineageAmountMinor + prizeFundAmountMinor !== authoritativeAmountMinor)) {
        throw new RosterPaymentError("INVALID_SPLIT", "Split components must equal the selected occurrence amount", 422);
      }
      if (row.kind === "split" && (row.policy !== "special_split" || payerBowlerId === null)) throw new RosterPaymentError("INVALID_SPLIT", "Split responsibility requires the special split policy", 422);
      if (row.kind === "split" && payerBowlerId !== row.substituteBowlerId) throw new RosterPaymentError("PAYER_POLICY_MISMATCH", "Split responsibility is paid by the Substitute lineage payer", 422);
      const actualBowlerId = row.kind === "substitute" || row.kind === "split" ? row.substituteBowlerId : mainBowlerId;
      if (actualBowlerId !== null && actualBowlerId !== undefined) {
        const actualKey = `${row.occurrenceId}:${actualBowlerId}`;
        if (seenBowlers.has(actualKey)) throw new RosterPaymentError("DUPLICATE_POSITION", "A bowler may occupy only one position per occurrence", 422);
        if (rotatingParticipantKeys.has(actualKey)) throw new RosterPaymentError("DUPLICATE_POSITION", "A bowler cannot be confirmed on both a rotating and fixed paying position for the same date", 422);
        if (activeResponsibilities.some((candidate) => candidate.occurrenceId === row.occurrenceId
          && (candidate.teamId !== row.teamId || candidate.slotIndex !== row.slotIndex || candidate.positionIndex !== row.positionIndex)
          && (candidate.mainBowlerId === actualBowlerId || candidate.substituteBowlerId === actualBowlerId))) {
          throw new RosterPaymentError("DUPLICATE_POSITION", "A bowler may occupy only one position per occurrence", 422);
        }
        seenBowlers.add(actualKey);
      }
      const [activeResponsibility] = await tx.select().from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
        eq(occurrencePaymentResponsibilities.occurrenceId, row.occurrenceId),
        eq(occurrencePaymentResponsibilities.teamId, row.teamId),
        eq(occurrencePaymentResponsibilities.slotIndex, row.slotIndex),
        eq(occurrencePaymentResponsibilities.positionIndex, row.positionIndex),
        eq(occurrencePaymentResponsibilities.state, "active"),
      )).limit(1).for("update");
      // Responsibility identities are append-only and versioned. A previous
      // roster resolution for the same canonical occurrence may already be
      // voided, so a fresh active resolution must continue at the next
      // version instead of retrying the historical version-1 key.
      const [latestResponsibility] = activeResponsibility ? [activeResponsibility] : await tx.select().from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
        eq(occurrencePaymentResponsibilities.occurrenceId, row.occurrenceId),
        eq(occurrencePaymentResponsibilities.teamId, row.teamId),
        eq(occurrencePaymentResponsibilities.slotIndex, row.slotIndex),
        eq(occurrencePaymentResponsibilities.positionIndex, row.positionIndex),
      )).orderBy(desc(occurrencePaymentResponsibilities.version)).limit(1).for("update");
      let version = 1;
      let responsibilityKey: string | undefined;
      if (activeResponsibility) {
        try {
          await assertOpenRosterEvidenceCanBeReplaced(tx, {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
          }, activeResponsibility.id);
        } catch (error) {
          if (error instanceof Error && error.message === "RESERVED_EVIDENCE_LOCKED") {
            throw new RosterPaymentError("OBLIGATION_RESERVED", "A standing payment operation has reserved this roster responsibility", 409);
          }
          if (error instanceof Error && error.message === "PAID_EVIDENCE_LOCKED") {
            throw new RosterPaymentError("PAID_EVIDENCE_LOCKED", "A responsibility with settled or partially settled evidence cannot be replaced", 409);
          }
          throw error;
        }
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, activeResponsibility.id));
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
          eq(paymentObligations.responsibilityId, activeResponsibility.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          inArray(paymentObligations.state, ["open", "partially_settled"] as const),
        ));
      }
      if (latestResponsibility) {
        version = latestResponsibility.version + 1;
        responsibilityKey = latestResponsibility.responsibilityKey;
      }
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: row.occurrenceId, teamId: row.teamId, slotId: slot.id, slotIndex: row.slotIndex, positionIndex: row.positionIndex, ...(responsibilityKey ? { responsibilityKey } : {}), version, state: "active", responsibilityKind: row.kind, mainBowlerId, substituteBowlerId: row.substituteBowlerId ?? null, payerBowlerId, lineagePayerBowlerId: row.kind === "split" ? row.substituteBowlerId : null, prizePayerBowlerId: row.kind === "split" ? mainBowlerId : null, policy: effectivePolicy, amountMinor: authoritativeAmountMinor, lineageAmountMinor, prizeFundAmountMinor, currency: "USD", dueAt: authoritativeDueAt, pastDueAt: authoritativePastDueAt, assignmentNote: row.assignmentNote ?? null, recordedByUserId: input.actorUserId }).returning();
      const obligations = [];
      if (responsibility.payerBowlerId !== null && responsibility.amountMinor > 0 && row.kind !== "split") {
        const [obligation] = await tx.insert(paymentObligations).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: row.occurrenceId, responsibilityId: responsibility.id, component: "full", payerBowlerId: responsibility.payerBowlerId, amountMinor: responsibility.amountMinor, currency: "USD", dueAt: authoritativeDueAt, pastDueAt: authoritativePastDueAt, state: "open", createdByUserId: input.actorUserId }).returning();
        obligations.push(obligation);
      } else if (row.kind === "split" && responsibility.lineagePayerBowlerId !== null && responsibility.prizePayerBowlerId !== null && responsibility.lineageAmountMinor !== null && responsibility.prizeFundAmountMinor !== null) {
        const components = [{ component: "lineage" as const, payerBowlerId: responsibility.lineagePayerBowlerId, amountMinor: responsibility.lineageAmountMinor }, { component: "prize" as const, payerBowlerId: responsibility.prizePayerBowlerId, amountMinor: responsibility.prizeFundAmountMinor }];
        for (const component of components.filter((value) => value.amountMinor > 0)) {
          const [obligation] = await tx.insert(paymentObligations).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: row.occurrenceId, responsibilityId: responsibility.id, component: component.component, payerBowlerId: component.payerBowlerId, amountMinor: component.amountMinor, currency: "USD", dueAt: authoritativeDueAt, pastDueAt: authoritativePastDueAt, state: "open", createdByUserId: input.actorUserId }).returning();
          obligations.push(obligation);
        }
      }
      result.push({ responsibility, obligation: obligations[0] ?? null, obligations });
    }
    const response = { contractVersion: "roster-payment-responsibility/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, commandKey: input.commandKey, requestFingerprint: input.requestFingerprint, responsibilities: result };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.record_responsibilities", idempotencyKey: input.commandKey, result: response });
    return response;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

export type FifoPaymentCandidate = BaseFifoPaymentCandidate & {
  id: string;
  responsibilityId: string;
  occurrenceId: string;
  amountMinor: number;
  state: "open" | "partially_settled" | "settled" | "voided";
  outstandingMinor: number;
  dueAt: string;
  pastDueAt: string;
  payerBowlerId: number;
  currency: "USD";
  memberOrdinal: number;
  billingOrdinal: number;
  reservedMinor: number;
  reviewRequired: boolean;
  /** Published pair evidence; FIFO uses the trigger's effective timestamp
   * even before the trigger occurrence is due. */
  pairedCollectionReady: boolean;
  effectiveCollectionAt: string;
  /** Stored schedule labels; callers must not reconstruct them from dueAt. */
  occurrenceLocalDate?: string | null;
  plannedOrdinal?: number | null;
};

/** Pure FIFO allocator used by the transaction-bound quote and finalizer. */
export function allocateAutomaticFifoPayment(
  amountMinor: number,
  candidates: FifoPaymentCandidate[],
): Array<{ obligationId: string; amountMinor: number }> {
  try { return allocateFifo(amountMinor, candidates); }
  catch (error) {
    if (error instanceof AutomaticFifoAllocationError) throw new RosterPaymentError(error.code, error.message, error.status);
    throw error;
  }
}

type FifoQuoteInput = {
  amountMinor: number;
  payerBowlerId: number;
  transaction?: RosterPaymentTransaction;
};

export async function fifoCandidatesInTransaction(
  tx: RosterPaymentTransaction,
  input: { organizationId: number; leagueId: number; payerBowlerId: number; includeSettledObligationIds?: string[] },
): Promise<FifoPaymentCandidate[]> {
  const stateFilter = input.includeSettledObligationIds && input.includeSettledObligationIds.length > 0
    ? or(
      inArray(paymentObligations.state, ["open", "partially_settled"] as const),
      and(inArray(paymentObligations.id, input.includeSettledObligationIds), eq(paymentObligations.state, "settled")),
    )
    : inArray(paymentObligations.state, ["open", "partially_settled"] as const);
  const rows = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    eq(paymentObligations.payerBowlerId, input.payerBowlerId),
    isCurrentBowlerOwnedObligationSql({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligationId: paymentObligations.id,
      payerBowlerId: paymentObligations.payerBowlerId,
      bowlerId: input.payerBowlerId,
    }),
    stateFilter,
  )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  if (rows.length === 0) return [];
  const responsibilityIds = [...new Set(rows.map((row) => row.responsibilityId))];
  const responsibilities = await tx.select({
    id: occurrencePaymentResponsibilities.id,
    teamId: occurrencePaymentResponsibilities.teamId,
    slotIndex: occurrencePaymentResponsibilities.slotIndex,
    state: occurrencePaymentResponsibilities.state,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
  ));
  if (responsibilities.length !== responsibilityIds.length || responsibilities.some((row) => row.state !== "active")) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing active canonical responsibility evidence", 503);
  }
  const occurrenceIds = [...new Set(rows.map((row) => row.occurrenceId))];
  const occurrenceRows = await tx.select({
    id: leagueOccurrences.id,
    authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate,
    plannedOrdinal: leagueOccurrences.plannedOrdinal,
  }).from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
    inArray(leagueOccurrences.id, occurrenceIds),
  ));
  if (occurrenceRows.length !== occurrenceIds.length) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its authoritative occurrence labels", 503);
  }
  const occurrenceById = new Map(occurrenceRows.map((row) => [row.id, row]));
  const groupRows = await tx.select({
    groupId: canonicalCollectionGroups.id,
    state: canonicalCollectionGroups.state,
    memberId: canonicalCollectionGroupMembers.id,
    occurrenceId: canonicalCollectionGroupMembers.occurrenceId,
    role: canonicalCollectionGroupMembers.role,
    memberOrdinal: canonicalCollectionGroupMembers.memberOrdinal,
    billingOrdinal: canonicalCollectionGroupMembers.billingOrdinal,
  }).from(canonicalCollectionGroupMembers).innerJoin(canonicalCollectionGroups, and(
    eq(canonicalCollectionGroups.id, canonicalCollectionGroupMembers.groupId),
    eq(canonicalCollectionGroups.organizationId, input.organizationId),
    eq(canonicalCollectionGroups.leagueId, input.leagueId),
    eq(canonicalCollectionGroups.state, "published"),
  )).where(and(
    eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
    eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
    eq(canonicalCollectionGroupMembers.active, true),
    inArray(canonicalCollectionGroupMembers.occurrenceId, occurrenceIds),
  ));
  const groupByOccurrence = new Map(groupRows.map((row) => [row.occurrenceId, row]));
  const billingTerms = await tx.select({
    occurrenceId: leagueOccurrenceBillingTerms.occurrenceId,
    billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal,
  }).from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
    eq(leagueOccurrenceBillingTerms.state, "published"),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
  ));
  const billingByOccurrence = new Map<string, number>();
  for (const term of billingTerms) {
    if (term.billingOrdinal === null) continue;
    if (billingByOccurrence.has(term.occurrenceId)) {
      throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "Each payable occurrence must have exactly one published billing ordinal", 503);
    }
    billingByOccurrence.set(term.occurrenceId, term.billingOrdinal);
  }
  if (occurrenceIds.some((occurrenceId) => !billingByOccurrence.has(occurrenceId))) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its published billing ordinal", 503);
  }
  for (const member of groupRows) {
    if (member.billingOrdinal !== billingByOccurrence.get(member.occurrenceId)) {
      throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "Collection-group billing evidence does not match the published occurrence billing ordinal", 503);
    }
  }
  const triggerAtByGroup = new Map<string, string>();
  const groupIds = [...new Set(groupRows.map((row) => row.groupId))];
  const triggerEvidence = groupIds.length === 0 ? [] : await tx.select({ groupId: canonicalCollectionGroupMembers.groupId, startAt: leagueOccurrences.startAt }).from(canonicalCollectionGroupMembers).innerJoin(leagueOccurrences, and(
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
  if (triggerEvidence.length !== groupIds.length || triggerEvidence.some((row, index) => triggerEvidence.findIndex((candidate) => candidate.groupId === row.groupId) !== index)) {
    throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "Each published collection group must have exactly one trigger occurrence", 503);
  }
  for (const row of triggerEvidence) triggerAtByGroup.set(row.groupId, new Date(row.startAt).toISOString());
  const allocations = await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, rows.map((row) => row.id)),
  )).for("update");
  const allocatedById = new Map<string, number>();
  const reviewById = new Map<string, boolean>();
  for (const row of allocations) {
    allocatedById.set(row.obligationId, (allocatedById.get(row.obligationId) ?? 0) + row.amountMinor);
    reviewById.set(row.obligationId, (reviewById.get(row.obligationId) ?? false) || row.reviewRequired);
  }
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId),
    eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((allocation) => allocation.id)),
  ));
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  for (const adjustment of adjustments) {
    const allocation = allocations.find((candidate) => candidate.id === adjustment.sourceAllocationId);
    if (!allocation) continue;
    adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  const reservations = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    inArray(paymentOperationRosterSnapshotItems.obligationId, rows.map((row) => row.id)),
  )).for("update");
  const reservedById = new Map<string, number>();
  for (const row of reservations) reservedById.set(row.obligationId, (reservedById.get(row.obligationId) ?? 0) + row.amountMinor);
  // The query above deliberately keeps its dueAt order for row-lock
  // acquisition. Sort only this projected candidate list by canonical
  // published collection order for one-time allocation and option choices.
  return rows.map((row) => {
    const member = groupByOccurrence.get(row.occurrenceId);
    const triggerAt = member ? triggerAtByGroup.get(member.groupId) : undefined;
    // A published pair fixes the collection sequence before its trigger is
    // due. The trigger timestamp is the paired occurrence's effective FIFO
    // position; the published-pair marker remains in quote evidence, while
    // ordering no longer depends on the actual clock.
    const pairedCollectionReady = member?.role === "paired" && triggerAt !== undefined;
    return {
      id: row.id,
      responsibilityId: row.responsibilityId,
      occurrenceId: row.occurrenceId,
      amountMinor: row.amountMinor,
      state: row.state,
      // Reservations remain part of the oldest candidate's capacity. They
      // are deliberately excluded from the available balance but must stay
      // visible to the allocator so it fails closed instead of skipping a
      // fully-reserved oldest obligation and collecting a later one.
      outstandingMinor: canonicalObligationBalance({
        amountMinor: row.amountMinor,
        state: row.state,
        grossAllocatedMinor: allocatedById.get(row.id) ?? 0,
        adjustments: adjustmentsByObligationId.get(row.id) ?? [],
      }).outstandingMinor,
      dueAt: new Date(row.dueAt).toISOString(),
      pastDueAt: new Date(row.pastDueAt).toISOString(),
      payerBowlerId: input.payerBowlerId,
      currency: row.currency as "USD",
      memberOrdinal: member?.memberOrdinal ?? 0,
      billingOrdinal: billingByOccurrence.get(row.occurrenceId) as number,
      reservedMinor: reservedById.get(row.id) ?? 0,
      reviewRequired: reviewById.get(row.id) ?? false,
      pairedCollectionReady,
      effectiveCollectionAt: member?.role === "paired" && triggerAt !== undefined ? triggerAt : new Date(row.dueAt).toISOString(),
      occurrenceLocalDate: occurrenceById.get(row.occurrenceId)?.authoritativeLocalDate ?? null,
      plannedOrdinal: occurrenceById.get(row.occurrenceId)?.plannedOrdinal ?? null,
    };
  }).sort(comparePublishedCollectionOrder);
}

export async function quoteInteractiveObligations(input: FifoQuoteInput & { organizationId: number; leagueId: number }) {
  const run = async (tx: RosterPaymentTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).for("share");
    if (!league) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
    const payerBowlerId = input.payerBowlerId;
    const [payer] = await tx.select({ id: bowlers.id }).from(bowlers).innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true))).where(and(eq(bowlers.id, payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
    if (!payer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is not an active member of this league", 403);
    const allCandidates = await fifoCandidatesInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId });
    const candidates = allCandidates;
    const amountMinor = input.amountMinor;
    const allocations = allocateAutomaticFifoPayment(amountMinor, candidates);
    if (league.paymentMode === "upfront") {
      const allOutstanding = candidates.reduce((sum, row) => sum + row.outstandingMinor, 0);
      if (amountMinor !== allOutstanding) throw new RosterPaymentError("UPFRONT_FULL_BALANCE_REQUIRED", "Upfront checkout must collect the payer's full remaining balance", 422);
    }
    const byId = new Map(candidates.map((row) => [row.id, row]));
    const selectedObligations = allocations.map((allocation) => {
      const row = byId.get(allocation.obligationId);
      if (!row) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "The FIFO allocation references missing obligation evidence", 503);
      return { ...row, selectedMinor: allocation.amountMinor };
    });
    const fingerprintRows = selectedObligations.map((row) => ({ id: row.id, amountMinor: row.selectedMinor, dueAt: row.dueAt, effectiveCollectionAt: row.effectiveCollectionAt, payerBowlerId: row.payerBowlerId, pairedCollectionReady: row.pairedCollectionReady }));
    return { contractVersion: "interactive-obligation-quote/2" as const, automaticContractVersion: "automatic-fifo-payment/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, currency: "USD" as const, payerBowlerId, amountMinor, obligations: selectedObligations, allocations, fingerprint: quoteFingerprint(fingerprintRows) };
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

/** Prepare and dispatch one automatically allocated interactive charge. Provider
 * calls happen only after the operation snapshot commits; allocation writes
 * happen in a second locked transaction after a durable provider result. */
export async function chargeInteractiveObligations(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  payerBowlerId: number;
  request: {
    amountMinor: number;
    sourceId: string;
    sourceKind: "new_card" | "saved_card" | "wallet";
    buyerEmail?: string | null;
    storeCard?: boolean;
    idempotencyKey: string;
    requestFingerprint: string;
  };
}) {
  const league = await leagueScope(input.organizationId, input.leagueId);
  const provider = await getPaymentProvider(league.locationId);
  const prepared = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [existingOperation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.targetKey, `interactive-charge:${input.request.idempotencyKey}`),
    )).limit(1).for("update");
    if (existingOperation) {
      if (existingOperation.authorizingUserId !== input.actorUserId) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to another authorizing user", 409);
      }
      const [existingInteractiveSnapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.operationId, existingOperation.id),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
        eq(paymentOperationRosterSnapshots.snapshotKind, "interactive"),
      )).limit(1).for("share");
      const requestedPayer = input.payerBowlerId;
      const storedSourceId = existingInteractiveSnapshot?.encryptedSourceId
        ? decrypt(existingInteractiveSnapshot.encryptedSourceId)
        : null;
      // Buyer email is server-resolved into the immutable snapshot. It is
      // not a mutable provider/payment identity on replay, so a retry must
      // reuse that snapshot regardless of whether the browser sends an
      // explicit fallback, whitespace, or no email at all.
      if (!existingInteractiveSnapshot
        || (requestedPayer !== undefined && existingInteractiveSnapshot.payerBowlerId !== requestedPayer)
        || existingInteractiveSnapshot.sourceKind !== input.request.sourceKind
        || existingInteractiveSnapshot.storeCard !== (input.request.storeCard === true)
        || storedSourceId !== input.request.sourceId) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different payment identity", 409);
      }
      const [existingSnapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.operationId, existingOperation.id),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share");
      if (!existingSnapshot) throw new RosterPaymentError("OPERATION_SNAPSHOT_MISSING", "The payment operation has no immutable roster snapshot", 409);
      const existingItems = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor })
        .from(paymentOperationRosterSnapshotItems)
        .where(and(
          eq(paymentOperationRosterSnapshotItems.operationId, existingOperation.id),
          eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
        ))
        .orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
      const requestedAmount = input.request.amountMinor;
      if (existingSnapshot.quoteFingerprint !== input.request.requestFingerprint
        || existingOperation.amountMinor !== requestedAmount
        || existingItems.reduce((sum, item) => sum + item.amountMinor, 0) !== requestedAmount) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different FIFO payment", 409);
      }
      return { operation: existingOperation, quote: null, reused: true };
    }
    const payerBowlerIdInput = input.payerBowlerId;
    const quote = await quoteInteractiveObligations({ organizationId: input.organizationId, leagueId: input.leagueId, amountMinor: input.request.amountMinor, payerBowlerId: payerBowlerIdInput, transaction: tx });
    if (quote.fingerprint !== input.request.requestFingerprint) throw new RosterPaymentError("STALE_QUOTE", "The obligation quote is stale; request a new quote", 409);
    const first = quote.obligations[0];
    if (!first) throw new RosterPaymentError("NO_ELIGIBLE_OBLIGATIONS", "No eligible payment obligations remain", 422);
    // Drizzle's PostgreSQL string timestamps may be returned as a space-
    // separated value. Interactive snapshot contracts require canonical ISO
    // datetimes, so normalize once before persisting the immutable operation
    // snapshot and every allocation row derived from it.
    const payerBowlerId = payerBowlerIdInput ?? first.payerBowlerId;
    if (input.request.sourceKind === "saved_card" && payerBowlerIdInput === undefined) {
      throw new RosterPaymentError("SAVED_CARD_PAYER_REQUIRED", "A saved payment method requires an authenticated payer", 403);
    }
    const [payerBowler] = await tx.select().from(bowlers).where(and(
      eq(bowlers.id, payerBowlerId),
      eq(bowlers.organizationId, input.organizationId),
    )).limit(1).for("share");
    if (!payerBowler) throw new RosterPaymentError("NOT_FOUND", "The payment payer is unavailable", 404);
    const buyerEmail = resolveInteractiveBuyerEmail(provider.providerName, input.request.buyerEmail, payerBowler.email);
    if (input.request.storeCard === true) {
      const [actor] = await tx.select({ bowlerId: users.bowlerId, organizationId: users.organizationId }).from(users).where(and(
        eq(users.id, input.actorUserId),
        eq(users.organizationId, input.organizationId),
      )).limit(1).for("share");
      if (!actor || actor.bowlerId !== payerBowlerId) {
        throw new RosterPaymentError("CARD_SAVE_OWNER_REQUIRED", "Only the payer can save a card for this payment", 403);
      }
    }
    const customerId = getProviderCustomerId(payerBowler, provider);
    if (input.request.sourceKind === "saved_card" && !customerId) {
      throw new RosterPaymentError("SAVED_CARD_CUSTOMER_REQUIRED", "The saved payment method is not available for this payer", 422);
    }
    if (input.request.storeCard === true && input.request.sourceKind !== "new_card") {
      throw new RosterPaymentError("INVALID_CARD_SAVE_REQUEST", "Only a new card can be saved", 422);
    }
    if (input.request.storeCard === true && !customerId) {
      throw new RosterPaymentError("CARD_CUSTOMER_REQUIRED", "A provider customer is required to save a card", 422);
    }
    const responsibilityIds = [...new Set(quote.obligations.map((obligation) => obligation.responsibilityId))];
    const responsibilityVersions = await tx.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).for("share");
    const responsibilityVersionById = new Map(responsibilityVersions.map((row) => [row.id, row.version]));
    if (responsibilityIds.some((id) => !responsibilityVersionById.has(id))) throw new RosterPaymentError("RESERVATION_STALE", "A roster responsibility changed while the quote was being prepared", 409);
    const operation = await prepareInteractivePaymentOperation({
      organizationId: input.organizationId,
      authorizingUserId: input.actorUserId,
      requestKey: input.request.idempotencyKey,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      providerName: provider.providerName,
      leagueId: input.leagueId,
      locationId: league.locationId,
      providerLocationId: null,
      payerBowlerId,
      requestKind: "direct",
      sourceId: input.request.sourceId,
      customerId: customerId ?? null,
      buyerEmail,
      storeCard: input.request.storeCard === true,
      sourceKind: input.request.sourceKind,
      allocations: quote.obligations.map((obligation, allocationIndex) => {
        const responsibilityVersion = responsibilityVersionById.get(obligation.responsibilityId);
        if (responsibilityVersion === undefined) throw new RosterPaymentError("RESERVATION_STALE", "A roster responsibility changed while the quote was being prepared", 409);
        return {
          allocationIndex,
          bowlerId: obligation.payerBowlerId,
          amountMinor: obligation.selectedMinor,
          notes: `Roster obligation ${obligation.id}`,
          paidByUserId: input.actorUserId,
          obligationId: obligation.id,
          responsibilityId: obligation.responsibilityId,
          responsibilityVersion,
        };
      }),
      lineItems: [],
      quoteFingerprint: quote.fingerprint,
      transaction: tx,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values(quote.obligations.map((obligation, allocationIndex) => ({
      operationId: operation.id,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligationId: obligation.id,
      allocationIndex,
      amountMinor: obligation.selectedMinor,
      state: "reserved" as const,
    })));
    return { operation, quote, reused: false };
  });
  const operation = prepared.operation;
  let executed: Awaited<ReturnType<typeof interactivePaymentOperationExecutor.execute>>;
  try {
    executed = await interactivePaymentOperationExecutor.execute({ organizationId: input.organizationId, operationId: operation.id });
  } finally {
    // The operation row is committed before execution begins. Re-arm the
    // general retry scheduler after every outcome, including retry_scheduled
    // and provider_unknown, so a one-shot checkout cannot strand durable work.
    await paymentOperationRetryExecutor.rearm().catch((error: unknown) => {
      log.error("Payment operation retry scheduler rearm failed after interactive checkout", {
        organizationId: input.organizationId,
        operationId: operation.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
  if (!executed || executed.status !== "succeeded") {
    if (executed && ["failed_terminal", "action_required", "canceled"].includes(executed.status)) {
      await db.transaction(async (tx) => {
        await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
          eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
          eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
          eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        ));
      });
    }
    return { contractVersion: "interactive-obligation-charge/2" as const, operationId: operation.id, status: executed?.status ?? operation.status, providerPaymentId: executed?.providerObjectId ?? null };
  }
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const persisted = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.id, operation.id), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId))).limit(1).for("update");
    const storedOperation = persisted[0];
    if (!storedOperation || (storedOperation.status !== "succeeded" && storedOperation.status !== "reconciliation_required")) throw new RosterPaymentError("PAYMENT_NOT_SETTLED", "Provider payment is not locally settled", 409);
    // Provider success is durable even when the roster reservation became
    // stale during local finalization. Return the reconciliation state so an
    // operation-id recovery can retry the exact immutable snapshot; never
    // turn that evidence into a generic payment failure.
    if (storedOperation.status === "reconciliation_required") {
      return { contractVersion: "interactive-obligation-charge/2" as const, operationId: storedOperation.id, status: storedOperation.status, providerPaymentId: storedOperation.providerObjectId };
    }
    const [payment] = await tx.select().from(payments).where(and(eq(payments.leagueId, input.leagueId), eq(payments.paymentOperationId, operation.id))).limit(1).for("share");
    const allocations = payment ? await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active"))).for("share") : [];
    if (!payment || payment.amount !== storedOperation.amountMinor) throw new RosterPaymentError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete", 409);
    return { contractVersion: "interactive-obligation-charge/2" as const, operationId: storedOperation.id, status: storedOperation.status, providerPaymentId: storedOperation.providerObjectId, payment, allocations, records: allocations.map((allocation) => ({ payment, allocation })) };
  });
}

export async function recordCanonicalManualPayment(input: { organizationId: number; leagueId: number; actorUserId: number; request: CanonicalManualRecordRequest }) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.manual_record",
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
    });
    const quote = await quoteInteractiveObligations({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      amountMinor: input.request.amountMinor,
      payerBowlerId: input.request.payerBowlerId,
      transaction: tx,
    });
    if (input.request.requestFingerprint !== quote.fingerprint) throw new RosterPaymentError("STALE_QUOTE", "The obligation quote is stale; request a new quote", 409);
    const payerBowlerId = quote.payerBowlerId;
    const [payment] = await tx.insert(payments).values({ organizationId: input.organizationId, bowlerId: payerBowlerId, leagueId: input.leagueId, amount: quote.amountMinor, status: "paid", type: input.request.type, checkNumber: input.request.checkNumber, notes: input.request.notes, idempotencyKey: input.request.idempotencyKey, paidByUserId: input.actorUserId }).returning();
    if (!payment) throw new RosterPaymentError("PAYMENT_WRITE_FAILED", "The payment could not be recorded", 503);
    const created = [];
    for (const obligation of quote.obligations) {
      const [allocation] = await tx.insert(paymentAllocations).values({ organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id, obligationId: obligation.id, amountMinor: obligation.selectedMinor, currency: obligation.currency, recordedByUserId: input.actorUserId }).returning();
      if (!allocation) throw new RosterPaymentError("ALLOCATION_WRITE_FAILED", "The payment allocation could not be recorded", 503);
      const activeRows = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, obligation.id), eq(paymentAllocations.state, "active"))).for("update");
      const adjustmentRows = activeRows.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
        eq(refundAllocationAdjustments.organizationId, input.organizationId),
        eq(refundAllocationAdjustments.leagueId, input.leagueId),
        inArray(refundAllocationAdjustments.sourceAllocationId, activeRows.map((row) => row.id)),
      ));
      const balance = canonicalObligationBalance({
        amountMinor: obligation.amountMinor,
        state: obligation.state,
        grossAllocatedMinor: activeRows.reduce((sum, row) => sum + row.amountMinor, 0),
        adjustments: adjustmentRows,
      });
      await tx.update(paymentObligations).set({ state: balance.outstandingMinor === 0 ? "settled" : "partially_settled" }).where(and(eq(paymentObligations.id, obligation.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
      created.push({ payment, allocation });
    }
    const result = { contractVersion: "canonical-manual-record/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, records: created };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.manual_record", idempotencyKey: input.request.idempotencyKey, result });
    return result;
  });
}

export async function correctCanonicalAllocation(input: { organizationId: number; leagueId: number; actorUserId: number; request: CanonicalCorrectionInput }) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.void_payment",
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
    });
    const [payment] = await tx.select().from(payments).where(and(eq(payments.id, input.request.paymentId), eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId))).limit(1).for("share");
    if (payment) await assertPaymentIsNotRotatingCreditFundingInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id });
    if (!payment || (payment.type !== "cash" && payment.type !== "check") || payment.status !== "paid" || payment.paymentOperationId !== null || payment.providerPaymentId !== null || payment.refundedAt !== null || payment.squareRefundId !== null || payment.disputeId !== null || payment.disputedAt !== null) {
      throw new RosterPaymentError("PROVIDER_ALLOCATION_IMMUTABLE", "Provider payment evidence requires refund or reconciliation; it cannot be directly corrected", 409);
    }
    if (input.request.requestFingerprint !== canonicalCorrectionFingerprint(input.request)) throw new RosterPaymentError("INVALID_FINGERPRINT", "The correction request fingerprint is invalid", 422);
    const [alreadyVoided] = await tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(eq(paymentVoids.organizationId, input.organizationId), eq(paymentVoids.leagueId, input.leagueId), eq(paymentVoids.paymentId, payment.id))).limit(1).for("update");
    if (alreadyVoided) throw new RosterPaymentError("PAYMENT_ALREADY_VOIDED", "The payment is already voided", 409);
    const allocations = await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active"))).for("update");
    if (allocations.length === 0) throw new RosterPaymentError("PAYMENT_NOT_ALLOCATED", "The payment has no active allocation evidence", 409);
    const reservation = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, allocations.map((row) => row.obligationId)),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    )).limit(1).for("update");
    if (reservation.length > 0) throw new RosterPaymentError("OBLIGATION_RESERVED", "A provider operation has already reserved an allocation for this payment", 409);
    const [voidEvidence] = await tx.insert(paymentVoids).values({ organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id, reason: input.request.reason, recordedByUserId: input.actorUserId }).returning();
    if (!voidEvidence) throw new RosterPaymentError("PAYMENT_VOID_FAILED", "The payment void could not be recorded", 503);
    await tx.update(payments).set({ status: "voided" }).where(and(eq(payments.id, payment.id), eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId)));
    await tx.update(paymentAllocations).set({ state: "voided" }).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active")));
    const obligationIds = [...new Set(allocations.map((row) => row.obligationId))];
    const obligations = await tx.select().from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.id, obligationIds))).for("update");
    for (const obligation of obligations) {
      const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, obligation.id), eq(paymentAllocations.state, "active")));
      const adjustments = active.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
        eq(refundAllocationAdjustments.organizationId, input.organizationId),
        eq(refundAllocationAdjustments.leagueId, input.leagueId),
        inArray(refundAllocationAdjustments.sourceAllocationId, active.map((row) => row.id)),
      ));
      const balance = canonicalObligationBalance({
        amountMinor: obligation.amountMinor,
        state: obligation.state,
        grossAllocatedMinor: active.reduce((sum, row) => sum + row.amountMinor, 0),
        adjustments,
      });
      await tx.update(paymentObligations).set({ state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 ? "partially_settled" : "open" }).where(and(eq(paymentObligations.id, obligation.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
    }
    const result = { contractVersion: "canonical-correction/3" as const, mode: "void_only" as const, payment: { ...payment, status: "voided" as const }, voidEvidence, voidedAllocations: allocations, restoredObligationIds: obligationIds };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.void_payment", idempotencyKey: input.request.idempotencyKey, result });
    return result;
  });
}

/**
 * Edit one cash tender as one serialized financial command. The original
 * tender and its allocations remain immutable evidence: they are voided and
 * a new cash tender receives either the exact old allocation shape (date-only
 * edits) or a fresh server-authoritative FIFO allocation (amount edits).
 */
export async function editCanonicalCashPayment(input: { organizationId: number; leagueId: number; actorUserId: number; request: CanonicalCorrectionInput }) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.edit_cash_payment",
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
    });

    const [league] = await tx.select({ timezone: leagues.timezone })
      .from(leagues)
      .where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId)))
      .limit(1)
      .for("share");
    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, input.request.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    )).limit(1).for("update");
    if (!league || !payment) throw new RosterPaymentError("NOT_FOUND", "Payment not found", 404);
    await assertPaymentIsNotRotatingCreditFundingInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id });
    if (input.request.correctionMode !== "edit_cash") {
      throw new RosterPaymentError("INVALID_CORRECTION_MODE", "The cash edit command requires correctionMode=edit_cash", 422);
    }
    if (input.request.amountMinor === undefined || input.request.paymentDate === undefined) {
      throw new RosterPaymentError("INVALID_REQUEST", "A cash edit requires an amount and payment date", 422);
    }
    if (!Number.isSafeInteger(input.request.amountMinor) || input.request.amountMinor <= 0) {
      throw new RosterPaymentError("INVALID_AMOUNT", "Payment amount must be a positive whole number of cents", 422);
    }
    if (input.request.requestFingerprint !== canonicalCashPaymentEditFingerprint(input.request)) {
      throw new RosterPaymentError("INVALID_FINGERPRINT", "The cash edit request fingerprint is invalid", 422);
    }
    if (payment.type !== "cash" || payment.status !== "paid" || payment.paymentOperationId !== null
      || payment.providerPaymentId !== null || payment.refundedAt !== null || payment.squareRefundId !== null
      || payment.disputeId !== null || payment.disputedAt !== null) {
      throw new RosterPaymentError("CASH_EDIT_UNAVAILABLE", "Only an active cash payment can be edited", 409);
    }

    const timezone = league.timezone ?? "UTC";
    const oldPaymentDate = paymentLocalDate(payment.createdAt, timezone);
    if (payment.amount === input.request.amountMinor && oldPaymentDate === input.request.paymentDate) {
      throw new RosterPaymentError("UNCHANGED_PAYMENT", "Change the amount or payment date before saving", 422);
    }
    let replacementCreatedAt: string;
    try {
      // Noon is stable across ordinary DST transitions and the resulting
      // instant is persisted in UTC. The server resolves it in the league's
      // timezone; the browser never participates in date conversion.
      replacementCreatedAt = resolveCanonicalLocalDateTime({
        localDate: input.request.paymentDate,
        localTime: "12:00:00",
        timezone,
        ambiguousFold: "earlier",
      }).startAt;
    } catch (error) {
      if (error instanceof Error) throw new RosterPaymentError("INVALID_PAYMENT_DATE", error.message, 422);
      throw error;
    }

    const sourceAllocations = await tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
    )).orderBy(asc(paymentAllocations.id)).for("update");
    if (sourceAllocations.length === 0) {
      throw new RosterPaymentError("PAYMENT_NOT_ALLOCATED", "The cash payment has no active allocation evidence", 409);
    }
    if (sourceAllocations.some((allocation) => allocation.state !== "active" || allocation.reviewRequired)) {
      throw new RosterPaymentError("CASH_EDIT_UNAVAILABLE", "This payment has allocation evidence requiring review", 409);
    }
    const sourceAllocationIds = sourceAllocations.map((allocation) => allocation.id);
    const refundAdjustments = await tx.select({ id: refundAllocationAdjustments.id }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, sourceAllocationIds),
    )).limit(1);
    if (refundAdjustments.length > 0) {
      throw new RosterPaymentError("CASH_EDIT_UNAVAILABLE", "This payment has refund allocation evidence requiring reconciliation", 409);
    }
    const sourceObligationIds = [...new Set(sourceAllocations.map((allocation) => allocation.obligationId))];
    if (sourceObligationIds.length > 0) {
      const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
        eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
        eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        inArray(paymentOperationRosterSnapshotItems.obligationId, sourceObligationIds),
      )).limit(1).for("update");
      if (reservations.length > 0) throw new RosterPaymentError("OBLIGATION_RESERVED", "An automatic payment has reserved this payment's allocation", 409);
    }

    const [alreadyVoided] = await tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, input.organizationId),
      eq(paymentVoids.leagueId, input.leagueId),
      eq(paymentVoids.paymentId, payment.id),
    )).limit(1).for("update");
    if (alreadyVoided) throw new RosterPaymentError("PAYMENT_ALREADY_VOIDED", "The payment is already voided", 409);

    const originalPaymentDate = oldPaymentDate;
    const editReason = input.request.reason;
    const [voidEvidence] = await tx.insert(paymentVoids).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
      reason: editReason,
      recordedByUserId: input.actorUserId,
    }).returning();
    if (!voidEvidence) throw new RosterPaymentError("PAYMENT_VOID_FAILED", "The payment void could not be recorded", 503);
    await tx.update(payments).set({ status: "voided" }).where(and(
      eq(payments.id, payment.id),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    ));
    if (sourceAllocations.length > 0) {
      await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        eq(paymentAllocations.paymentId, payment.id),
        eq(paymentAllocations.state, "active"),
      ));
    }

    const touchedObligationIds = new Set(sourceObligationIds);
    const refreshObligationState = async (obligationIds: string[]) => {
      if (obligationIds.length === 0) return;
      const obligations = await tx.select().from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        inArray(paymentObligations.id, obligationIds),
      )).for("update");
      for (const obligation of obligations) {
        const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
          eq(paymentAllocations.organizationId, input.organizationId),
          eq(paymentAllocations.leagueId, input.leagueId),
          eq(paymentAllocations.obligationId, obligation.id),
          eq(paymentAllocations.state, "active"),
        ));
        const adjustments = active.length === 0 ? [] : await tx.select({
          sourceAllocationId: refundAllocationAdjustments.sourceAllocationId,
          amountMinor: refundAllocationAdjustments.amountMinor,
          disposition: refundAllocationAdjustments.disposition,
        }).from(refundAllocationAdjustments).where(and(
          eq(refundAllocationAdjustments.organizationId, input.organizationId),
          eq(refundAllocationAdjustments.leagueId, input.leagueId),
          inArray(refundAllocationAdjustments.sourceAllocationId, active.map((row) => row.id)),
        ));
        const balance = canonicalObligationBalance({
          amountMinor: obligation.amountMinor,
          state: obligation.state,
          grossAllocatedMinor: active.reduce((sum, row) => sum + row.amountMinor, 0),
          adjustments,
        });
        await tx.update(paymentObligations).set({
          state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 ? "partially_settled" : "open",
          voidedAt: null,
        }).where(and(
          eq(paymentObligations.id, obligation.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
        ));
      }
    };
    let replacementAllocations: Array<{ obligationId: string; amountMinor: number }>;
    const dateOnly = payment.amount === input.request.amountMinor;
    if (dateOnly) {
      replacementAllocations = sourceAllocations.map((allocation) => ({ obligationId: allocation.obligationId, amountMinor: allocation.amountMinor }));
    } else {
      const candidates = await fifoCandidatesInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        payerBowlerId: payment.bowlerId,
        // A fully paid source obligation is still settled evidence after its
        // old allocation is voided. Include it in FIFO's projected balance
        // without mutating its append-only state before replacement rows exist.
        includeSettledObligationIds: sourceObligationIds,
      });
      replacementAllocations = allocateAutomaticFifoPayment(input.request.amountMinor, candidates);
    }

    const [replacement] = await tx.insert(payments).values({
      organizationId: input.organizationId,
      bowlerId: payment.bowlerId,
      leagueId: payment.leagueId,
      amount: input.request.amountMinor,
      currency: payment.currency,
      status: "paid",
      type: "cash",
      checkNumber: null,
      providerPaymentId: null,
      idempotencyKey: null,
      receiptEmailMissing: false,
      notes: payment.notes,
      paidByUserId: payment.paidByUserId,
      createdAt: replacementCreatedAt,
    }).returning();
    if (!replacement) throw new RosterPaymentError("PAYMENT_WRITE_FAILED", "The corrected payment could not be recorded", 503);

    const createdAllocations = [];
    for (const allocation of replacementAllocations) {
      const [created] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: replacement.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        currency: payment.currency,
        recordedByUserId: input.actorUserId,
      }).returning();
      if (!created) throw new RosterPaymentError("ALLOCATION_WRITE_FAILED", "The corrected payment allocation could not be recorded", 503);
      createdAllocations.push(created);
      touchedObligationIds.add(allocation.obligationId);
    }
    await refreshObligationState([...touchedObligationIds]);

    const result = {
      contractVersion: "canonical-cash-payment-edit/1" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      mode: "edit_cash" as const,
      originalPaymentId: payment.id,
      replacementPaymentId: replacement.id,
      oldAmountMinor: payment.amount,
      newAmountMinor: replacement.amount,
      oldPaymentDate: originalPaymentDate,
      newPaymentDate: input.request.paymentDate,
      allocationMode: dateOnly ? "copied" as const : "fifo_reapplied" as const,
      allocationCount: createdAllocations.length,
      payment: replacement,
      voidEvidence,
      allocations: createdAllocations,
    };
    await completeFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      commandType: "roster_payment.edit_cash_payment",
      idempotencyKey: input.request.idempotencyKey,
      result,
    });
    return result;
  });
}

/**
 * Apply an explicitly reviewed historical cash allocation correction.
 *
 * This is intentionally an internal service surface. A maintenance runner
 * supplies the exact payment allowlist, source allocation digest, and target
 * allocation digest after its read-only preflight. The command never invokes
 * a provider and never derives a new FIFO plan.
 */
export async function repairHistoricalCashPaymentAllocation(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  allowlist: HistoricalCashPaymentAllowlist;
  request: HistoricalCashAllocationRepairRequest;
}) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const request = input.request;
    const targetAllocations = Array.isArray(request.targetAllocations) ? request.targetAllocations : null;
    const { requestFingerprint: _requestFingerprint, ...fingerprintRequest } = request;
    if (!Number.isSafeInteger(request.paymentId) || request.paymentId <= 0
      || targetAllocations === null || targetAllocations.length === 0 || targetAllocations.length > 64
      || typeof request.reason !== "string" || request.reason.trim().length === 0 || request.reason.length > 500
      || typeof request.expectedOldAllocationFingerprint !== "string" || request.expectedOldAllocationFingerprint.trim().length === 0
      || typeof request.expectedTargetAllocationFingerprint !== "string" || request.expectedTargetAllocationFingerprint.trim().length === 0
      || typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim().length === 0
      || request.requestFingerprint !== canonicalHistoricalCashAllocationRepairFingerprint({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        request: fingerprintRequest,
      })) {
      throw new RosterPaymentError("INVALID_REPAIR_REQUEST", "The historical cash repair request is invalid", 422);
    }
    if (new Set(targetAllocations.map((row) => row.obligationId)).size !== targetAllocations.length
      || targetAllocations.some((row) => !/^[0-9a-f-]{36}$/i.test(row.obligationId)
        || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0)) {
      throw new RosterPaymentError("INVALID_REPAIR_MAPPING", "The historical cash repair allocation map is invalid", 422);
    }
    const calculatedTargetFingerprint = historicalCashAllocationFingerprint(targetAllocations.map((row) => ({
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: "active" as const,
      allocationKind: "ordinary" as const,
    })));
    if (calculatedTargetFingerprint !== request.expectedTargetAllocationFingerprint) {
      throw new RosterPaymentError("REPAIR_TARGET_FINGERPRINT_MISMATCH", "The historical cash repair target evidence is stale", 409);
    }
    const allowlistedAmount = input.allowlist?.paymentAmountsMinor?.[String(request.paymentId)];
    if (!Number.isSafeInteger(allowlistedAmount) || allowlistedAmount <= 0) {
      throw new RosterPaymentError("PAYMENT_NOT_ALLOWLISTED", "This payment is not authorized for historical correction", 409);
    }
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.repair_historical_cash_allocation",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: request.requestFingerprint,
    });

    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, request.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    )).limit(1).for("update");
    if (!payment) throw new RosterPaymentError("NOT_FOUND", "Payment not found", 404);
    if (payment.amount !== allowlistedAmount) {
      throw new RosterPaymentError("PAYMENT_AMOUNT_MISMATCH", "The payment amount does not match the private correction plan", 409);
    }
    await assertPaymentIsNotRotatingCreditFundingInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
    });
    if (payment.type !== "cash" || payment.status !== "paid" || payment.paymentOperationId !== null
      || payment.providerPaymentId !== null || payment.refundedAt !== null || payment.squareRefundId !== null
      || payment.disputeId !== null || payment.disputedAt !== null) {
      throw new RosterPaymentError("CASH_REPAIR_UNAVAILABLE", "Only an active unlinked cash payment can be repaired", 409);
    }
    if (targetAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0) !== payment.amount) {
      throw new RosterPaymentError("REPAIR_TARGET_AMOUNT_MISMATCH", "The historical cash repair target must conserve the tender amount", 409);
    }

    const sourceAllocations = await tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
    )).orderBy(asc(paymentAllocations.id)).for("update");
    if (sourceAllocations.length === 0
      || sourceAllocations.some((allocation) => allocation.state !== "active"
        || allocation.allocationKind !== "ordinary" || allocation.reviewRequired)
      || sourceAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0) !== payment.amount) {
      throw new RosterPaymentError("CASH_REPAIR_UNAVAILABLE", "The source cash allocation evidence is not repairable", 409);
    }
    const calculatedSourceFingerprint = historicalCashAllocationFingerprint(sourceAllocations.map((allocation) => ({
      allocationId: allocation.id,
      obligationId: allocation.obligationId,
      amountMinor: allocation.amountMinor,
      state: allocation.state,
      allocationKind: allocation.allocationKind,
    })));
    if (calculatedSourceFingerprint !== request.expectedOldAllocationFingerprint) {
      throw new RosterPaymentError("REPAIR_SOURCE_FINGERPRINT_MISMATCH", "The historical cash repair source evidence is stale", 409);
    }
    const sourceAllocationIds = sourceAllocations.map((allocation) => allocation.id);
    const refundAdjustments = await tx.select({ id: refundAllocationAdjustments.id }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, sourceAllocationIds),
    )).limit(1);
    if (refundAdjustments.length > 0) {
      throw new RosterPaymentError("CASH_REPAIR_UNAVAILABLE", "The source cash allocation has refund evidence", 409);
    }

    const sourceObligationIds = sourceAllocations.map((allocation) => allocation.obligationId);
    const targetObligationIds = targetAllocations.map((allocation) => allocation.obligationId);
    const touchedObligationIds = [...new Set([...sourceObligationIds, ...targetObligationIds])];
    const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
      inArray(paymentOperationRosterSnapshotItems.obligationId, touchedObligationIds),
    )).limit(1).for("update");
    if (reservations.length > 0) {
      throw new RosterPaymentError("OBLIGATION_RESERVED", "An automatic payment has reserved a repaired obligation", 409);
    }

    const obligations = await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, targetObligationIds),
    )).for("update");
    const obligationById = new Map(obligations.map((obligation) => [obligation.id, obligation]));
    if (obligations.length !== targetObligationIds.length || targetAllocations.some((allocation) => {
      const obligation = obligationById.get(allocation.obligationId);
      return !obligation || obligation.state === "voided" || obligation.currency !== payment.currency || obligation.payerBowlerId !== payment.bowlerId;
    })) {
      throw new RosterPaymentError("REPAIR_TARGET_UNAVAILABLE", "The historical cash repair target obligations are unavailable", 409);
    }
    const activeTargetAllocations = await tx.select({
      paymentId: paymentAllocations.paymentId,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, targetObligationIds),
    )).for("share");
    const activeOtherTotals = new Map<string, number>();
    for (const allocation of activeTargetAllocations) {
      if (allocation.paymentId === payment.id) continue;
      activeOtherTotals.set(allocation.obligationId, (activeOtherTotals.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    }
    if (targetAllocations.some((allocation) => {
      const obligation = obligationById.get(allocation.obligationId);
      return obligation !== undefined
        && (activeOtherTotals.get(allocation.obligationId) ?? 0) + allocation.amountMinor > obligation.amountMinor;
    })) {
      throw new RosterPaymentError("REPAIR_TARGET_OVERALLOCATED", "The historical cash repair would exceed an obligation balance", 409);
    }

    const [alreadyVoided] = await tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, input.organizationId),
      eq(paymentVoids.leagueId, input.leagueId),
      eq(paymentVoids.paymentId, payment.id),
    )).limit(1).for("update");
    if (alreadyVoided) throw new RosterPaymentError("CASH_REPAIR_UNAVAILABLE", "The source cash payment is already voided", 409);

    const [voidEvidence] = await tx.insert(paymentVoids).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
      reason: request.reason,
      recordedByUserId: input.actorUserId,
    }).returning();
    if (!voidEvidence) throw new RosterPaymentError("PAYMENT_VOID_FAILED", "The source cash payment could not be retained as void evidence", 503);
    await tx.update(payments).set({ status: "voided" }).where(and(
      eq(payments.id, payment.id),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    ));
    await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
      eq(paymentAllocations.state, "active"),
    ));

    const [replacement] = await tx.insert(payments).values({
      organizationId: input.organizationId,
      bowlerId: payment.bowlerId,
      leagueId: payment.leagueId,
      amount: payment.amount,
      currency: payment.currency,
      status: "paid",
      type: "cash",
      checkNumber: null,
      providerPaymentId: null,
      paymentOperationId: null,
      idempotencyKey: null,
      squareRefundId: null,
      refundReason: null,
      refundedAt: null,
      disputeId: null,
      disputedAt: null,
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
      receiptEmailMissing: payment.receiptEmailMissing,
      notes: payment.notes,
      paidByUserId: payment.paidByUserId,
      createdAt: payment.createdAt,
    }).returning();
    if (!replacement) throw new RosterPaymentError("PAYMENT_WRITE_FAILED", "The repaired cash tender could not be recorded", 503);

    const createdAllocations = [];
    for (const allocation of targetAllocations) {
      const [created] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: replacement.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        currency: payment.currency,
        allocationKind: "ordinary",
        recordedByUserId: input.actorUserId,
      }).returning();
      if (!created) throw new RosterPaymentError("ALLOCATION_WRITE_FAILED", "The repaired cash allocation could not be recorded", 503);
      createdAllocations.push(created);
    }

    const refreshObligationState = async (obligationIds: string[]) => {
      if (obligationIds.length === 0) return;
      const touched = await tx.select().from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        inArray(paymentObligations.id, obligationIds),
      )).for("update");
      for (const obligation of touched) {
        const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
          eq(paymentAllocations.organizationId, input.organizationId),
          eq(paymentAllocations.leagueId, input.leagueId),
          eq(paymentAllocations.obligationId, obligation.id),
          eq(paymentAllocations.state, "active"),
        ));
        const adjustments = active.length === 0 ? [] : await tx.select({
          sourceAllocationId: refundAllocationAdjustments.sourceAllocationId,
          amountMinor: refundAllocationAdjustments.amountMinor,
          disposition: refundAllocationAdjustments.disposition,
        }).from(refundAllocationAdjustments).where(and(
          eq(refundAllocationAdjustments.organizationId, input.organizationId),
          eq(refundAllocationAdjustments.leagueId, input.leagueId),
          inArray(refundAllocationAdjustments.sourceAllocationId, active.map((row) => row.id)),
        ));
        const balance = canonicalObligationBalance({
          amountMinor: obligation.amountMinor,
          state: obligation.state,
          grossAllocatedMinor: active.reduce((sum, row) => sum + row.amountMinor, 0),
          adjustments,
        });
        await tx.update(paymentObligations).set({
          state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 ? "partially_settled" : "open",
          voidedAt: null,
        }).where(and(
          eq(paymentObligations.id, obligation.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
        ));
      }
    };
    await refreshObligationState(touchedObligationIds);

    const result = {
      contractVersion: "canonical-historical-cash-reallocation/1" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      mode: "repair_cash_allocation" as const,
      sameTender: true as const,
      originalPaymentId: payment.id,
      replacementPaymentId: replacement.id,
      amountMinor: payment.amount,
      oldAllocationFingerprint: calculatedSourceFingerprint,
      targetAllocationFingerprint: calculatedTargetFingerprint,
      oldAllocations: sourceAllocations.map((allocation) => ({
        allocationId: allocation.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        state: "voided" as const,
        allocationKind: allocation.allocationKind,
      })),
      replacementPayment: replacement,
      voidEvidence,
      allocations: createdAllocations,
      allocationCount: createdAllocations.length,
    };
    await completeFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      commandType: "roster_payment.repair_historical_cash_allocation",
      idempotencyKey: request.idempotencyKey,
      result,
    });
    return result;
  });
}

export type RosterPaymentResponsibilityInput = OccurrenceResponsibilityInput;
