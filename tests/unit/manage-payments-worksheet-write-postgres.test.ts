import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrences,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentObligationOwnerRevisions,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentObligations,
  payments,
  rotatingCreditFundings,
  teams,
  teamPaymentSlots,
  users,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
} from "@shared/schema";
import type { ManagePaymentsChangedRow, ManagePaymentsSnapshot } from "@shared/manage-payments-contract";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import { createLeagueWithCanonicalSetup } from "../../server/services/league-setup-integration.js";
import { readManagePaymentsWorksheetSnapshot } from "../../server/services/manage-payments-worksheet-read.js";
import { saveManagePaymentsWorksheet, ManagePaymentsWorksheetWriteError } from "../../server/services/manage-payments-worksheet-write.js";
import { deleteOrganization } from "../../server/storage/organizations.js";
import { getTestDb } from "../setup/test-db.js";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${randomUUID()}`;
let organizationId = 0;
let leagueId = 0;
let actorUserId = 0;
let teamId = 0;
let mainBowlerId = 0;
let substituteBowlerId = 0;
let thirdBowlerId = 0;
let selectedOccurrenceId = "";
let mainLegacyResponsibilityId = "";
let mainLegacyObligationId = "";
let unassignedSlotId = "";

async function addBowler(name: string, order: number): Promise<number> {
  const [bowler] = await db.insert(bowlers).values({ name, organizationId }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("worksheet bowler fixture was not created");
  await db.insert(bowlerLeagues).values({ bowlerId: bowler.id, leagueId, teamId, active: true, order });
  return bowler.id;
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({ name: `Worksheet ${suffix}`, slug: `worksheet-${suffix}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("worksheet organization fixture was not created");
  organizationId = organization.id;
  const [actor] = await db.insert(users).values({
    email: `worksheet-${suffix}@example.test`,
    password: "worksheet-test-password-hash",
    name: "Worksheet actor",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("worksheet actor fixture was not created");
  actorUserId = actor.id;
  const [location] = await db.insert(locations).values({ name: `Worksheet location ${suffix}`, organizationId }).returning({ id: locations.id });
  if (!location) throw new Error("worksheet location fixture was not created");
  const created = await createLeagueWithCanonicalSetup({
    scope: { organizationId, actorUserId },
    league: {
      name: `Worksheet league ${suffix}`,
      description: "Manage Payments writer integration fixture",
      organizationId,
      locationId: location.id,
      active: true,
      seasonStart: "2032-09-05",
      seasonEnd: "2032-09-26",
      weekDay: "Sunday",
      totalBowlingWeeks: 4,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      weeklyFee: 2_500,
      lineageFee: 1_800,
      prizeFundFee: 700,
      paymentMode: "weekly",
      payingLineupSize: 3,
      seasonNumber: 1,
    },
    setup: { contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION, idempotencyKey: `setup-${suffix}` },
  });
  leagueId = created.id;
  const [team] = await db.insert(teams).values({ name: `Worksheet team ${suffix}`, number: 1, leagueId }).returning({ id: teams.id });
  if (!team) throw new Error("worksheet team fixture was not created");
  teamId = team.id;
  mainBowlerId = await addBowler("Worksheet Main", 0);
  substituteBowlerId = await addBowler("Worksheet Substitute", 1);
  thirdBowlerId = await addBowler("Worksheet Other Substitute", 2);
  const createdSlots = await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
  ]).returning({ id: teamPaymentSlots.id, slotIndex: teamPaymentSlots.slotIndex });
  const mainSlot = createdSlots.find((slot) => slot.slotIndex === 0);
  if (!mainSlot) throw new Error("worksheet main slot fixture was not created");
  const unassignedSlot = createdSlots.find((slot) => slot.slotIndex === 1);
  if (!unassignedSlot) throw new Error("worksheet unassigned slot fixture was not created");
  unassignedSlotId = unassignedSlot.id;
  const [occurrence] = await db.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, organizationId),
    eq(leagueOccurrences.leagueId, leagueId),
  )).orderBy(asc(leagueOccurrences.plannedOrdinal)).limit(1);
  if (!occurrence?.authoritativeLocalDate) throw new Error("worksheet canonical occurrence fixture was not created");
  selectedOccurrenceId = occurrence.id;
  await db.insert(weeklyPaymentLedgerAdoptions).values({
    organizationId,
    leagueId,
    adoptedThroughLocalDate: occurrence.authoritativeLocalDate,
    preflightFingerprint: `lvweeklyadoptpre:v1:${"a".repeat(64)}`,
    resultFingerprint: `lvweeklyadopt:v1:${"b".repeat(64)}`,
    recordedByUserId: actorUserId,
  });
  const startAt = occurrence.startAt;
  const [legacy] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId,
    occurrenceId: selectedOccurrenceId,
    teamId,
    slotId: mainSlot.id,
    slotIndex: 0,
    positionIndex: 0,
    version: 1,
    state: "active",
    responsibilityKind: "main",
    mainBowlerId,
    substituteBowlerId: null,
    payerBowlerId: mainBowlerId,
    lineagePayerBowlerId: null,
    prizePayerBowlerId: null,
    policy: "main_pays_full",
    worksheetFeeComponent: null,
    amountMinor: 2_500,
    lineageAmountMinor: null,
    prizeFundAmountMinor: null,
    currency: "USD",
    dueAt: startAt,
    pastDueAt: startAt,
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  if (!legacy) throw new Error("worksheet legacy responsibility fixture was not created");
  mainLegacyResponsibilityId = legacy.id;
  const [obligation] = await db.insert(paymentObligations).values({
    organizationId,
    leagueId,
    occurrenceId: selectedOccurrenceId,
    responsibilityId: legacy.id,
    component: "full",
    payerBowlerId: mainBowlerId,
    amountMinor: 2_500,
    currency: "USD",
    dueAt: startAt,
    pastDueAt: startAt,
    state: "open",
    createdByUserId: actorUserId,
  }).returning({ id: paymentObligations.id });
  if (!obligation) throw new Error("worksheet legacy obligation fixture was not created");
  mainLegacyObligationId = obligation.id;
});

afterAll(async () => {
  if (!organizationId) return;
  await db.delete(weeklyPaymentAllocationReleases).where(eq(weeklyPaymentAllocationReleases.organizationId, organizationId));
  await db.delete(weeklyPaymentWorksheetReceiptRevisions).where(eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId));
  await db.delete(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.organizationId, organizationId));
  await db.delete(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.organizationId, organizationId));
  await db.delete(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.organizationId, organizationId));
  await db.delete(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.organizationId, organizationId));
  await db.delete(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.organizationId, organizationId));
  await deleteOrganization(organizationId);
});

function saveInput(snapshot: ManagePaymentsSnapshot, changedRows: ManagePaymentsChangedRow[], idempotencyKey: string) {
  return {
    organizationId,
    leagueId,
    actorUserId,
    request: {
      occurrenceId: snapshot.selectedOccurrence.occurrenceId,
      expectedRevision: snapshot.revision,
      expectedStateFingerprint: snapshot.stateFingerprint,
      idempotencyKey,
      changedRows,
    },
  };
}

function rowChange(snapshot: ManagePaymentsSnapshot, bowlerId: number, overrides: Partial<ManagePaymentsChangedRow> = {}): ManagePaymentsChangedRow {
  const team = snapshot.teams.find((candidate) => candidate.rows.some((row) => row.bowlerId === bowlerId));
  const row = team?.rows.find((candidate) => candidate.bowlerId === bowlerId);
  if (!team || !row) throw new Error(`worksheet row ${bowlerId} is missing`);
  return {
    teamId: team.teamId,
    bowlerId,
    responsible: row.responsible,
    feeComponent: row.feeComponent,
    manualReceiptEdits: [],
    ...overrides,
  };
}

describe("Manage Payments worksheet atomic writer", () => {
  it("confirms adopted legacy rows, versions payer responsibility, replaces and clears exact receipts atomically", async () => {
    const initial = await readManagePaymentsWorksheetSnapshot({ organizationId, leagueId, occurrenceId: selectedOccurrenceId });
    expect(initial.weekConfirmed).toBe(true);
    expect(initial.needsConfirmation).toBe(true);
    const before = await db.select().from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, mainLegacyResponsibilityId));
    expect(before[0]?.state).toBe("active");
    expect(await db.select().from(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.occurrenceId, selectedOccurrenceId))).toHaveLength(0);

    const emptyConfirmation = saveInput(initial, [], "worksheet-empty-confirm-0001");
    const firstSave = await saveManagePaymentsWorksheet(emptyConfirmation);
    expect(firstSave.snapshot).toMatchObject({ weekConfirmed: true, needsConfirmation: false, revision: 1 });
    const legacyAfter = await db.select().from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, mainLegacyResponsibilityId));
    expect(legacyAfter[0]?.state).toBe("active");
    const newResponsibilities = await db.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, selectedOccurrenceId),
      eq(occurrencePaymentResponsibilities.state, "active"),
      eq(occurrencePaymentResponsibilities.responsibilityKind, "worksheet"),
    ));
    expect(newResponsibilities).toHaveLength(0);
    const replay = await saveManagePaymentsWorksheet(emptyConfirmation);
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.revision).toBe(1);
    const oldObligation = await db.select().from(paymentObligations).where(eq(paymentObligations.id, mainLegacyObligationId));
    expect(oldObligation[0]?.state).toBe("open");

    let current = firstSave.snapshot;
    const [mainObligation] = await db.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.responsibilityId, mainLegacyResponsibilityId),
    ));
    if (!mainObligation) throw new Error("main worksheet obligation is missing");
    const [rotatingTender] = await db.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId: mainBowlerId,
      amount: 10_000,
      status: "paid",
      type: "cash",
      paidByUserId: actorUserId,
      notes: "rotating lot release fixture",
    }).returning({ id: payments.id });
    if (!rotatingTender) throw new Error("rotating source tender fixture was not created");
    const [rotatingFunding] = await db.insert(rotatingCreditFundings).values({
      organizationId,
      leagueId,
      bowlerId: mainBowlerId,
      paymentId: rotatingTender.id,
      amountMinor: 10_000,
      currency: "USD",
      fundingKind: "cash",
      idempotencyKey: "rotating-lot-fixture-0001",
      requestFingerprint: `lvrotcrreq:v1:${"c".repeat(64)}`,
      quoteFingerprint: `lvrotcrquote:v1:${"d".repeat(64)}`,
      actorUserId,
    }).returning({ id: rotatingCreditFundings.id });
    if (!rotatingFunding) throw new Error("rotating funding fixture was not created");
    const [rotationAllocation] = await db.insert(paymentAllocations).values({
      organizationId,
      leagueId,
      paymentId: rotatingTender.id,
      obligationId: mainObligation.id,
      amountMinor: 2_500,
      currency: "USD",
      state: "active",
      allocationKind: "rotating_credit",
      recordedByUserId: actorUserId,
    }).returning({ id: paymentAllocations.id });
    if (!rotationAllocation) throw new Error("rotating allocation fixture was not created");
    await db.insert(paymentAllocationFundingApplications).values({
      organizationId,
      leagueId,
      allocationId: rotationAllocation.id,
      paymentId: rotatingTender.id,
      creditedBowlerId: mainBowlerId,
      genericFundingId: null,
      rotatingFundingId: rotatingFunding.id,
      sourceAmountMinor: 10_000,
      amountMinor: 2_500,
      currency: "USD",
      obligationId: mainObligation.id,
      responsibilityId: mainObligation.responsibilityId,
      occurrenceId: selectedOccurrenceId,
      teamId,
      targetKind: "bowler_responsibility",
      targetPayerBowlerId: mainBowlerId,
      assignmentId: null,
      appliedByUserId: actorUserId,
    });
    await db.update(paymentObligations).set({ state: "settled" }).where(eq(paymentObligations.id, mainObligation.id));
    current = await readManagePaymentsWorksheetSnapshot({ organizationId, leagueId, occurrenceId: selectedOccurrenceId });
    expect(current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === mainBowlerId)?.balanceMinor).toBe(7_500);

    const switchToSub = saveInput(current, [
      rowChange(current, mainBowlerId, { responsible: false }),
      rowChange(current, substituteBowlerId, { responsible: true }),
    ], "worksheet-switch-payer-0003");
    current = (await saveManagePaymentsWorksheet(switchToSub)).snapshot;
    const switchedRows = current.teams.flatMap((team) => team.rows);
    expect(switchedRows.find((row) => row.bowlerId === mainBowlerId)).toMatchObject({ responsible: false, balanceMinor: 10_000 });
    expect(switchedRows.find((row) => row.bowlerId === substituteBowlerId)).toMatchObject({ responsible: true, feeMinor: 2_500, balanceMinor: -2_500 });
    expect(await db.select().from(weeklyPaymentAllocationReleases).where(and(
      eq(weeklyPaymentAllocationReleases.organizationId, organizationId),
      eq(weeklyPaymentAllocationReleases.leagueId, leagueId),
      eq(weeklyPaymentAllocationReleases.creditedBowlerId, mainBowlerId),
    ))).toHaveLength(1);

    current = (await saveManagePaymentsWorksheet(saveInput(current, [rowChange(current, substituteBowlerId, { newManualReceiptAmountMinor: 2_500 })], "worksheet-sub-cash-0004"))).snapshot;
    const subWithReceipt = current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === substituteBowlerId);
    const originalSubReceipt = subWithReceipt?.manualReceipts[0];
    if (!originalSubReceipt) throw new Error("substitute cash receipt is missing");
    expect(originalSubReceipt).toMatchObject({ amountMinor: 2_500, revision: 1 });
    current = (await saveManagePaymentsWorksheet(saveInput(current, [rowChange(current, substituteBowlerId, {
      manualReceiptEdits: [{ receiptId: originalSubReceipt.receiptId, expectedRevision: originalSubReceipt.revision, amountMinor: 4_000 }],
    })], "worksheet-sub-cash-edit-0005"))).snapshot;
    expect(current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === substituteBowlerId)).toMatchObject({
      balanceMinor: 1_500,
      manualReceipts: [expect.objectContaining({ receiptId: originalSubReceipt?.receiptId, amountMinor: 4_000, revision: 2 })],
    });

    const mainReceipt = current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === mainBowlerId)?.manualReceipts[0];
    if (!mainReceipt) throw new Error("main cash receipt is missing");
    const [cardTender] = await db.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId: thirdBowlerId,
      amount: 5_000,
      status: "paid",
      type: "square",
      notes: "concurrent readonly card fixture",
    }).returning({ id: payments.id });
    if (!cardTender) throw new Error("concurrent card tender fixture was not created");
    await db.insert(rotatingCreditFundings).values({
      organizationId,
      leagueId,
      bowlerId: thirdBowlerId,
      paymentId: cardTender.id,
      amountMinor: 5_000,
      currency: "USD",
      fundingKind: "provider",
      idempotencyKey: "card-arrival-fixture-0001",
      requestFingerprint: `lvrotcrreq:v1:${"e".repeat(64)}`,
      quoteFingerprint: `lvrotcrquote:v1:${"f".repeat(64)}`,
      actorUserId,
    });
    const [cardReceipt] = await db.insert(weeklyPaymentWorksheetReceipts).values({
      organizationId,
      leagueId,
      occurrenceId: selectedOccurrenceId,
      payerBowlerId: thirdBowlerId,
      receiptKind: "card",
    }).returning({ id: weeklyPaymentWorksheetReceipts.id });
    if (!cardReceipt) throw new Error("concurrent card receipt fixture was not created");
    await db.insert(weeklyPaymentWorksheetReceiptRevisions).values({
      organizationId,
      leagueId,
      receiptId: cardReceipt.id,
      receiptRevision: 1,
      paymentId: cardTender.id,
      revisionKind: "card_association",
      amountMinor: 5_000,
      businessCollectionLocalDate: current.selectedOccurrence.localDate,
      recordedByUserId: null,
    });
    const combinedCorrection = saveInput(current, [
      rowChange(current, mainBowlerId, { manualReceiptEdits: [{ receiptId: mainReceipt.receiptId, expectedRevision: mainReceipt.revision, amountMinor: 0 }] }),
      rowChange(current, thirdBowlerId, { newManualReceiptAmountMinor: 1_000 }),
    ], "worksheet-clear-and-new-0006");
    const finalSave = await saveManagePaymentsWorksheet(combinedCorrection);
    current = finalSave.snapshot;
    const finalRows = current.teams.flatMap((team) => team.rows);
    expect(finalRows.find((row) => row.bowlerId === mainBowlerId)).toMatchObject({ manualReceipts: [], balanceMinor: 0 });
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)).toMatchObject({ balanceMinor: 6_000 });
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)?.cardReceipts).toHaveLength(1);
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)?.manualReceipts).toHaveLength(1);
    const sourceRevision = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, mainReceipt.receiptId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
    expect(sourceRevision.map((revision) => [revision.revisionKind, revision.amountMinor, revision.paymentId])).toEqual([
      ["manual_record", 10_000, expect.any(Number)],
      ["manual_clear", 0, null],
    ]);
    current = (await saveManagePaymentsWorksheet(saveInput(current, [rowChange(current, thirdBowlerId, {
      newManualReceiptAmountMinor: 200,
    })], "worksheet-additional-cash-0009"))).snapshot;
    expect(current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === thirdBowlerId)).toMatchObject({
      balanceMinor: 6_200,
      manualReceipts: expect.arrayContaining([
        expect.objectContaining({ amountMinor: 1_000 }),
        expect.objectContaining({ amountMinor: 200 }),
      ]),
    });
    const paymentCountBeforeRetry = await db.select({ id: payments.id }).from(payments).where(eq(payments.organizationId, organizationId));
    const finalReplay = await saveManagePaymentsWorksheet(combinedCorrection);
    const paymentCountAfterRetry = await db.select({ id: payments.id }).from(payments).where(eq(payments.organizationId, organizationId));
    expect(finalReplay.replayed).toBe(true);
    expect(paymentCountAfterRetry).toHaveLength(paymentCountBeforeRetry.length);

    const stale = saveInput(initial, [], "worksheet-stale-conflict-0007");
    await expect(saveManagePaymentsWorksheet(stale)).rejects.toMatchObject({ code: "state_conflict" });
    const foreignReceipt = finalRows.find((row) => row.bowlerId === thirdBowlerId)?.manualReceipts[0];
    if (!foreignReceipt) throw new Error("new cash receipt is missing");
    await expect(saveManagePaymentsWorksheet(saveInput(current, [rowChange(current, mainBowlerId, {
      manualReceiptEdits: [{ receiptId: foreignReceipt.receiptId, expectedRevision: foreignReceipt.revision, amountMinor: 500 }],
    })], "worksheet-foreign-receipt-0008"))).rejects.toBeInstanceOf(ManagePaymentsWorksheetWriteError);
  });

  it("converts a safe unassigned future team forecast to the selected worksheet payer", async () => {
    const [occurrence] = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, organizationId),
      eq(leagueOccurrences.leagueId, leagueId),
    )).orderBy(asc(leagueOccurrences.plannedOrdinal)).offset(1).limit(1);
    if (!occurrence?.authoritativeLocalDate) throw new Error("future canonical occurrence fixture was not created");
    const [forecast] = await db.insert(occurrencePaymentResponsibilities).values({
      organizationId,
      leagueId,
      occurrenceId: occurrence.id,
      teamId,
      slotId: unassignedSlotId,
      slotIndex: 1,
      positionIndex: 1,
      version: 1,
      state: "active",
      responsibilityKind: "rotating",
      mainBowlerId: null,
      substituteBowlerId: null,
      payerBowlerId: null,
      lineagePayerBowlerId: null,
      prizePayerBowlerId: null,
      policy: "main_pays_full",
      worksheetFeeComponent: null,
      amountMinor: 2_500,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      currency: "USD",
      dueAt: occurrence.startAt,
      pastDueAt: occurrence.startAt,
      recordedByUserId: actorUserId,
    }).returning({ id: occurrencePaymentResponsibilities.id });
    if (!forecast) throw new Error("unassigned forecast responsibility was not created");
    const [forecastObligation] = await db.insert(paymentObligations).values({
      organizationId,
      leagueId,
      occurrenceId: occurrence.id,
      responsibilityId: forecast.id,
      component: "full",
      payerBowlerId: null,
      amountMinor: 2_500,
      currency: "USD",
      dueAt: occurrence.startAt,
      pastDueAt: occurrence.startAt,
      state: "open",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
    if (!forecastObligation) throw new Error("unassigned forecast obligation was not created");
    await db.insert(paymentObligationOwnerRevisions).values({
      organizationId,
      leagueId,
      obligationId: forecastObligation.id,
      revisionNumber: 1,
      ownerKind: "team",
      ownerBowlerId: null,
      ownerTeamId: teamId,
      reason: "rotating_materialization",
      recordedByUserId: actorUserId,
    });

    const snapshot = await readManagePaymentsWorksheetSnapshot({ organizationId, leagueId, occurrenceId: occurrence.id });
    expect(snapshot).toMatchObject({ weekConfirmed: false, needsConfirmation: true });
    const saved = await saveManagePaymentsWorksheet(saveInput(snapshot, [
      rowChange(snapshot, mainBowlerId, { responsible: false }),
      rowChange(snapshot, substituteBowlerId, { responsible: true }),
    ], "worksheet-unassigned-forecast-0001"));
    expect(saved.snapshot).toMatchObject({ weekConfirmed: true, needsConfirmation: false, revision: 1 });
    expect(saved.snapshot.teams.flatMap((team) => team.rows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ bowlerId: mainBowlerId, responsible: false }),
      expect.objectContaining({ bowlerId: substituteBowlerId, responsible: true, feeMinor: 2_500, balanceMinor: -2_500 }),
    ]));
    const [retiredForecast] = await db.select().from(paymentObligations).where(eq(paymentObligations.id, forecastObligation.id));
    const [retiredResponsibility] = await db.select().from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, forecast.id));
    expect(retiredForecast?.state).toBe("voided");
    expect(retiredResponsibility?.state).toBe("voided");
    expect(await db.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
      eq(occurrencePaymentResponsibilities.responsibilityKind, "worksheet"),
      eq(occurrencePaymentResponsibilities.payerBowlerId, substituteBowlerId),
    ))).toHaveLength(1);
  });
});
