import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagues,
  paymentAllocations,
  paymentObligations,
  payments,
  financialCommands,
  occurrencePaymentResponsibilities,
  teamPaymentPolicies,
  teamPaymentPolicyRevisions,
  teamPaymentSlotRevisions,
  teamPaymentSlots,
  teams,
  paymentOperations,
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
import type {
  CanonicalCorrectionRequest,
  CanonicalManualRecordRequest,
  OccurrenceResponsibilityInput,
  RosterPaymentResponsibilityRequest,
  calculateRosterPaymentTiming,
} from "@shared/roster-payment-contract";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { prepareInteractivePaymentOperation } from "./interactive-payment-operation-preparation.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { paymentOperationRetryExecutor } from "./payment-operation-retry-executor.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { decrypt } from "../utils/crypto.js";
import { deriveRosterPaymentTimingInTransaction } from "./roster-payment-materializer.js";
import { createLogger } from "../logger.js";
import { allocateAutomaticFifoPayment as allocateFifo, type FifoPaymentCandidate as BaseFifoPaymentCandidate, AutomaticFifoAllocationError } from "./automatic-fifo-allocation.js";

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

type RosterPaymentTransaction = PaymentOperationTransaction;

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

export function canonicalRosterFingerprint(request: RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy }): string {
  return commandFingerprint("lvroster:v1", {
    lineupSize: request.lineupSize,
    policy: request.policy ?? "main_pays_full",
    slots: [...request.slots].sort((a, b) => a.slotIndex - b.slotIndex).map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
  });
}

export function canonicalResponsibilityFingerprint(rows: OccurrenceResponsibilityInput[]): string {
  return commandFingerprint("lvresponsibility:v1", [...rows].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId) || a.teamId - b.teamId || a.positionIndex - b.positionIndex).map((row) => ({
    occurrenceId: row.occurrenceId,
    teamId: row.teamId,
    slotIndex: row.slotIndex,
    positionIndex: row.positionIndex,
    kind: row.kind,
    mainBowlerId: row.mainBowlerId ?? null,
    substituteBowlerId: row.substituteBowlerId ?? null,
    payerBowlerId: row.payerBowlerId ?? null,
    policy: row.policy,
  })));
}

type CanonicalCorrectionInput = CanonicalCorrectionRequest;

export function canonicalCorrectionFingerprint(request: CanonicalCorrectionInput): string {
  return commandFingerprint("lvcorrection:v3", {
    paymentId: request.paymentId ?? null,
    correctionMode: request.correctionMode,
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

export async function saveTeamRoster(input: {
  organizationId: number;
  leagueId: number;
  teamId: number;
  actorUserId: number;
  payerBowlerId?: number;
  request: RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy };
}) {
  const league = await leagueScope(input.organizationId, input.leagueId);
  const expectedFingerprint = canonicalRosterFingerprint(input.request);
  if (input.request.requestFingerprint !== expectedFingerprint) throw new RosterPaymentError("INVALID_FINGERPRINT", "The roster request fingerprint is invalid", 422);
  if (league.payingLineupSize !== input.request.lineupSize) throw new RosterPaymentError("LINEUP_SIZE_MISMATCH", "Roster lineup size does not match league setup", 409);
  if (input.request.policy === "special_split" && league.substitutePaymentRegime !== "league_lineage_prize_split") {
    throw new RosterPaymentError("POLICY_NOT_AVAILABLE", "Special split requires the league lineage/prize split regime", 422);
  }
  const slots = [...input.request.slots].sort((a, b) => a.slotIndex - b.slotIndex);
  if (slots.length !== input.request.lineupSize || slots.some((slot, index) => slot.slotIndex !== index)) throw new RosterPaymentError("INCOMPLETE_ROSTER", "Every stable lineup slot must be supplied", 422);
  if (slots.filter((slot) => slot.occupant === "main").some((slot) => slot.mainBowlerId === null || slot.mainBowlerId === undefined)) throw new RosterPaymentError("INVALID_MAIN", "A Main slot requires a bowler", 422);
  if (slots.some((slot) => slot.occupant !== "main" && slot.mainBowlerId !== null && slot.mainBowlerId !== undefined)) {
    throw new RosterPaymentError("INVALID_SLOT_IDENTITY", "Only a Main slot may contain a Main bowler identity", 422);
  }
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.save_team_roster",
      idempotencyKey: input.request.commandKey,
      requestFingerprint: input.request.requestFingerprint,
    });
    const [team] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, input.leagueId))).limit(1).for("update");
    if (!team) throw new RosterPaymentError("NOT_FOUND", "Team not found", 404);
    const selectedBowlerIds = slots.flatMap((slot) => slot.mainBowlerId ? [slot.mainBowlerId] : []);
    if (new Set(selectedBowlerIds).size !== selectedBowlerIds.length) throw new RosterPaymentError("DUPLICATE_MAIN", "A bowler may occupy only one Main slot", 422);
    if (selectedBowlerIds.length > 0) {
      const members = await tx.select({ id: bowlers.id }).from(bowlers)
        .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true)))
        .where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true), inArray(bowlers.id, selectedBowlerIds)));
      if (members.length !== selectedBowlerIds.length) throw new RosterPaymentError("BOWLER_NOT_IN_LEAGUE", "Main must be an active member of this league", 422);
    }
    const existing = await tx.select().from(teamPaymentSlots).where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId), eq(teamPaymentSlots.teamId, input.teamId))).orderBy(asc(teamPaymentSlots.slotIndex)).for("update");
    if (existing.some((row) => row.slotIndex >= input.request.lineupSize)) throw new RosterPaymentError("LINEUP_SIZE_LOCKED", "Existing stable slots prevent reducing the league lineup size", 409);
    const saved = [];
    for (const value of slots) {
      const current = existing.find((row) => row.slotIndex === value.slotIndex);
      if (current) {
        if (current.lineupSize !== input.request.lineupSize || current.occupant !== value.occupant || current.mainBowlerId !== (value.mainBowlerId ?? null)) {
          const [updated] = await tx.update(teamPaymentSlots).set({ lineupSize: input.request.lineupSize, occupant: value.occupant, mainBowlerId: value.mainBowlerId ?? null, currentRevision: current.currentRevision + 1, updatedAt: new Date().toISOString() }).where(eq(teamPaymentSlots.id, current.id)).returning();
          await tx.insert(teamPaymentSlotRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, slotId: current.id, revisionNumber: updated.currentRevision, beforeSnapshot: current, afterSnapshot: updated, recordedByUserId: input.actorUserId });
          saved.push(updated);
        } else saved.push(current);
      } else {
        const [created] = await tx.insert(teamPaymentSlots).values({ organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, slotIndex: value.slotIndex, lineupSize: input.request.lineupSize, occupant: value.occupant, mainBowlerId: value.mainBowlerId ?? null, recordedByUserId: input.actorUserId }).returning();
        await tx.insert(teamPaymentSlotRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, slotId: created.id, revisionNumber: 1, beforeSnapshot: null, afterSnapshot: created, recordedByUserId: input.actorUserId });
        saved.push(created);
      }
    }
    if (input.request.policy) {
      const [existingPolicy] = await tx.select().from(teamPaymentPolicies).where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId), eq(teamPaymentPolicies.teamId, input.teamId))).limit(1).for("update");
      if (existingPolicy) {
        if (existingPolicy.defaultPolicy !== input.request.policy) {
          const [updated] = await tx.update(teamPaymentPolicies).set({ defaultPolicy: input.request.policy, currentRevision: existingPolicy.currentRevision + 1, updatedAt: new Date().toISOString() }).where(eq(teamPaymentPolicies.id, existingPolicy.id)).returning();
          await tx.insert(teamPaymentPolicyRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, policyId: existingPolicy.id, revisionNumber: updated.currentRevision, beforeSnapshot: existingPolicy, afterSnapshot: updated, recordedByUserId: input.actorUserId });
        }
      } else {
        const [created] = await tx.insert(teamPaymentPolicies).values({ organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, defaultPolicy: input.request.policy, recordedByUserId: input.actorUserId }).returning();
        await tx.insert(teamPaymentPolicyRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, policyId: created.id, revisionNumber: 1, beforeSnapshot: null, afterSnapshot: created, recordedByUserId: input.actorUserId });
      }
    }
    // A complete league roster is the sole activation signal in PR1. Once
    // every team has stable slots, resolve published/locked occurrences in
    // this same tenant+league transaction. Existing explicit substitute rows
    // remain evidence and are not overwritten by a default roster refresh.
    const rosterTeams = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true)));
    const rosterRows = await tx.select().from(teamPaymentSlots).where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId))).orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
    const rosterReady = rosterTeams.length > 0 && rosterTeams.every((candidate) => {
      const candidateSlots = rosterRows.filter((slot) => slot.teamId === candidate.id);
      return candidateSlots.length === league.payingLineupSize && candidateSlots.every((slot) => slot.occupant !== "unassigned");
    });
    if (rosterReady) {
      const policies = await tx.select().from(teamPaymentPolicies).where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId)));
      const occurrences = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt }).from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
        inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
      )).orderBy(asc(leagueOccurrences.startAt), asc(leagueOccurrences.id));
      const active = await tx.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, teamId: occurrencePaymentResponsibilities.teamId, slotIndex: occurrencePaymentResponsibilities.slotIndex, responsibilityKind: occurrencePaymentResponsibilities.responsibilityKind, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, substituteBowlerId: occurrencePaymentResponsibilities.substituteBowlerId, payerBowlerId: occurrencePaymentResponsibilities.payerBowlerId, policy: occurrencePaymentResponsibilities.policy }).from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
        eq(occurrencePaymentResponsibilities.state, "active"),
      ));
      for (const occurrence of occurrences) {
        const { dueAt, pastDueAt } = await deriveRosterPaymentTimingInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          paymentMode: league.paymentMode,
          occurrenceStartAt: occurrence.startAt,
        });
        const responsibilities = rosterTeams.flatMap((team) => rosterRows
          .filter((slot) => slot.teamId === team.id)
          .filter((slot) => {
            const current = active.find((row) => row.occurrenceId === occurrence.id && row.teamId === team.id && row.slotIndex === slot.slotIndex);
            // Keep an identical open roster resolution stable across retries
            // and unrelated roster saves. Explicit substitute/split evidence
            // is an occurrence override and therefore remains authoritative.
            if (current && ["substitute", "split"].includes(current.responsibilityKind)) return false;
            const kind = slot.occupant === "main" ? "main" : "vacant";
            const mainBowlerId = slot.occupant === "main" ? slot.mainBowlerId : null;
            const payerBowlerId = slot.occupant === "main" ? slot.mainBowlerId : null;
            const policy = policies.find((policy) => policy.teamId === team.id)?.defaultPolicy ?? "main_pays_full";
            return !current
              || current.responsibilityKind !== kind
              || current.mainBowlerId !== mainBowlerId
              || current.substituteBowlerId !== null
              || current.payerBowlerId !== payerBowlerId
              || current.policy !== policy;
          })
          .map((slot) => ({
            occurrenceId: occurrence.id,
            teamId: team.id,
            slotIndex: slot.slotIndex,
            positionIndex: slot.slotIndex,
            kind: slot.occupant === "main" ? "main" as const : "vacant" as const,
            mainBowlerId: slot.occupant === "main" ? slot.mainBowlerId : null,
            substituteBowlerId: null,
            payerBowlerId: slot.occupant === "main" ? slot.mainBowlerId : null,
            policy: policies.find((policy) => policy.teamId === team.id)?.defaultPolicy ?? "main_pays_full",
            amountMinor: slot.occupant === "main" ? league.weeklyFee : 0,
            lineageAmountMinor: null,
            prizeFundAmountMinor: null,
            dueAt,
            pastDueAt,
            assignmentNote: "roster_default",
          })));
        if (responsibilities.length === 0) continue;
        const materializationFingerprint = canonicalResponsibilityFingerprint(responsibilities);
        try {
          await recordOccurrenceResponsibilities({
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            actorUserId: input.actorUserId,
            commandKey: `roster:${occurrence.id}:${materializationFingerprint.slice(-32)}`,
            requestFingerprint: materializationFingerprint,
            responsibilities,
            transaction: tx,
          });
        } catch (error) {
          if (!(error instanceof RosterPaymentReplay)) throw error;
        }
      }
    }
    const result = { contractVersion: "roster-payment-responsibility/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, teamId: input.teamId, ready: saved.every((row) => row.occupant !== "unassigned"), slots: saved };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.save_team_roster", idempotencyKey: input.request.commandKey, result });
    return result;
  });
}

export async function readCanonicalDuePastDue(input: { organizationId: number; leagueId: number; payerBowlerId?: number }) {
  await leagueScope(input.organizationId, input.leagueId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (asOfResult.rows[0] as { as_of?: string } | undefined)?.as_of ?? new Date().toISOString();
    const now = new Date(asOf).getTime();
    const conditions = [eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)];
    if (input.payerBowlerId !== undefined) conditions.push(eq(paymentObligations.payerBowlerId, input.payerBowlerId));
    const obligations = await tx.select().from(paymentObligations).where(and(...conditions)).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id));
    const responsibilities = obligations.length === 0 ? [] : await tx.select({ id: occurrencePaymentResponsibilities.id, teamId: occurrencePaymentResponsibilities.teamId }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, obligations.map((obligation) => obligation.responsibilityId)),
    ));
    const teamByResponsibilityId = new Map(responsibilities.map((responsibility) => [responsibility.id, responsibility.teamId]));
    if (responsibilities.length !== new Set(obligations.map((obligation) => obligation.responsibilityId)).size) {
      throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its canonical responsibility", 503);
    }
    const allocations = obligations.length === 0 ? [] : await tx.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, obligations.map((obligation) => obligation.id)),
    ));
    const rows = obligations.map((obligation) => {
      const linked = allocations.filter((allocation) => allocation.obligationId === obligation.id);
      const allocatedMinor = linked.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const outstandingMinor = obligation.state === "voided" ? 0 : Math.max(0, obligation.amountMinor - allocatedMinor);
      const classification = linked.some((allocation) => allocation.reviewRequired)
        ? "review_required" as const
        : obligation.state === "voided"
          ? "voided" as const
          : obligation.state === "settled" || outstandingMinor === 0
          ? "settled" as const
          : now < new Date(obligation.dueAt).getTime()
            ? "future" as const
            : now < new Date(obligation.pastDueAt).getTime()
              ? "due" as const
              : "past_due" as const;
      const teamId = teamByResponsibilityId.get(obligation.responsibilityId);
      if (teamId === undefined) throw new RosterPaymentError("FINANCIAL_EVIDENCE_INVALID", "An obligation is missing its canonical team", 503);
      return { ...obligation, teamId, allocatedMinor, outstandingMinor, classification, reviewRequired: linked.some((allocation) => allocation.reviewRequired) };
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
    if (slots.some((slot) => slot.occupant === "unassigned") || teamIds.some((teamId) => slots.filter((slot) => slot.teamId === teamId).length !== lineupSize)) throw new RosterPaymentError("INCOMPLETE_ROSTER", "Payment readiness requires complete team rosters", 422);
    const activeResponsibilities = await tx.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, teamId: occurrencePaymentResponsibilities.teamId, slotIndex: occurrencePaymentResponsibilities.slotIndex, positionIndex: occurrencePaymentResponsibilities.positionIndex, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, substituteBowlerId: occurrencePaymentResponsibilities.substituteBowlerId }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceIds),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    const seenPositions = new Set<string>();
    const seenSubs = new Set<string>();
    const seenBowlers = new Set<string>();
    const mainRosterBowlerIds = new Set(slots.filter((slot) => slot.occupant === "main" && slot.mainBowlerId !== null).map((slot) => slot.mainBowlerId as number));
    const result = [];
    for (const row of input.responsibilities) {
      const slot = slots.find((candidate) => candidate.teamId === row.teamId && candidate.slotIndex === row.slotIndex);
      if (!slot) throw new RosterPaymentError("INVALID_SLOT", "Responsibility slot is not part of this team roster", 422);
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
        const currentObligations = await tx.select({ state: paymentObligations.state }).from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.responsibilityId, activeResponsibility.id),
        )).for("update");
        // A standing operation reserves an otherwise-open obligation before
        // provider dispatch. Treat that reservation as financial evidence:
        // roster edits cannot supersede it in the same lock window. The
        // league advisory lock is acquired by the caller, and the obligation
        // row was just locked above, so this check has deterministic lock
        // ordering with cutoff/manual paths.
        const reservedEvidence = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems)
          .innerJoin(paymentObligations, and(
            eq(paymentOperationRosterSnapshotItems.obligationId, paymentObligations.id),
            eq(paymentOperationRosterSnapshotItems.organizationId, paymentObligations.organizationId),
            eq(paymentOperationRosterSnapshotItems.leagueId, paymentObligations.leagueId),
          ))
          .where(and(
            eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
            eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
            eq(paymentOperationRosterSnapshotItems.state, "reserved"),
            eq(paymentObligations.responsibilityId, activeResponsibility.id),
          )).limit(1).for("update");
        if (reservedEvidence.length > 0) {
          throw new RosterPaymentError("OBLIGATION_RESERVED", "A standing payment operation has reserved this roster responsibility", 409);
        }
        if (currentObligations.some((obligation) => obligation.state !== "open")) {
          throw new RosterPaymentError("PAID_EVIDENCE_LOCKED", "A responsibility with settled or partially settled evidence cannot be replaced", 409);
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
  outstandingMinor: number;
  dueAt: string;
  pastDueAt: string;
  payerBowlerId: number;
  currency: "USD";
  memberOrdinal: number;
  billingOrdinal: number;
  reservedMinor: number;
  reviewRequired: boolean;
  pairedCollectionReady: boolean;
  effectiveCollectionAt: string;
};

/** Pure FIFO allocator used by the transaction-bound quote and finalizer. */
export function allocateAutomaticFifoPayment(
  amountMinor: number,
  candidates: FifoPaymentCandidate[],
  paymentMode: "weekly" | "upfront",
  nowIso = new Date().toISOString(),
): Array<{ obligationId: string; amountMinor: number }> {
  try { return allocateFifo(amountMinor, candidates, paymentMode, nowIso); }
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

async function fifoCandidatesInTransaction(
  tx: RosterPaymentTransaction,
  input: { organizationId: number; leagueId: number; payerBowlerId: number; now: string },
): Promise<FifoPaymentCandidate[]> {
  const rows = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    eq(paymentObligations.payerBowlerId, input.payerBowlerId),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
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
  const allocations = await tx.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(
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
  const reservations = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    inArray(paymentOperationRosterSnapshotItems.obligationId, rows.map((row) => row.id)),
  )).for("update");
  const reservedById = new Map<string, number>();
  for (const row of reservations) reservedById.set(row.obligationId, (reservedById.get(row.obligationId) ?? 0) + row.amountMinor);
  return rows.map((row) => {
    const member = groupByOccurrence.get(row.occurrenceId);
    const triggerAt = member ? triggerAtByGroup.get(member.groupId) : undefined;
    const pairedCollectionReady = member?.role === "paired" && triggerAt !== undefined && triggerAt <= input.now;
    return {
      id: row.id,
      responsibilityId: row.responsibilityId,
      occurrenceId: row.occurrenceId,
      amountMinor: row.amountMinor,
      // Reservations remain part of the oldest candidate's capacity. They
      // are deliberately excluded from the available balance but must stay
      // visible to the allocator so it fails closed instead of skipping a
      // fully-reserved oldest obligation and collecting a later one.
      outstandingMinor: Math.max(0, row.amountMinor - (allocatedById.get(row.id) ?? 0)),
      dueAt: new Date(row.dueAt).toISOString(),
      pastDueAt: new Date(row.pastDueAt).toISOString(),
      payerBowlerId: row.payerBowlerId,
      currency: row.currency as "USD",
      memberOrdinal: member?.memberOrdinal ?? 0,
      billingOrdinal: billingByOccurrence.get(row.occurrenceId) as number,
      reservedMinor: reservedById.get(row.id) ?? 0,
      reviewRequired: reviewById.get(row.id) ?? false,
      pairedCollectionReady,
      effectiveCollectionAt: member?.role === "paired" && pairedCollectionReady && triggerAt !== undefined ? triggerAt : new Date(row.dueAt).toISOString(),
    };
  });
}

export async function quoteInteractiveObligations(input: FifoQuoteInput & { organizationId: number; leagueId: number }) {
  const run = async (tx: RosterPaymentTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).for("share");
    if (!league) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
    const payerBowlerId = input.payerBowlerId;
    const [payer] = await tx.select({ id: bowlers.id }).from(bowlers).innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true))).where(and(eq(bowlers.id, payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
    if (!payer) throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "The payment payer is not an active member of this league", 403);
    const nowResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const now = (nowResult.rows[0] as { now?: string } | undefined)?.now ?? new Date().toISOString();
    const allCandidates = await fifoCandidatesInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId, now: new Date(now).toISOString() });
    const candidates = allCandidates;
    const amountMinor = input.amountMinor;
    const allocations = allocateAutomaticFifoPayment(amountMinor, candidates, league.paymentMode, new Date(now).toISOString());
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
      const activeTotal = (await tx.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, obligation.id), eq(paymentAllocations.state, "active"))).for("update")).reduce((sum, row) => sum + row.amountMinor, 0);
      await tx.update(paymentObligations).set({ state: activeTotal >= obligation.amountMinor ? "settled" : "partially_settled" }).where(and(eq(paymentObligations.id, obligation.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
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
      const active = await tx.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, obligation.id), eq(paymentAllocations.state, "active")));
      const total = active.reduce((sum, row) => sum + row.amountMinor, 0);
      await tx.update(paymentObligations).set({ state: total >= obligation.amountMinor ? "settled" : total > 0 ? "partially_settled" : "open" }).where(and(eq(paymentObligations.id, obligation.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
    }
    const result = { contractVersion: "canonical-correction/3" as const, mode: "void_only" as const, payment: { ...payment, status: "voided" as const }, voidEvidence, voidedAllocations: allocations, restoredObligationIds: obligationIds };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.void_payment", idempotencyKey: input.request.idempotencyKey, result });
    return result;
  });
}

export type RosterPaymentResponsibilityInput = OccurrenceResponsibilityInput;
