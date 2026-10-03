import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrences,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentOperations,
  paymentObligationOwnerRevisions,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentObligations,
  paymentVoids,
  payments,
  rotatingCreditFundings,
  teams,
  teamPaymentSlots,
  users,
  weeklyPaymentAllocationReleases,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
} from "@shared/schema";
import type { ManagePaymentsChangedRow, ManagePaymentsSnapshot } from "@shared/manage-payments-contract";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import { createLeagueWithCanonicalSetup } from "../../server/services/league-setup-integration.js";
import { prepareAccountPaymentOperation } from "../../server/services/account-payment-operation-preparation.js";
import { recoverRosterPaymentOperation } from "../../server/services/roster-payment-recovery.js";
import {
  canonicalHistoricalCashAllocationRepairFingerprint,
  canonicalResponsibilityFingerprint,
  canonicalRotatingAssignmentFingerprint,
  canonicalCashPaymentDeleteFingerprint,
  canonicalCashPaymentEditFingerprint,
  deleteCanonicalCashPayment,
  editCanonicalCashPayment,
  quoteCanonicalManualPayment,
  recordCanonicalManualPayment,
  recordOccurrenceResponsibilities,
  repairHistoricalCashPaymentAllocation,
  saveRotatingOccurrenceAssignments,
} from "../../server/services/roster-payment-core.js";
import { canonicalManualReceiptQuoteFingerprint } from "../../server/services/manual-payment-receipts.js";
import { historicalCashAllocationFingerprint } from "@shared/historical-payment-repair";
import { calculateRosterPaymentTiming } from "@shared/roster-payment-contract";
import { readOwnedAccountBalancesInTransaction } from "../../server/services/owned-payment-ledger.js";
import { readManagePaymentsWorksheetSnapshot } from "../../server/services/manage-payments-worksheet-read.js";
import { saveManagePaymentsWorksheet, ManagePaymentsWorksheetWriteError } from "../../server/services/manage-payments-worksheet-write.js";
import { getTestDb } from "../setup/test-db.js";

const db = getTestDb();
let suffix = "";
let organizationId = 0;
let leagueId = 0;
let locationId = 0;
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

beforeEach(async () => {
  suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${randomUUID()}`;
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
  locationId = location.id;
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
  it("blocks adopted legacy weekly responsibility, rotating assignment, and allocation repair writers", async () => {
    const occurrence = (await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, selectedOccurrenceId)).limit(1))[0];
    if (!occurrence) throw new Error("selected weekly occurrence fixture was not found");
    const timing = calculateRosterPaymentTiming(occurrence.startAt);
    const responsibility = {
      occurrenceId: selectedOccurrenceId,
      teamId,
      slotIndex: 0,
      positionIndex: 0,
      kind: "main" as const,
      mainBowlerId,
      substituteBowlerId: null,
      payerBowlerId: mainBowlerId,
      policy: "main_pays_full" as const,
      amountMinor: 2_500,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      ...timing,
    };
    const rotatingAssignment = {
      occurrenceId: selectedOccurrenceId,
      teamId,
      slotIndex: 1,
      expectedRevision: null,
      actualBowlerId: substituteBowlerId,
    };
    const repairTargetAllocations = [{ obligationId: mainLegacyObligationId, amountMinor: 2_500 }];
    const repairRequestWithoutFingerprint = {
      paymentId: 1,
      expectedOldAllocationFingerprint: `lvrepaircashalloc:v1:${"c".repeat(64)}`,
      expectedTargetAllocationFingerprint: historicalCashAllocationFingerprint(repairTargetAllocations.map((row) => ({
        ...row,
        state: "active" as const,
        allocationKind: "ordinary" as const,
      }))),
      targetAllocations: repairTargetAllocations,
      reason: "test adopted correction guard",
      idempotencyKey: `legacy-repair-guard-${randomUUID()}`,
    };
    const repairRequest = {
      ...repairRequestWithoutFingerprint,
      requestFingerprint: canonicalHistoricalCashAllocationRepairFingerprint({
        organizationId,
        leagueId,
        request: repairRequestWithoutFingerprint,
      }),
    };

    await expect(recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: `legacy-responsibility-guard-${randomUUID()}`,
      responsibilities: [responsibility],
      requestFingerprint: canonicalResponsibilityFingerprint([responsibility]),
    })).rejects.toMatchObject({ code: "MANAGE_PAYMENTS_REQUIRED" });

    const rotatingRequest = {
      commandKey: `legacy-rotation-guard-${randomUUID()}`,
      assignments: [rotatingAssignment],
      requestFingerprint: "",
    };
    rotatingRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(rotatingRequest);
    await expect(saveRotatingOccurrenceAssignments({
      organizationId,
      leagueId,
      actorUserId,
      request: rotatingRequest,
    })).rejects.toMatchObject({ code: "MANAGE_PAYMENTS_REQUIRED" });

    await expect(repairHistoricalCashPaymentAllocation({
      organizationId,
      leagueId,
      actorUserId,
      allowlist: { paymentAmountsMinor: { "1": 2_500 } },
      request: repairRequest,
    })).rejects.toMatchObject({ code: "MANAGE_PAYMENTS_REQUIRED" });
  });

  it("records an exact no-debt cash advance, leaves it as owned credit, and replays without duplicating income", async () => {
    const amountMinor = 1_234;
    const quote = await quoteCanonicalManualPayment({
      organizationId,
      leagueId,
      request: { payerBowlerId: thirdBowlerId, amountMinor, type: "cash", notes: null },
    });
    expect(quote).toMatchObject({ amountMinor, payerBowlerId: thirdBowlerId, type: "cash" });
    const request = {
      payerBowlerId: thirdBowlerId,
      amountMinor,
      type: "cash" as const,
      notes: null,
      idempotencyKey: `manual-advance-${suffix}`,
      requestFingerprint: canonicalManualReceiptQuoteFingerprint({
        organizationId,
        leagueId,
        payerBowlerId: thirdBowlerId,
        amountMinor,
        type: "cash",
        checkNumber: null,
        notes: null,
      }),
    };
    const result = await recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request });
    if (result.contractVersion !== "canonical-manual-record/2") throw new Error("manual advance used the legacy payment path");
    expect(result).toMatchObject({
      contractVersion: "canonical-manual-record/2",
      amountMinor,
      payerBowlerId: thirdBowlerId,
      appliedAmountMinor: 0,
      account: { availableCreditMinor: amountMinor, confirmedOwedMinor: 0, netBalanceMinor: amountMinor },
      receipt: { revision: 1, occurrenceId: selectedOccurrenceId },
    });
    expect(result.payment).toMatchObject({ bowlerId: thirdBowlerId, amount: amountMinor, type: "cash", status: "paid" });
    expect(result.allocations).toEqual([]);
    expect(await db.select().from(weeklyPaymentWeekConfirmations).where(and(
      eq(weeklyPaymentWeekConfirmations.organizationId, organizationId),
      eq(weeklyPaymentWeekConfirmations.leagueId, leagueId),
    ))).toHaveLength(0);

    await expect(recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
    const storedPayments = await db.select().from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.idempotencyKey, request.idempotencyKey),
    ));
    expect(storedPayments).toHaveLength(1);
    await db.transaction(async (tx) => {
      const balance = (await readOwnedAccountBalancesInTransaction(tx, {
        organizationId,
        leagueId,
        bowlerIds: [thirdBowlerId],
      })).get(thirdBowlerId);
      expect(balance?.availableCreditMinor).toBe(amountMinor);
    });
  });

  it("rejects adopted manual tenders for cross-organization and other-league payers at write time", async () => {
    const siblingLeague = await createLeagueWithCanonicalSetup({
      scope: { organizationId, actorUserId },
      league: {
        name: `Worksheet sibling league ${suffix}`,
        description: "Manual payer membership isolation fixture",
        organizationId,
        locationId,
        active: true,
        seasonStart: "2033-09-05",
        seasonEnd: "2033-09-26",
        weekDay: "Monday",
        totalBowlingWeeks: 4,
        skipDates: [],
        cancelledDates: [],
        doublePayDates: [],
        competitionStartTime: "19:00",
        timezone: "America/New_York",
        weeklyFee: 2_500,
        paymentMode: "weekly",
        payingLineupSize: 3,
        seasonNumber: 1,
      },
      setup: { contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION, idempotencyKey: `sibling-setup-${suffix}` },
    });
    const [siblingTeam] = await db.insert(teams).values({ name: `Worksheet sibling team ${suffix}`, number: 1, leagueId: siblingLeague.id }).returning({ id: teams.id });
    const [siblingMember] = await db.insert(bowlers).values({ name: "Sibling League Bowler", organizationId }).returning({ id: bowlers.id });
    if (!siblingTeam || !siblingMember) throw new Error("sibling league payer fixture was not created");
    await db.insert(bowlerLeagues).values({ bowlerId: siblingMember.id, leagueId: siblingLeague.id, teamId: siblingTeam.id, active: true, order: 0 });

    const [foreignOrganization] = await db.insert(organizations).values({ name: `Foreign ${suffix}`, slug: `foreign-${suffix}` }).returning({ id: organizations.id });
    if (!foreignOrganization) throw new Error("foreign organization fixture was not created");
    const [foreignBowler] = await db.insert(bowlers).values({ name: "Foreign Bowler", organizationId: foreignOrganization.id }).returning({ id: bowlers.id });
    if (!foreignBowler) throw new Error("foreign bowler fixture was not created");

    for (const [index, payerBowlerId] of [siblingMember.id, foreignBowler.id].entries()) {
      const amountMinor = 1_000 + index;
      const request = {
        payerBowlerId,
        amountMinor,
        type: "cash" as const,
        notes: null,
        idempotencyKey: `manual-invalid-scope-${index}-${suffix}`,
        requestFingerprint: canonicalManualReceiptQuoteFingerprint({
          organizationId,
          leagueId,
          payerBowlerId,
          amountMinor,
          type: "cash",
          checkNumber: null,
          notes: null,
        }),
      };
      await expect(recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request }))
        .rejects.toMatchObject({ code: "PAYER_SCOPE_MISMATCH" });
    }
    expect(await db.select().from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
    ))).toHaveLength(0);
    expect(await db.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, leagueId),
    ))).toHaveLength(0);
  });

  it("replaces adopted cash totals and moves collection periods through append-only receipt heads", async () => {
    const amountMinor = 2_500;
    const quote = await quoteCanonicalManualPayment({
      organizationId,
      leagueId,
      request: { payerBowlerId: thirdBowlerId, amountMinor, type: "cash", notes: "receipt memo" },
    });
    const initial = await recordCanonicalManualPayment({
      organizationId,
      leagueId,
      actorUserId,
      request: {
        payerBowlerId: thirdBowlerId,
        amountMinor,
        type: "cash",
        notes: "receipt memo",
        idempotencyKey: `manual-replace-${suffix}`,
        requestFingerprint: quote.fingerprint,
      },
    });
    if (initial.contractVersion !== "canonical-manual-record/2") throw new Error("manual payment used the legacy record path");
    const originalReceiptId = initial.receipt.receiptId;
    const businessDate = initial.receipt.businessCollectionLocalDate;
    const reason = "Correct the recorded cash total";
    const editRequest = {
      paymentId: initial.payment.id,
      correctionMode: "edit_cash" as const,
      amountMinor: 4_000,
      paymentDate: businessDate,
      reason,
      idempotencyKey: `manual-edit-${suffix}`,
      requestFingerprint: "",
    };
    editRequest.requestFingerprint = canonicalCashPaymentEditFingerprint(editRequest);
    const edited = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: editRequest });
    if (edited.contractVersion !== "canonical-cash-payment-edit/2") throw new Error("manual payment used the legacy edit path");
    expect(edited).toMatchObject({
      contractVersion: "canonical-cash-payment-edit/2",
      originalPaymentId: initial.payment.id,
      oldAmountMinor: amountMinor,
      newAmountMinor: 4_000,
      oldPaymentDate: businessDate,
      newPaymentDate: businessDate,
      originalReceiptId,
      replacementReceiptId: originalReceiptId,
      receiptRevision: 2,
      payment: { bowlerId: thirdBowlerId, amount: 4_000, status: "paid", notes: "receipt memo" },
    });
    const originalRows = await db.select().from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.id, initial.payment.id),
    ));
    expect(originalRows[0]?.status).toBe("voided");
    const [samePeriodHead] = await db.select().from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.id, originalReceiptId));
    expect(samePeriodHead?.occurrenceId).toBe(selectedOccurrenceId);
    const samePeriodRevisions = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, originalReceiptId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
    expect(samePeriodRevisions.map((row) => [row.receiptRevision, row.paymentId, row.amountMinor, row.revisionKind])).toEqual([
      [1, initial.payment.id, amountMinor, "manual_record"],
      [2, edited.replacementPaymentId, 4_000, "manual_edit"],
    ]);

    const [nextOccurrence] = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, organizationId),
      eq(leagueOccurrences.leagueId, leagueId),
    )).orderBy(asc(leagueOccurrences.plannedOrdinal)).offset(1).limit(1);
    if (!nextOccurrence?.authoritativeLocalDate) throw new Error("next canonical collection date is missing");
    const movedRequest = {
      paymentId: edited.replacementPaymentId,
      correctionMode: "edit_cash" as const,
      amountMinor: 4_000,
      paymentDate: nextOccurrence.authoritativeLocalDate,
      reason: "Move cash receipt to the correct collection week",
      idempotencyKey: `manual-date-move-${suffix}`,
      requestFingerprint: "",
    };
    movedRequest.requestFingerprint = canonicalCashPaymentEditFingerprint(movedRequest);
    const moved = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: movedRequest });
    if (moved.contractVersion !== "canonical-cash-payment-edit/2") throw new Error("manual payment date move used the legacy edit path");
    expect(moved).toMatchObject({
      contractVersion: "canonical-cash-payment-edit/2",
      originalPaymentId: edited.replacementPaymentId,
      oldPaymentDate: businessDate,
      newPaymentDate: nextOccurrence.authoritativeLocalDate,
      originalReceiptId,
      receiptRevision: 1,
    });
    expect(moved.replacementReceiptId).not.toBe(originalReceiptId);
    const [oldReceiptAfterMove] = await db.select().from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.id, originalReceiptId));
    const oldHeadRevisions = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, originalReceiptId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
    expect(oldReceiptAfterMove?.occurrenceId).toBe(selectedOccurrenceId);
    expect(oldHeadRevisions.at(-1)).toMatchObject({ paymentId: null, amountMinor: 0, revisionKind: "manual_clear" });
    const [newReceipt] = await db.select().from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.id, moved.replacementReceiptId));
    expect(newReceipt?.occurrenceId).toBe(nextOccurrence.id);
    const [newHeadRevision] = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, moved.replacementReceiptId),
    ));
    expect(newHeadRevision).toMatchObject({ receiptRevision: 1, paymentId: moved.replacementPaymentId, amountMinor: 4_000, revisionKind: "manual_record" });

    const deleteRequest = {
      paymentId: moved.replacementPaymentId,
      reason: "Entered against the wrong bowler",
      idempotencyKey: `manual-clear-${suffix}`,
      requestFingerprint: "",
    };
    deleteRequest.requestFingerprint = canonicalCashPaymentDeleteFingerprint(deleteRequest);
    const cleared = await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: deleteRequest });
    expect(cleared).toMatchObject({
      contractVersion: "canonical-cash-payment-delete/2",
      deleted: false,
      cleared: true,
      paymentId: moved.replacementPaymentId,
      receiptId: moved.replacementReceiptId,
      receiptRevision: 2,
    });
    const [lastRevision] = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, moved.replacementReceiptId),
    )).orderBy(desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision)).limit(1);
    expect(lastRevision).toMatchObject({ paymentId: null, amountMinor: 0, revisionKind: "manual_clear" });
    const voidEvidence = await db.select().from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, organizationId),
      eq(paymentVoids.leagueId, leagueId),
      eq(paymentVoids.paymentId, moved.replacementPaymentId),
    ));
    expect(voidEvidence).toHaveLength(1);
    await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: deleteRequest })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
  });

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
    const { rotatingTender } = await db.transaction(async (tx) => {
      const [createdTender] = await tx.insert(payments).values({
        organizationId,
        leagueId,
        bowlerId: mainBowlerId,
        amount: 10_000,
        status: "paid",
        type: "cash",
        paidByUserId: actorUserId,
        notes: "rotating lot release fixture",
      }).returning({ id: payments.id });
      if (!createdTender) throw new Error("rotating source tender fixture was not created");
      const [createdFunding] = await tx.insert(rotatingCreditFundings).values({
        organizationId,
        leagueId,
        bowlerId: mainBowlerId,
        paymentId: createdTender.id,
        amountMinor: 10_000,
        currency: "USD",
        fundingKind: "cash",
        idempotencyKey: "rotating-lot-fixture-0001",
        requestFingerprint: `lvrotcrreq:v1:${"c".repeat(64)}`,
        quoteFingerprint: `lvrotcrquote:v1:${"d".repeat(64)}`,
        actorUserId,
      }).returning({ id: rotatingCreditFundings.id });
      if (!createdFunding) throw new Error("rotating funding fixture was not created");
      const [rotationAllocation] = await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: createdTender.id,
        obligationId: mainObligation.id,
        amountMinor: 2_500,
        currency: "USD",
        state: "active",
        allocationKind: "rotating_credit",
        recordedByUserId: actorUserId,
      }).returning({ id: paymentAllocations.id });
      if (!rotationAllocation) throw new Error("rotating allocation fixture was not created");
      await tx.insert(paymentAllocationFundingApplications).values({
        organizationId,
        leagueId,
        allocationId: rotationAllocation.id,
        paymentId: createdTender.id,
        creditedBowlerId: mainBowlerId,
        genericFundingId: null,
        rotatingFundingId: createdFunding.id,
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
      await tx.update(paymentObligations).set({ state: "settled" }).where(eq(paymentObligations.id, mainObligation.id));
      return { rotatingTender: createdTender };
    });
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

    current = (await saveManagePaymentsWorksheet(saveInput(current, [rowChange(current, mainBowlerId, {
      newManualReceiptAmountMinor: 1_000,
    })], "worksheet-main-cash-0010"))).snapshot;

    const mainReceipt = current.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === mainBowlerId)?.manualReceipts[0];
    if (!mainReceipt) throw new Error("main cash receipt is missing");
    const captureAt = new Date();
    const cardOperation = await prepareAccountPaymentOperation({
      requestKey: `worksheet-card-arrival-${randomUUID()}`,
      organizationId,
      leagueId,
      payerBowlerId: thirdBowlerId,
      amountMinor: 5_000,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId: thirdBowlerId, amountMinor: 5_000 }],
      recipientEvidence: [{
        recipientBowlerId: thirdBowlerId,
        role: "self",
        paymentLinkId: null,
        linkFingerprint: null,
        selection: { kind: "explicit_amount", amountMinor: 5_000 },
      }],
      currency: "USD",
      providerName: "square",
      locationId,
      providerLocationId: null,
      authorizingUserId: actorUserId,
      sourceKind: "new_card",
      sourceId: `test-source-${randomUUID()}`,
      customerId: null,
      buyerEmail: "worksheet-card@example.test",
      storeCard: false,
      quoteFingerprint: `lvaccountfundquote:v4:${randomUUID().replaceAll("-", "").repeat(2)}`,
      now: captureAt,
    });
    const providerPaymentId = `worksheet-card-provider-${cardOperation.id}`;
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      providerObjectId: providerPaymentId,
      errorClassification: "provider_unknown",
      errorCode: "CAPTURE_FINALIZATION_PENDING",
      attemptCount: 1,
      nextAttemptAt: null,
      dispatchClaimedAt: captureAt.toISOString(),
      startedAt: captureAt.toISOString(),
      completedAt: captureAt.toISOString(),
      updatedAt: captureAt.toISOString(),
    }).where(eq(paymentOperations.id, cardOperation.id));
    const recoveredCard = await recoverRosterPaymentOperation({
      organizationId,
      leagueId,
      operationId: cardOperation.id,
      actorUserId,
      now: captureAt,
    });
    expect(recoveredCard.status).toBe("succeeded");
    const [cardTender] = await db.select({ id: payments.id }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.paymentOperationId, cardOperation.id),
    )).limit(1);
    if (!cardTender) throw new Error("concurrent card tender fixture was not created");
    await db.transaction(async (tx) => {
      const [cardReceipt] = await tx.insert(weeklyPaymentWorksheetReceipts).values({
        organizationId,
        leagueId,
        occurrenceId: selectedOccurrenceId,
        payerBowlerId: thirdBowlerId,
        receiptKind: "card",
      }).returning({ id: weeklyPaymentWorksheetReceipts.id });
      if (!cardReceipt) throw new Error("concurrent card receipt fixture was not created");
      await tx.insert(weeklyPaymentWorksheetReceiptRevisions).values({
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
    });
    const combinedCorrection = saveInput(current, [
      rowChange(current, mainBowlerId, { manualReceiptEdits: [{ receiptId: mainReceipt.receiptId, expectedRevision: mainReceipt.revision, amountMinor: 0 }] }),
      rowChange(current, thirdBowlerId, { newManualReceiptAmountMinor: 1_000 }),
    ], "worksheet-clear-and-new-0006");
    const finalSave = await saveManagePaymentsWorksheet(combinedCorrection);
    current = finalSave.snapshot;
    const finalRows = current.teams.flatMap((team) => team.rows);
    expect(finalRows.find((row) => row.bowlerId === mainBowlerId)).toMatchObject({ manualReceipts: [], balanceMinor: 10_000 });
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)).toMatchObject({ balanceMinor: 6_000 });
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)?.cardReceipts).toHaveLength(1);
    expect(finalRows.find((row) => row.bowlerId === thirdBowlerId)?.manualReceipts).toHaveLength(1);
    const sourceRevision = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, mainReceipt.receiptId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
    expect(sourceRevision.map((revision) => [revision.revisionKind, revision.amountMinor, revision.paymentId])).toEqual([
      ["manual_record", 1_000, expect.any(Number)],
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
    const { forecast, forecastObligation } = await db.transaction(async (tx) => {
      const [createdForecast] = await tx.insert(occurrencePaymentResponsibilities).values({
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
      if (!createdForecast) throw new Error("unassigned forecast responsibility was not created");
      const [createdObligation] = await tx.insert(paymentObligations).values({
        organizationId,
        leagueId,
        occurrenceId: occurrence.id,
        responsibilityId: createdForecast.id,
        component: "full",
        payerBowlerId: null,
        amountMinor: 2_500,
        currency: "USD",
        dueAt: occurrence.startAt,
        pastDueAt: occurrence.startAt,
        state: "open",
        createdByUserId: actorUserId,
      }).returning({ id: paymentObligations.id });
      if (!createdObligation) throw new Error("unassigned forecast obligation was not created");
      await tx.insert(paymentObligationOwnerRevisions).values({
        organizationId,
        leagueId,
        obligationId: createdObligation.id,
        revisionNumber: 1,
        ownerKind: "team",
        ownerBowlerId: null,
        ownerTeamId: teamId,
        reason: "rotating_materialization",
        recordedByUserId: actorUserId,
      });
      return { forecast: createdForecast, forecastObligation: createdObligation };
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
