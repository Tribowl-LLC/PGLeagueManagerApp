import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  interactivePaymentOperationSnapshots,
  type TeamPaymentPolicy,
} from "@shared/schema";
import type {
  CanonicalCorrectionRequest,
  CanonicalManualRecordRequest,
  OccurrenceResponsibilityInput,
  RosterPaymentResponsibilityRequest,
} from "@shared/roster-payment-contract";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { prepareInteractivePaymentOperation } from "./interactive-payment-operation-preparation.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { WEEKLY_BILLING_GRACE_PERIOD_MS } from "@shared/schedule-utils";
import { decrypt } from "../utils/crypto.js";

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

function quoteFingerprint(obligations: Array<{ id: string; amountMinor: number; dueAt: string; payerBowlerId: number }>): string {
  const value = obligations.map((row) => [row.id, row.amountMinor, row.dueAt, row.payerBowlerId]).join("|");
  return `lvrosterquote:v1:${createHash("sha256").update(value).digest("hex")}`;
}

function commandFingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalRosterFingerprint(request: RosterPaymentResponsibilityRequest & { policy?: TeamPaymentPolicy }): string {
  return commandFingerprint("lvroster:v1", {
    lineupSize: request.lineupSize,
    policy: request.policy ?? "main_pays_full",
    slots: [...request.slots].sort((a, b) => a.slotIndex - b.slotIndex).map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
  });
}

function canonicalResponsibilityFingerprint(rows: OccurrenceResponsibilityInput[]): string {
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

function canonicalCorrectionFingerprint(request: CanonicalCorrectionRequest): string {
  return commandFingerprint("lvcorrection:v2", {
    allocationId: request.allocationId,
    correctionMode: request.correctionMode,
    reason: request.reason,
    replacementAmountMinor: request.replacementAmountMinor ?? null,
    replacementType: request.replacementType ?? null,
    replacementCheckNumber: request.replacementCheckNumber ?? null,
    replacementWeekOf: request.replacementWeekOf ?? null,
    replacementNotes: request.replacementNotes ?? null,
  });
}

export function calculateRosterPaymentTiming(dueAt: string | Date): { dueAt: string; pastDueAt: string } {
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) throw new RosterPaymentError("INVALID_DUE_AT", "The occurrence start time is invalid", 422);
  return { dueAt: due.toISOString(), pastDueAt: new Date(due.getTime() + WEEKLY_BILLING_GRACE_PERIOD_MS).toISOString() };
}

async function leagueScope(organizationId: number, leagueId: number): Promise<{ id: number; organizationId: number; locationId: number | null; payingLineupSize: number | null; weeklyFee: number; substituteAccess: "team_only" | "floating"; substitutePaymentRegime: "team_choice" | "league_lineage_prize_split"; lineageFee: number | null; prizeFundFee: number | null }> {
  const [league] = await db.select({ id: leagues.id, organizationId: leagues.organizationId, locationId: leagues.locationId, payingLineupSize: leagues.payingLineupSize, weeklyFee: leagues.weeklyFee, substituteAccess: leagues.substituteAccess, substitutePaymentRegime: leagues.substitutePaymentRegime, lineageFee: leagues.lineageFee, prizeFundFee: leagues.prizeFundFee })
    .from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, organizationId))).limit(1);
  if (!league || league.organizationId !== organizationId) throw new RosterPaymentError("NOT_FOUND", "League not found", 404);
  return { ...league, organizationId };
}

export async function readRosterPaymentResponsibility(input: { organizationId: number; leagueId: number }) {
  const league = await leagueScope(input.organizationId, input.leagueId);
  const teamRows = await db.select({ id: teams.id, name: teams.name, number: teams.number })
    .from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true))).orderBy(asc(teams.displayOrder), asc(teams.number), asc(teams.id));
  const slots = await db.select().from(teamPaymentSlots)
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
  const incompleteTeams = teamRows.filter((team) => {
    const rows = slotsByTeam.get(team.id) ?? [];
    return league.payingLineupSize === null || rows.length !== league.payingLineupSize || rows.some((row) => row.occupant === "unassigned");
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
        const { dueAt, pastDueAt } = calculateRosterPaymentTiming(occurrence.startAt);
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
            mainBowlerId: slot.mainBowlerId,
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
      return { ...obligation, allocatedMinor, outstandingMinor, classification, reviewRequired: linked.some((allocation) => allocation.reviewRequired) };
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
      if (row.kind === "split" && (!row.substituteBowlerId || !slot.mainBowlerId || row.amountMinor <= 0 || row.substituteBowlerId === slot.mainBowlerId)) throw new RosterPaymentError("INVALID_SPLIT", "Split responsibility requires distinct Main and Substitute", 422);
      // A stable VACANT slot is itself valid zero-obligation evidence. A
      // Substitute may additionally fill it for an occurrence, in which case
      // the substitute row is the billable responsibility.
      if (slot.occupant === "vacant" && row.kind !== "substitute" && row.kind !== "vacant") throw new RosterPaymentError("VACANT_REQUIRES_SUBSTITUTE", "A VACANT slot can only be filled by a Substitute", 422);
      if (slot.occupant === "vacant" && row.kind === "substitute" && !row.substituteBowlerId) throw new RosterPaymentError("INVALID_SUBSTITUTE", "A Substitute is required to fill a VACANT slot", 422);
      const effectivePolicy = slot.occupant === "vacant" && row.kind === "substitute" ? "sub_pays_full" as const : row.policy;
      const occurrence = occurrences.find((candidate) => candidate.id === row.occurrenceId);
      if (!occurrence) throw new RosterPaymentError("OCCURRENCE_NOT_PUBLISHED", "Occurrence not found", 422);
      const { dueAt: authoritativeDueAt, pastDueAt: authoritativePastDueAt } = calculateRosterPaymentTiming(occurrence.startAt);
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
      const [currentResponsibility] = await tx.select().from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
        eq(occurrencePaymentResponsibilities.occurrenceId, row.occurrenceId),
        eq(occurrencePaymentResponsibilities.teamId, row.teamId),
        eq(occurrencePaymentResponsibilities.slotIndex, row.slotIndex),
        eq(occurrencePaymentResponsibilities.positionIndex, row.positionIndex),
        eq(occurrencePaymentResponsibilities.state, "active"),
      )).limit(1).for("update");
      let version = 1;
      let responsibilityKey: string | undefined;
      if (currentResponsibility) {
        const currentObligations = await tx.select({ state: paymentObligations.state }).from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.responsibilityId, currentResponsibility.id),
        )).for("update");
        if (currentObligations.some((obligation) => obligation.state !== "open")) {
          throw new RosterPaymentError("PAID_EVIDENCE_LOCKED", "A responsibility with settled or partially settled evidence cannot be replaced", 409);
        }
        version = currentResponsibility.version + 1;
        responsibilityKey = currentResponsibility.responsibilityKey;
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, currentResponsibility.id));
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
          eq(paymentObligations.responsibilityId, currentResponsibility.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          inArray(paymentObligations.state, ["open", "partially_settled"] as const),
        ));
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

export async function quoteInteractiveObligations(input: { organizationId: number; leagueId: number; obligationIds: string[]; payerBowlerId?: number; transaction?: RosterPaymentTransaction }) {
  const run = async (tx: RosterPaymentTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const rows = await tx.select().from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.id, input.obligationIds))).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
    if (rows.length !== input.obligationIds.length || new Set(rows.map((row) => row.id)).size !== input.obligationIds.length) throw new RosterPaymentError("EXACT_OBLIGATIONS_REQUIRED", "Every selected obligation must belong to this league", 422);
    const payerIds = new Set(rows.map((row) => row.payerBowlerId));
    if (payerIds.size !== 1 || (input.payerBowlerId !== undefined && [...payerIds][0] !== input.payerBowlerId)) {
      throw new RosterPaymentError("PAYER_SCOPE_MISMATCH", "Selected obligations must belong to one payer", 422);
    }
    if (rows.some((row) => row.state !== "open" && row.state !== "partially_settled")) throw new RosterPaymentError("OBLIGATION_NOT_OPEN", "One or more obligations are no longer open", 409);
    const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, input.obligationIds),
      inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
    )).for("update");
    if (reservations.length > 0) throw new RosterPaymentError("OBLIGATION_RESERVED", "A provider operation has already reserved one or more obligations", 409);
    const allocations = await tx.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, input.obligationIds),
    )).orderBy(asc(paymentAllocations.obligationId), asc(paymentAllocations.id)).for("update");
    const allocated = new Map<string, number>();
    for (const allocation of allocations) allocated.set(allocation.obligationId, (allocated.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const obligations = rows.map((row) => ({ ...row, outstandingMinor: Math.max(0, row.amountMinor - (allocated.get(row.id) ?? 0)) }));
    if (obligations.some((row) => row.outstandingMinor <= 0)) throw new RosterPaymentError("OBLIGATION_ALREADY_ALLOCATED", "One or more obligations has no outstanding balance", 409);
    const totalAmountMinor = obligations.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const fingerprintRows = obligations.map((row) => ({ id: row.id, amountMinor: row.outstandingMinor, dueAt: row.dueAt, payerBowlerId: row.payerBowlerId }));
    return { contractVersion: "interactive-obligation-quote/2" as const, organizationId: input.organizationId, leagueId: input.leagueId, currency: "USD" as const, amountMinor: totalAmountMinor, obligations, fingerprint: quoteFingerprint(fingerprintRows) };
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

/** Prepare and dispatch one exact-obligation interactive charge. Provider
 * calls happen only after the operation snapshot commits; allocation writes
 * happen in a second locked transaction after a durable provider result. */
export async function chargeInteractiveObligations(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  payerBowlerId?: number;
  request: {
    obligationIds: string[];
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
      const [existingInteractiveSnapshot] = await tx.select().from(interactivePaymentOperationSnapshots).where(eq(interactivePaymentOperationSnapshots.operationId, existingOperation.id)).limit(1).for("share");
      const requestedPayer = input.payerBowlerId;
      const storedSourceId = existingInteractiveSnapshot ? decrypt(existingInteractiveSnapshot.encryptedSourceId) : null;
      const storedBuyerEmail = existingInteractiveSnapshot?.encryptedBuyerEmail ? decrypt(existingInteractiveSnapshot.encryptedBuyerEmail) : null;
      if (!existingInteractiveSnapshot
        || (requestedPayer !== undefined && existingInteractiveSnapshot.payerBowlerId !== requestedPayer)
        || existingInteractiveSnapshot.sourceKind !== input.request.sourceKind
        || existingInteractiveSnapshot.storeCard !== (input.request.storeCard === true)
        || storedSourceId !== input.request.sourceId
        || storedBuyerEmail !== (input.request.buyerEmail ?? null)) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different payment identity", 409);
      }
      const [existingSnapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.operationId, existingOperation.id),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share");
      if (!existingSnapshot) throw new RosterPaymentError("OPERATION_SNAPSHOT_MISSING", "The payment operation has no immutable roster snapshot", 409);
      const existingItems = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId })
        .from(paymentOperationRosterSnapshotItems)
        .where(and(
          eq(paymentOperationRosterSnapshotItems.operationId, existingOperation.id),
          eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
        ))
        .orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
      const requestedIds = [...new Set(input.request.obligationIds)].sort();
      const existingIds = existingItems.map((item) => item.obligationId).sort();
      if (existingSnapshot.snapshotFingerprint !== input.request.requestFingerprint
        || requestedIds.length !== existingIds.length
        || requestedIds.some((id, index) => id !== existingIds[index])) {
        throw new RosterPaymentError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different obligation request", 409);
      }
      return { operation: existingOperation, quote: null, reused: true };
    }
    const quote = await quoteInteractiveObligations({ organizationId: input.organizationId, leagueId: input.leagueId, obligationIds: input.request.obligationIds, payerBowlerId: input.payerBowlerId, transaction: tx });
    if (quote.fingerprint !== input.request.requestFingerprint) throw new RosterPaymentError("STALE_QUOTE", "The obligation quote is stale; request a new quote", 409);
    const first = quote.obligations[0];
    if (!first) throw new RosterPaymentError("EXACT_OBLIGATIONS_REQUIRED", "At least one obligation is required", 422);
    const payerBowlerId = input.payerBowlerId ?? first.payerBowlerId;
    if (input.request.sourceKind === "saved_card" && input.payerBowlerId === undefined) {
      throw new RosterPaymentError("SAVED_CARD_PAYER_REQUIRED", "A saved payment method requires an authenticated payer", 403);
    }
    const [payerBowler] = await tx.select().from(bowlers).where(and(
      eq(bowlers.id, payerBowlerId),
      eq(bowlers.organizationId, input.organizationId),
    )).limit(1).for("share");
    if (!payerBowler) throw new RosterPaymentError("NOT_FOUND", "The payment payer is unavailable", 404);
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
      buyerEmail: input.request.buyerEmail ?? null,
      storeCard: input.request.storeCard === true,
      sourceKind: input.request.sourceKind,
      weekOf: first.dueAt,
      combined: quote.obligations.length > 1,
      allocations: quote.obligations.map((obligation, allocationIndex) => ({
        allocationIndex,
        bowlerId: obligation.payerBowlerId,
        amountMinor: obligation.outstandingMinor,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        weekOf: obligation.dueAt,
        notes: `Roster obligation ${obligation.id}`,
        paidByUserId: input.actorUserId,
      })),
      lineItems: [],
      transaction: tx,
    });
    const responsibilityIds = [...new Set(quote.obligations.map((obligation) => obligation.responsibilityId))];
    const responsibilityVersions = await tx.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).for("share");
    const responsibilityVersionById = new Map(responsibilityVersions.map((row) => [row.id, row.version]));
    if (responsibilityIds.some((id) => !responsibilityVersionById.has(id))) throw new RosterPaymentError("RESERVATION_STALE", "A roster responsibility changed while the quote was being prepared", 409);
    await tx.insert(paymentOperationRosterSnapshots).values({
      operationId: operation.id,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      snapshotVersion: 1,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      obligations: quote.obligations.map((obligation) => ({ id: obligation.id, responsibilityId: obligation.responsibilityId, responsibilityVersion: responsibilityVersionById.get(obligation.responsibilityId), payerBowlerId: obligation.payerBowlerId, amountMinor: obligation.outstandingMinor, dueAt: obligation.dueAt, pastDueAt: obligation.pastDueAt })),
      snapshotFingerprint: quote.fingerprint,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values(quote.obligations.map((obligation, allocationIndex) => ({
      operationId: operation.id,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligationId: obligation.id,
      allocationIndex,
      amountMinor: obligation.outstandingMinor,
      state: "reserved" as const,
    })));
    return { operation, quote, reused: false };
  });
  const operation = prepared.operation;
  const executed = await interactivePaymentOperationExecutor.execute({ organizationId: input.organizationId, operationId: operation.id });
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
    if (!storedOperation || storedOperation.status !== "succeeded") throw new RosterPaymentError("PAYMENT_NOT_SETTLED", "Provider payment is not locally settled", 409);
    const [rosterSnapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.operationId, operation.id), eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId))).limit(1).for("share");
    const snapshotItems = await tx.select().from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.operationId, operation.id), eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId))).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex)).for("update");
    if (!rosterSnapshot || snapshotItems.length === 0) throw new RosterPaymentError("OPERATION_SNAPSHOT_MISSING", "The payment operation has no immutable roster reservation", 409);
    const paymentRows = await tx.select().from(payments).where(and(eq(payments.leagueId, input.leagueId), eq(payments.paymentOperationId, operation.id))).orderBy(asc(payments.paymentOperationAllocationIndex), asc(payments.id)).for("update");
    if (paymentRows.length !== snapshotItems.length) throw new RosterPaymentError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete", 409);
    // A retried request may observe a provider operation that was already
    // finalized locally. The immutable reservation is the replay proof; do
    // not attempt a second allocation against an already-conserved amount.
    if (snapshotItems.every((item) => item.state === "finalized")) {
      return { contractVersion: "interactive-obligation-charge/2" as const, operationId: storedOperation.id, status: storedOperation.status, providerPaymentId: storedOperation.providerObjectId, records: [] };
    }
    const obligations = await tx.select().from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.id, snapshotItems.map((item) => item.obligationId)))).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
    if (obligations.length !== snapshotItems.length) throw new RosterPaymentError("EXACT_OBLIGATIONS_REQUIRED", "The immutable roster snapshot references missing obligations", 409);
    const snapshotRecords = Array.isArray(rosterSnapshot.obligations) ? rosterSnapshot.obligations as Array<{ id?: string; responsibilityId?: string; responsibilityVersion?: number }> : [];
    const snapshotResponsibilityIds = [...new Set(snapshotRecords.map((record) => record.responsibilityId).filter((id): id is string => typeof id === "string"))];
    const liveResponsibilities = snapshotResponsibilityIds.length === 0 ? [] : await tx.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, snapshotResponsibilityIds),
    )).for("update");
    const liveResponsibilityById = new Map(liveResponsibilities.map((row) => [row.id, row]));
    const staleReservation = obligations.some((obligation) => {
      const record = snapshotRecords.find((candidate) => candidate.id === obligation.id);
      const live = record?.responsibilityId ? liveResponsibilityById.get(record.responsibilityId) : undefined;
      return !record || record.responsibilityId !== obligation.responsibilityId || record.responsibilityVersion === undefined || !live || live.state !== "active" || live.version !== record.responsibilityVersion;
    });
    if (staleReservation) {
      await tx.update(paymentOperations).set({ status: "reconciliation_required", errorClassification: "internal", errorCode: "ROSTER_VERSION_CHANGED", updatedAt: new Date().toISOString() }).where(and(
        eq(paymentOperations.id, storedOperation.id),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      ));
      throw new RosterPaymentError("RESERVATION_STALE", "The roster responsibility changed after provider dispatch; payment evidence requires reconciliation", 409);
    }
    if (obligations.some((obligation) => obligation.state === "voided")) {
      await tx.update(paymentOperations).set({ status: "reconciliation_required", errorClassification: "internal", errorCode: "OBLIGATION_VOIDED", updatedAt: new Date().toISOString() }).where(and(
        eq(paymentOperations.id, storedOperation.id),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      ));
      throw new RosterPaymentError("OBLIGATION_VOIDED", "The provider payment references a voided obligation; payment evidence requires reconciliation", 409);
    }
    const created = [];
    for (const item of snapshotItems) {
      // A provider finalization can commit one allocation and crash before
      // the remaining snapshot items. Retrying must preserve the committed
      // item and settle only the still-reserved remainder.
      if (item.state === "finalized") continue;
      const obligation = obligations.find((row) => row.id === item.obligationId);
      const payment = paymentRows.find((row) => row.paymentOperationAllocationIndex === item.allocationIndex) ?? paymentRows[item.allocationIndex];
      if (!obligation || !payment || payment.amount !== item.amountMinor) throw new RosterPaymentError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment amount does not match the immutable roster quote", 409);
      const active = await tx.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.obligationId, obligation.id), eq(paymentAllocations.state, "active"))).for("update");
      const allocatedMinor = active.reduce((sum, row) => sum + row.amountMinor, 0);
      if (allocatedMinor + item.amountMinor > obligation.amountMinor) throw new RosterPaymentError("ALLOCATION_CONSERVATION_FAILED", "The immutable roster payment exceeds the obligation", 409);
      const [allocation] = await tx.insert(paymentAllocations).values({ organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id, obligationId: obligation.id, amountMinor: item.amountMinor, currency: obligation.currency, recordedByUserId: input.actorUserId }).returning();
      const nextTotal = allocatedMinor + item.amountMinor;
      await tx.update(paymentObligations).set({ state: nextTotal >= obligation.amountMinor ? "settled" : "partially_settled" }).where(and(eq(paymentObligations.id, obligation.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
      await tx.update(paymentOperationRosterSnapshotItems).set({ state: "finalized" }).where(and(eq(paymentOperationRosterSnapshotItems.id, item.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
      created.push({ payment, allocation });
    }
    return { contractVersion: "interactive-obligation-charge/2" as const, operationId: storedOperation.id, status: storedOperation.status, providerPaymentId: storedOperation.providerObjectId, records: created };
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
    const obligations = await tx.select().from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.id, input.request.obligationIds))).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
    if (obligations.length !== input.request.obligationIds.length || obligations.some((row) => row.state !== "open" && row.state !== "partially_settled")) throw new RosterPaymentError("EXACT_OBLIGATIONS_REQUIRED", "Manual records require exact open obligations", 422);
    const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, input.request.obligationIds),
      inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
    )).for("update");
    if (reservations.length > 0) throw new RosterPaymentError("OBLIGATION_RESERVED", "A provider operation has already reserved one or more obligations", 409);
    const existing = await tx.select({ obligationId: paymentAllocations.obligationId, allocationId: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor, state: paymentAllocations.state, supersedesAllocationId: paymentAllocations.supersedesAllocationId }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), inArray(paymentAllocations.obligationId, input.request.obligationIds))).for("update");
    const allocated = new Map<string, number>();
    for (const row of existing.filter((candidate) => candidate.state === "active")) allocated.set(row.obligationId, (allocated.get(row.obligationId) ?? 0) + row.amountMinor);
    const outstanding = obligations.map((row) => ({ ...row, outstandingMinor: Math.max(0, row.amountMinor - (allocated.get(row.id) ?? 0)) }));
    if (outstanding.some((row) => row.outstandingMinor <= 0)) throw new RosterPaymentError("OBLIGATION_ALREADY_ALLOCATED", "An obligation is already allocated", 409);
    if (input.request.requestFingerprint !== quoteFingerprint(outstanding.map((row) => ({ id: row.id, amountMinor: row.outstandingMinor, dueAt: row.dueAt, payerBowlerId: row.payerBowlerId })))) throw new RosterPaymentError("STALE_QUOTE", "The obligation quote is stale; request a new quote", 409);
    const created = [];
    for (let index = 0; index < outstanding.length; index += 1) {
      const obligation = outstanding[index];
      const [payment] = await tx.insert(payments).values({ bowlerId: obligation.payerBowlerId, leagueId: input.leagueId, amount: obligation.outstandingMinor, weekOf: obligation.dueAt, status: "paid", type: input.request.type, checkNumber: input.request.checkNumber, notes: input.request.notes, idempotencyKey: `${input.request.idempotencyKey}:${index}` }).returning();
      const [allocation] = await tx.insert(paymentAllocations).values({ organizationId: input.organizationId, leagueId: input.leagueId, paymentId: payment.id, obligationId: obligation.id, amountMinor: obligation.outstandingMinor, currency: obligation.currency, recordedByUserId: input.actorUserId }).returning();
      await tx.update(paymentObligations).set({ state: "settled" }).where(eq(paymentObligations.id, obligation.id));
      created.push({ payment, allocation });
    }
    const result = { contractVersion: "canonical-manual-record/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, records: created };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.manual_record", idempotencyKey: input.request.idempotencyKey, result });
    return result;
  });
}

export async function correctCanonicalAllocation(input: { organizationId: number; leagueId: number; actorUserId: number; request: CanonicalCorrectionRequest }) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await beginFinancialCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "roster_payment.correct_allocation",
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
    });
    const [allocation] = await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.id, input.request.allocationId), eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId))).limit(1).for("update");
    if (!allocation) throw new RosterPaymentError("NOT_FOUND", "Allocation not found", 404);
    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, allocation.paymentId),
      eq(payments.leagueId, input.leagueId),
    )).limit(1).for("share");
    if (!payment || (payment.type !== "cash" && payment.type !== "check")) {
      throw new RosterPaymentError("PROVIDER_ALLOCATION_IMMUTABLE", "Provider payment evidence requires refund or reconciliation; it cannot be directly corrected", 409);
    }
    if (input.request.requestFingerprint !== canonicalCorrectionFingerprint(input.request)) throw new RosterPaymentError("INVALID_FINGERPRINT", "The correction request fingerprint is invalid", 422);
    if (input.request.correctionMode === "replace" && input.request.replacementType === "check" && !input.request.replacementCheckNumber) {
      throw new RosterPaymentError("CHECK_NUMBER_REQUIRED", "A replacement check requires a check number", 422);
    }
    if (allocation.state !== "active") throw new RosterPaymentError("ALLOCATION_NOT_ACTIVE", "Allocation is already corrected", 409);
    const reservation = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.obligationId, allocation.obligationId),
      inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
    )).limit(1).for("update");
    if (reservation.length > 0) throw new RosterPaymentError("OBLIGATION_RESERVED", "A provider operation has already reserved this obligation", 409);
    const [priorCorrection] = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(eq(paymentAllocations.supersedesAllocationId, allocation.id), eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId))).limit(1);
    if (priorCorrection) throw new RosterPaymentError("ALLOCATION_NOT_ACTIVE", "Allocation is already corrected", 409);
    const [voided] = await tx.update(paymentAllocations).set({ state: "voided", correctionReason: input.request.reason }).where(and(
      eq(paymentAllocations.id, allocation.id),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
    )).returning();
    if (!voided) throw new RosterPaymentError("ALLOCATION_NOT_ACTIVE", "Allocation is already corrected", 409);
    const [correctionEvidence] = await tx.insert(paymentAllocations).values({ organizationId: input.organizationId, leagueId: input.leagueId, paymentId: allocation.paymentId, obligationId: allocation.obligationId, amountMinor: allocation.amountMinor, currency: allocation.currency, state: "voided", supersedesAllocationId: allocation.id, correctionReason: input.request.reason, recordedByUserId: input.actorUserId }).returning();
    const remaining = await tx.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.obligationId, allocation.obligationId),
      eq(paymentAllocations.state, "active"),
    )).for("update");
    const [obligation] = await tx.select({ amountMinor: paymentObligations.amountMinor }).from(paymentObligations).where(eq(paymentObligations.id, allocation.obligationId)).limit(1).for("share");
    const remainingTotal = remaining.reduce((sum, row) => sum + row.amountMinor, 0);
    let replacement: { payment: typeof payments.$inferSelect; allocation: typeof paymentAllocations.$inferSelect } | null = null;
    if (input.request.correctionMode === "replace") {
      const amountMinor = input.request.replacementAmountMinor ?? 0;
      if (amountMinor <= 0 || amountMinor + remainingTotal > (obligation?.amountMinor ?? 0)) {
        throw new RosterPaymentError("ALLOCATION_CONSERVATION_FAILED", "The replacement amount exceeds the obligation's remaining balance", 422);
      }
      const replacementWeekOf = input.request.replacementWeekOf ?? payment.weekOf;
      const replacementType = input.request.replacementType ?? payment.type;
      const [replacementPayment] = await tx.insert(payments).values({
        bowlerId: payment.bowlerId,
        leagueId: input.leagueId,
        amount: amountMinor,
        weekOf: replacementWeekOf,
        status: "paid",
        type: replacementType,
        checkNumber: replacementType === "check" ? input.request.replacementCheckNumber : null,
        notes: input.request.replacementNotes ?? payment.notes,
        idempotencyKey: `${input.request.idempotencyKey}:replacement`,
      }).returning();
      const [replacementAllocation] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: replacementPayment.id,
        obligationId: allocation.obligationId,
        amountMinor,
        currency: allocation.currency,
        state: "active",
        supersedesAllocationId: allocation.id,
        correctionReason: input.request.reason,
        recordedByUserId: input.actorUserId,
      }).returning();
      replacement = { payment: replacementPayment, allocation: replacementAllocation };
    }
    const settledTotal = remainingTotal + (replacement?.allocation.amountMinor ?? 0);
    await tx.update(paymentObligations).set({ state: settledTotal >= (obligation?.amountMinor ?? 0) ? "settled" : settledTotal > 0 ? "partially_settled" : "open" }).where(and(eq(paymentObligations.id, allocation.obligationId), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId)));
    const result = { contractVersion: "canonical-correction/2" as const, mode: input.request.correctionMode, voidedAllocation: voided, correctionEvidence, replacement, restoredObligationId: allocation.obligationId };
    await completeFinancialCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: "roster_payment.correct_allocation", idempotencyKey: input.request.idempotencyKey, result });
    return result;
  });
}

export type RosterPaymentResponsibilityInput = OccurrenceResponsibilityInput;
