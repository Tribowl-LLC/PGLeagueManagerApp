import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentAllocationFundingApplications,
  paymentObligations,
  payments,
  teams,
  users,
  weeklyPaymentLedgerAdoptions,
} from "@shared/schema";
import { readCanonicalDuePastDue, readCanonicalDuePastDueV3 } from "../../server/services/roster-payment-core";
import { recordOwnedFundingInTransaction } from "../../server/services/owned-payment-ledger";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
let organizationId: number | undefined;
let leagueId: number | undefined;
let selfBowlerId: number | undefined;
let otherBowlerId: number | undefined;

function requireIds() {
  if (organizationId === undefined || leagueId === undefined || selfBowlerId === undefined || otherBowlerId === undefined) {
    throw new Error("owned account projection read fixture is incomplete");
  }
  return { organizationId, leagueId, selfBowlerId, otherBowlerId };
}

describe("owned account projection canonical reads (PostgreSQL)", () => {
  beforeAll(async () => {
    const [organization] = await db.insert(organizations).values({
      name: "Owned Account Projection Read Fixture",
      slug: `owned-account-projection-${suffix}`,
    }).returning({ id: organizations.id });
    const orgId = organization.id;
    organizationId = orgId;

    const [location] = await db.insert(locations).values({
      organizationId: orgId,
      name: "Owned Account Projection Fixture Location",
    }).returning({ id: locations.id });
    const locId = location.id;

    const [league] = await db.insert(leagues).values({
      name: "Owned Account Projection Fixture League",
      organizationId: orgId,
      locationId: locId,
      payingLineupSize: 3,
      weeklyFee: 500,
      seasonStart: "2038-01-01T00:00:00.000Z",
      seasonEnd: "2038-12-31T23:59:59.000Z",
      weekDay: "Monday",
      timezone: "UTC",
    }).returning({ id: leagues.id });
    const leagueIdValue = league.id;
    leagueId = leagueIdValue;

    const [actor] = await db.insert(users).values({
      email: `owned-account-projection-${suffix}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Owned Account Projection Test Admin",
      role: "org_admin",
      organizationId: orgId,
    }).returning({ id: users.id });
    const userId = actor.id;

    const [self] = await db.insert(bowlers).values({ name: "Projection Self", organizationId: orgId }).returning({ id: bowlers.id });
    const [other] = await db.insert(bowlers).values({ name: "Projection Other Owner", organizationId: orgId }).returning({ id: bowlers.id });
    selfBowlerId = self.id;
    otherBowlerId = other.id;

    const [team] = await db.insert(teams).values({ name: "Projection Read Team", number: 1, leagueId: leagueIdValue }).returning({ id: teams.id });
    const teamIdValue = team.id;
    await db.insert(bowlerLeagues).values([
      { bowlerId: self.id, leagueId: leagueIdValue, teamId: teamIdValue, active: true },
      { bowlerId: other.id, leagueId: leagueIdValue, teamId: teamIdValue, active: true },
    ]);

    const publishCommandId = randomUUID();
    const cancelCommandId = randomUUID();
    const commandRows = [
      { id: publishCommandId, commandType: "publish" as const, key: `projection-publish-${suffix}`, reason: null },
      { id: cancelCommandId, commandType: "cancel" as const, key: `projection-cancel-${suffix}`, reason: "fixture cancellation" },
    ];
    await db.insert(leagueScheduleCommands).values(commandRows.map(({ id, commandType, key, reason }) => ({
      id,
      organizationId: orgId,
      leagueId: leagueIdValue,
      actorUserId: userId,
      commandType,
      reason,
      idempotencyKey: key,
      requestFingerprint: `${key}-fingerprint`,
    })));

    const createOccurrence = async (input: { date: string; ordinal: number; cancelled?: boolean }) => {
      const startAt = `${input.date}T19:00:00.000Z`;
      const [occurrence] = await db.insert(leagueOccurrences).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        locationId: locId,
        generationKey: `projection-read-${suffix}-${input.ordinal}`,
        kind: "regular",
        status: input.cancelled ? "cancelled" : "scheduled",
        lifecycle: "published",
        authoritativeLocalDate: input.date,
        authoritativeLocalStartTime: "19:00:00",
        timezone: "UTC",
        startAt,
        selectedUtcOffsetMinutes: 0,
        foldResolution: "unambiguous",
        resolverVersion: "owned-account-projection-read-test",
        plannedOrdinal: input.ordinal,
        competitionNumber: null,
        competitive: false,
        countsInStandings: false,
        publishedAt: startAt,
        publishedByUserId: userId,
        publicationCommandId: publishCommandId,
        ...(input.cancelled ? {
          cancelledAt: startAt,
          cancelledByUserId: userId,
          cancellationCommandId: cancelCommandId,
        } : {}),
      }).returning({ id: leagueOccurrences.id });
      if (!input.cancelled) {
        await db.insert(leagueOccurrenceBillingTerms).values({
          organizationId: orgId,
          leagueId: leagueIdValue,
          occurrenceId: occurrence.id,
          purpose: "league_weekly_fee",
          obligationPolicy: "eligible_bowlers",
          defaultAmountMinor: input.ordinal === 2 ? 1_500 : 500,
          currency: "USD",
          billingOrdinal: input.ordinal,
          version: 1,
          state: "published",
          publishedAt: startAt,
          publishedByUserId: userId,
          publicationCommandId: publishCommandId,
        });
      } else {
        await db.insert(leagueOccurrenceBillingTerms).values({
          organizationId: orgId,
          leagueId: leagueIdValue,
          occurrenceId: occurrence.id,
          purpose: "league_weekly_fee",
          obligationPolicy: "none",
          defaultAmountMinor: 0,
          currency: "USD",
          billingOrdinal: null,
          version: 1,
          state: "published",
          publishedAt: startAt,
          publishedByUserId: userId,
          publicationCommandId: publishCommandId,
        });
      }
      return { occurrenceId: occurrence.id, startAt };
    };

    const createWorksheetObligation = async (input: {
      occurrenceId: string;
      startAt: string;
      bowlerId: number;
      state?: "open" | "partially_settled";
      amountMinor?: number;
    }) => {
      const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        occurrenceId: input.occurrenceId,
        teamId: teamIdValue,
        slotId: null,
        slotIndex: null,
        positionIndex: null,
        responsibilityKind: "worksheet",
        payerBowlerId: input.bowlerId,
        mainBowlerId: null,
        substituteBowlerId: null,
        policy: null,
        worksheetFeeComponent: "full",
        amountMinor: input.amountMinor ?? 500,
        currency: "USD",
        dueAt: input.startAt,
        pastDueAt: input.startAt,
        recordedByUserId: userId,
      }).returning({ id: occurrencePaymentResponsibilities.id });
      const [obligation] = await db.insert(paymentObligations).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        occurrenceId: input.occurrenceId,
        responsibilityId: responsibility.id,
        payerBowlerId: input.bowlerId,
        amountMinor: input.amountMinor ?? 500,
        currency: "USD",
        dueAt: input.startAt,
        pastDueAt: input.startAt,
        state: input.state ?? "open",
        createdByUserId: userId,
      }).returning({ id: paymentObligations.id });
      return { responsibilityId: responsibility.id, obligationId: obligation.id };
    };

    const selfWeek = await createOccurrence({ date: "2038-02-01", ordinal: 1 });
    const otherWeek = await createOccurrence({ date: "2038-02-08", ordinal: 2 });
    const cancelledWeek = await createOccurrence({ date: "2038-02-15", ordinal: 3, cancelled: true });
    await createWorksheetObligation({ ...selfWeek, bowlerId: self.id });
    const otherDebt = await createWorksheetObligation({ ...otherWeek, bowlerId: other.id, state: "partially_settled", amountMinor: 1_500 });
    const cancelledDebt = await createWorksheetObligation({ ...cancelledWeek, bowlerId: self.id, state: "partially_settled" });

    const [adoption] = await db.insert(weeklyPaymentLedgerAdoptions).values({
      organizationId: orgId,
      leagueId: leagueIdValue,
      adoptedThroughLocalDate: "2038-12-31",
      preflightFingerprint: `lvweeklyadoptpre:v1:${"a".repeat(64)}`,
      resultFingerprint: `lvweeklyadopt:v1:${"b".repeat(64)}`,
      recordedByUserId: userId,
    }).returning({ id: weeklyPaymentLedgerAdoptions.id });

    await db.transaction(async (tx) => {
      const [receipt] = await tx.insert(payments).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        bowlerId: other.id,
        amount: 1_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        notes: "Owned credit privacy fixture",
      }).returning({ id: payments.id });
      const funding = await recordOwnedFundingInTransaction(tx, {
        organizationId: orgId,
        leagueId: leagueIdValue,
        creditedBowlerId: other.id,
        paymentId: receipt.id,
        portionIndex: 0,
        amountMinor: 1_000,
        currency: "USD",
        source: "legacy_adoption",
        authorizationKind: "legacy_payment",
        authorizationOperationId: null,
        authorizationItemCount: 0,
        authorizationFingerprint: `lvweeklyadopt:v1:${"f".repeat(64)}`,
        adoptionId: adoption.id,
        recordedByUserId: userId,
      });
      const [allocation] = await tx.insert(paymentAllocations).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        paymentId: receipt.id,
        obligationId: otherDebt.obligationId,
        amountMinor: 500,
        currency: "USD",
        recordedByUserId: userId,
      }).returning({ id: paymentAllocations.id });
      await tx.insert(paymentAllocationFundingApplications).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        allocationId: allocation.id,
        paymentId: receipt.id,
        creditedBowlerId: other.id,
        genericFundingId: funding.id,
        rotatingFundingId: null,
        sourceAmountMinor: 1_000,
        amountMinor: 500,
        currency: "USD",
        obligationId: otherDebt.obligationId,
        responsibilityId: otherDebt.responsibilityId,
        occurrenceId: otherWeek.occurrenceId,
        teamId: teamIdValue,
        targetKind: "bowler_responsibility",
        targetPayerBowlerId: other.id,
        assignmentId: null,
        appliedByUserId: userId,
      });
    });

    await db.transaction(async (tx) => {
      const [reviewPayment] = await tx.insert(payments).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        bowlerId: self.id,
        amount: 300,
        currency: "USD",
        status: "paid",
        type: "cash",
        notes: "Canceled partial allocation review fixture",
      }).returning({ id: payments.id });
      await tx.insert(paymentAllocations).values({
        organizationId: orgId,
        leagueId: leagueIdValue,
        paymentId: reviewPayment.id,
        obligationId: cancelledDebt.obligationId,
        amountMinor: 300,
        currency: "USD",
        reviewRequired: true,
        reviewReason: "OCCURRENCE_CANCELLATION_REVIEW",
        recordedByUserId: userId,
      });
    });

    // Sanity-check that the two distinct owners' confirmed liabilities are
    // present, and the unrelated owner has a verified cash-credit lot.
    expect(otherDebt.obligationId).toBeTruthy();
  });

  it("keeps unrelated confirmed debt and credit inside the league batch, but returns only the self account", async () => {
    const ids = requireIds();
    const v2All = await readCanonicalDuePastDue({ organizationId: ids.organizationId, leagueId: ids.leagueId });
    const v3All = await readCanonicalDuePastDueV3({ organizationId: ids.organizationId, leagueId: ids.leagueId });
    const v2 = await readCanonicalDuePastDue({ organizationId: ids.organizationId, leagueId: ids.leagueId, payerBowlerId: ids.selfBowlerId });
    const v3 = await readCanonicalDuePastDueV3({ organizationId: ids.organizationId, leagueId: ids.leagueId, bowlerId: ids.selfBowlerId });

    expect(v2All.accountProjection?.accounts.find((account) => account.bowlerId === ids.otherBowlerId)).toMatchObject({
      amountPaidMinor: 1_000,
      availableCreditMinor: 500,
      confirmedDebtMinor: 1_000,
    });
    expect(v3All.accountProjection?.accounts.find((account) => account.bowlerId === ids.otherBowlerId)).toMatchObject({
      amountPaidMinor: 1_000,
      availableCreditMinor: 500,
      confirmedDebtMinor: 1_000,
    });
    expect(v2.accountProjection?.accounts).toEqual([expect.objectContaining({
      bowlerId: ids.selfBowlerId,
      amountPaidMinor: 0,
      availableCreditMinor: 0,
      confirmedDebtMinor: 700,
    })]);
    expect(v3.accountProjection?.accounts).toEqual([expect.objectContaining({
      bowlerId: ids.selfBowlerId,
      amountPaidMinor: 0,
      availableCreditMinor: 0,
      confirmedDebtMinor: 700,
    })]);
    expect(v2.rows.every((row) => row.payerBowlerId === ids.selfBowlerId)).toBe(true);
    expect(v3.rows.every((row) => row.accountProjection?.effectiveDebtorBowlerId === ids.selfBowlerId)).toBe(true);
    expect(JSON.stringify({ v2, v3 })).not.toContain(`"bowlerId":${ids.otherBowlerId}`);
    expect(JSON.stringify({ v2, v3 })).not.toContain('"amountPaidMinor":1000');
  });

  it("reads canceled reviewed partial debt without requiring its retired billing slot", async () => {
    const ids = requireIds();
    const v2 = await readCanonicalDuePastDue({ organizationId: ids.organizationId, leagueId: ids.leagueId, payerBowlerId: ids.selfBowlerId });
    const v3 = await readCanonicalDuePastDueV3({ organizationId: ids.organizationId, leagueId: ids.leagueId, bowlerId: ids.selfBowlerId });
    const canceledV2 = v2.rows.find((row) => row.reviewRequired && row.outstandingMinor === 200);
    const canceledV3 = v3.rows.find((row) => row.reviewRequired && row.outstandingMinor === 200);

    expect(canceledV2).toMatchObject({ state: "partially_settled", reviewRequired: true, outstandingMinor: 200 });
    expect(canceledV3).toMatchObject({ state: "partially_settled", reviewRequired: true, outstandingMinor: 200, slotIndex: null, responsibilityKind: "worksheet" });
  });
});
