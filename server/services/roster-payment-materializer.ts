import { and, asc, eq, inArray, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  leagueOccurrences,
  leagues,
  occurrencePaymentResponsibilities,
  paymentObligations,
  teamPaymentPolicies,
  teamPaymentSlots,
  teams,
} from "@shared/schema";
import type * as schema from "@shared/schema";

type PaymentOperationTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const GRACE_PERIOD_MS = 3 * 60 * 60 * 1000;

/**
 * Database-only publication hook for a roster-ready occurrence. It is kept
 * free of the provider factory and app db singleton so schedule operators can
 * use it inside their existing transaction without importing payment I/O.
 */
export async function materializeRosterPaymentOccurrenceInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; occurrenceId: string; actorUserId: number },
): Promise<boolean> {
  const [league] = await tx.select({
    payingLineupSize: leagues.payingLineupSize,
    weeklyFee: leagues.weeklyFee,
  }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league?.payingLineupSize) return false;
  const [occurrence] = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt })
    .from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, input.occurrenceId),
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
      inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
    )).limit(1);
  if (!occurrence) return false;
  const rosterTeams = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true)));
  const rosterRows = await tx.select().from(teamPaymentSlots)
    .where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId)))
    .orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
  if (rosterTeams.length === 0 || !rosterTeams.every((team) => {
    const rows = rosterRows.filter((slot) => slot.teamId === team.id);
    return rows.length === league.payingLineupSize && rows.every((slot) => slot.occupant !== "unassigned");
  })) return false;
  const policies = await tx.select().from(teamPaymentPolicies).where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId)));
  const active = await tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  const pastDueAt = new Date(new Date(occurrence.startAt).getTime() + GRACE_PERIOD_MS).toISOString();
  for (const team of rosterTeams) {
    for (const slot of rosterRows.filter((row) => row.teamId === team.id)) {
      const policy = policies.find((row) => row.teamId === team.id)?.defaultPolicy ?? "main_pays_full";
      const kind = slot.occupant === "main" ? "main" as const : "vacant" as const;
      const mainBowlerId = kind === "main" ? slot.mainBowlerId : null;
      const payerBowlerId = mainBowlerId;
      const current = active.find((row) => row.teamId === team.id && row.slotIndex === slot.slotIndex && row.positionIndex === slot.slotIndex);
      if (current && (current.responsibilityKind === "substitute" || current.responsibilityKind === "split")) continue;
      if (current && current.responsibilityKind === kind && current.mainBowlerId === mainBowlerId && current.substituteBowlerId === null && current.payerBowlerId === payerBowlerId && current.policy === policy) continue;
      if (current) {
        const currentObligations = await tx.select({ state: paymentObligations.state }).from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.responsibilityId, current.id),
        ));
        if (currentObligations.some((row) => row.state !== "open")) throw new Error("PAID_EVIDENCE_LOCKED");
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
          eq(occurrencePaymentResponsibilities.id, current.id),
          eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
          eq(occurrencePaymentResponsibilities.state, "active"),
        ));
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
          eq(paymentObligations.responsibilityId, current.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.state, "open"),
        ));
      }
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: occurrence.id,
        teamId: team.id,
        slotId: slot.id,
        slotIndex: slot.slotIndex,
        positionIndex: slot.slotIndex,
        version: (current?.version ?? 0) + 1,
        state: "active",
        responsibilityKind: kind,
        mainBowlerId,
        substituteBowlerId: null,
        payerBowlerId,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        policy,
        amountMinor: kind === "main" ? league.weeklyFee : 0,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        currency: "USD",
        dueAt: occurrence.startAt,
        pastDueAt,
        assignmentNote: "roster_default",
        recordedByUserId: input.actorUserId,
      }).returning();
      if (responsibility && payerBowlerId !== null && league.weeklyFee > 0) {
        await tx.insert(paymentObligations).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: occurrence.id,
          responsibilityId: responsibility.id,
          component: "full",
          payerBowlerId,
          amountMinor: league.weeklyFee,
          currency: "USD",
          dueAt: occurrence.startAt,
          pastDueAt,
          state: "open",
          createdByUserId: input.actorUserId,
        });
      }
    }
  }
  return true;
}
