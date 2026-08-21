import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { makeF3WorkflowFixture } from "../helpers/f3-workflow-fixture";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  bowlerOccurrenceObligationRevisions,
  bowlerOccurrenceObligations,
  paymentOccurrenceAllocationRevisions,
  paymentOccurrenceAllocations,
  payments,
  paymentOperations,
  interactivePaymentOperationSnapshots,
  interactivePaymentOperationAllocations,
  users,
} from "@shared/schema";
import { CanonicalPaymentReportIncompatibilityError, readCanonicalPaymentReport, readPaymentReceiptProjection } from "../../server/services/canonical-payment-report";
import { encryptInteractivePaymentSnapshot } from "../../server/services/interactive-payment-operation-snapshot";
import { deriveSquareOperationIdempotencyKey } from "../../server/services/payment-operation-idempotency";

const db = getTestDb();
const organizations: number[] = [];

afterEach(async () => {
  for (const organizationId of organizations.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("F5 canonical payment reporting PostgreSQL evidence", () => {
  it("keeps active canonical evidence separate from unlinked legacy history", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const [payment] = await db.insert(payments).values([{
      bowlerId: fixture.roster[0].id,
      leagueId: fixture.leagueId,
      amount: 750,
      weekOf: "2038-02-01T19:00:00.000Z",
      status: "paid",
      type: "cash",
    }]).returning();

    const report = await readCanonicalPaymentReport({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      page: 1,
      limit: 1,
    });
    expect(report.mode).toBe("canonical_with_unlinked_history");
    expect(report.paymentTiming).toMatchObject({ paymentMode: "weekly", source: "canonical_activation", upfrontDueAt: null });
    expect(report.rows).toEqual([]);
    expect(report.unlinkedHistory).toHaveLength(1);
    expect(report.unlinkedHistory[0]).toMatchObject({ paymentId: payment.id, amountMinor: 750, businessDate: payment.weekOf });
    expect(report.totals).toMatchObject({ grossConfirmedPaidMinor: 0, activeAllocatedMinor: 0, unallocatedLegacyMinor: 750 });
    expect(report.fingerprint).toMatch(/^lvpaymentreport:v1:[0-9a-f]{64}$/);
  });

  it("keeps database parent pagination intact across page 2 and page 3", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    await db.insert(payments).values([1, 2, 3].map((amount) => ({
      bowlerId: fixture.roster[0].id,
      leagueId: fixture.leagueId,
      amount: amount * 100,
      weekOf: `2038-02-0${amount}T19:00:00.000Z`,
      status: "paid" as const,
      type: "cash" as const,
    })));
    const pageOne = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, page: 1, limit: 1 });
    const pageTwo = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, page: 2, limit: 1 });
    const pageThree = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, page: 3, limit: 1 });
    expect(pageOne.unlinkedHistory).toHaveLength(1);
    expect(pageTwo.unlinkedHistory).toHaveLength(1);
    expect(pageThree.unlinkedHistory).toHaveLength(1);
    expect(new Set([pageOne.unlinkedHistory[0]?.paymentId, pageTwo.unlinkedHistory[0]?.paymentId, pageThree.unlinkedHistory[0]?.paymentId]).size).toBe(3);
  });

  it("fails closed on conservation corruption outside the selected parent page", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const [firstPayment] = await db.insert(payments).values({
      bowlerId: fixture.roster[0].id,
      leagueId: fixture.leagueId,
      amount: 100,
      weekOf: "2038-02-01T19:00:00.000Z",
      status: "paid",
      type: "cash",
    }).returning();
    const [corruptOperation] = await db.insert(paymentOperations).values({
      organizationId: fixture.organizationId,
      leagueId: null,
      operationType: "interactive_charge",
      targetKey: `f5-off-page-corrupt:${fixture.organizationId}`,
      amountMinor: 900,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"2".repeat(64)}`,
      providerIdempotencyKey: `f5-off-page-corrupt-${fixture.organizationId}`,
      providerName: "square",
      providerObjectId: "off-page-operation-provider",
      status: "succeeded",
      attemptCount: 1,
      nextAttemptAt: null,
      startedAt: "2038-02-02T19:00:00.000Z",
      completedAt: "2038-02-02T19:00:00.000Z",
    }).returning();
    const snapshotSemantic = {
      snapshotVersion: 2 as const,
      organizationId: fixture.organizationId,
      amountMinor: 900,
      currency: "USD",
      providerName: "square" as const,
      leagueId: fixture.leagueId,
      locationId: null,
      providerLocationId: null,
      payerBowlerId: fixture.roster[0].id,
      requestKind: "direct" as const,
      squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(`f5-off-page-corrupt-${fixture.organizationId}`, "payment"),
      squareOrderIdempotencyKey: null,
      sourceId: "legacy-source",
      customerId: null,
      buyerEmail: null,
      storeCard: false,
      sourceKind: "new_card" as const,
      weekOf: "2038-02-02T19:00:00.000Z",
      combinedChargeGroupId: null,
      allocations: [{ allocationIndex: 0, bowlerId: fixture.roster[0].id, amountMinor: 900, lineageAmountMinor: null, prizeFundAmountMinor: null, weekOf: "2038-02-02T19:00:00.000Z", notes: null, paidByUserId: null }],
      lineItems: [],
    };
    const storedSnapshot = encryptInteractivePaymentSnapshot(snapshotSemantic);
    await db.insert(interactivePaymentOperationSnapshots).values({ operationId: corruptOperation.id, ...storedSnapshot });
    await db.insert(interactivePaymentOperationAllocations).values(snapshotSemantic.allocations.map((row) => ({ operationId: corruptOperation.id, ...row })));
    await db.insert(payments).values({
      bowlerId: fixture.roster[1].id,
      leagueId: fixture.leagueId,
      paymentOperationId: corruptOperation.id,
      amount: 100,
      weekOf: "2038-02-02T19:00:00.000Z",
      status: "paid",
      type: "credit_card",
      providerPaymentId: "off-page-provider",
      paymentOperationAllocationIndex: 0,
    });
    await expect(readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, page: 1, limit: 1 }))
      .rejects.toBeInstanceOf(CanonicalPaymentReportIncompatibilityError);
    expect(firstPayment).toBeDefined();
  });

  it("projects zero-row legacy interactive evidence for every snapshot participant", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const weekOf = "2038-02-03T19:00:00.000Z";
    const amountMinor = 500;
    const [operation] = await db.insert(paymentOperations).values({
      organizationId: fixture.organizationId,
      operationType: "interactive_charge",
      targetKey: `interactive:legacy-report:${fixture.organizationId}`,
      amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"1".repeat(64)}`,
      providerIdempotencyKey: `f5-legacy-${fixture.organizationId}`,
      providerName: "square",
      status: "provider_unknown",
      attemptCount: 1,
      nextAttemptAt: "2038-02-03T19:00:00.000Z",
      startedAt: "2038-02-03T19:00:00.000Z",
      errorClassification: "provider_unknown",
      errorCode: "PROVIDER_UNKNOWN",
    }).returning();
    const semantic = {
      snapshotVersion: 2 as const,
      organizationId: fixture.organizationId,
      amountMinor,
      currency: "USD",
      providerName: "square",
      leagueId: fixture.leagueId,
      locationId: null,
      providerLocationId: null,
      payerBowlerId: fixture.roster[0].id,
      requestKind: "direct" as const,
      squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(`f5-legacy-${fixture.organizationId}`, "payment"),
      squareOrderIdempotencyKey: null,
      sourceId: "legacy-source",
      customerId: null,
      buyerEmail: null,
      storeCard: false,
      sourceKind: "new_card" as const,
      weekOf,
      combinedChargeGroupId: null,
      allocations: [
        { allocationIndex: 0, bowlerId: fixture.roster[0].id, amountMinor: 250, lineageAmountMinor: null, prizeFundAmountMinor: null, weekOf, notes: null, paidByUserId: null },
        { allocationIndex: 1, bowlerId: fixture.roster[1].id, amountMinor: 250, lineageAmountMinor: null, prizeFundAmountMinor: null, weekOf, notes: null, paidByUserId: null },
      ],
      lineItems: [],
    };
    const stored = encryptInteractivePaymentSnapshot(semantic);
    await db.insert(interactivePaymentOperationSnapshots).values({ operationId: operation.id, ...stored });
    await db.insert(interactivePaymentOperationAllocations).values(semantic.allocations.map((row) => ({ operationId: operation.id, ...row })));
    const report = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 });
    expect(report.mode).toBe("canonical_with_unlinked_history");
    expect(report.unlinkedHistory.filter((row) => row.paymentOperationId === operation.id)).toHaveLength(2);
    expect(report.unlinkedHistory.filter((row) => row.paymentOperationId === operation.id).map((row) => row.amountMinor)).toEqual([250, 250]);
    expect(report.totalRows).toBe(2);
    expect(report.totalTransactions).toBe(1);
    expect(report.totals.unresolvedOperationMinor).toBe(amountMinor);
    expect(report.unlinkedHistory.filter((row) => row.paymentOperationId === operation.id).every((row) => row.receipt.source === "unlinked_legacy")).toBe(true);
    for (const participant of fixture.roster.slice(0, 2)) {
      const participantReport = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, bowlerId: participant.id, limit: 10 });
      expect(participantReport.totalRows).toBe(1);
      expect(participantReport.totalTransactions).toBe(1);
      // Bowler-scoped totals expose only this participant's immutable
      // snapshot allocation; the org-wide report above remains 500.
      expect(participantReport.totals.unresolvedOperationMinor).toBe(amountMinor / 2);
      expect(participantReport.unlinkedHistory).toHaveLength(1);
    }
  });

  it("fails closed on a cross-tenant league scope", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    await expect(readCanonicalPaymentReport({
      organizationId: fixture.organizationId + 1000000,
      leagueId: fixture.leagueId,
    })).rejects.toBeInstanceOf(CanonicalPaymentReportIncompatibilityError);
  });

  it("fails closed instead of dropping a league payment whose bowler is cross-tenant", async () => {
    const fixture = await makeF3WorkflowFixture();
    const other = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId, other.organizationId);
    await db.insert(payments).values({
      bowlerId: other.roster[0].id,
      leagueId: fixture.leagueId,
      amount: 500,
      weekOf: "2038-02-01T19:00:00.000Z",
      status: "paid",
      type: "cash",
    });
    await expect(readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId }))
      .rejects.toBeInstanceOf(CanonicalPaymentReportIncompatibilityError);
  });

  it("keeps the semantic fingerprint stable when only generated asOf changes", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const first = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 });
    expect(second.asOf).toBeDefined();
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("reports exact canonical allocation conservation and revision evidence", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const [obligation] = await db.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId),
    )).limit(1);
    if (!obligation) throw new Error("F1 fixture obligation missing");
    const [payment] = await db.insert(payments).values([{
      bowlerId: obligation.bowlerId,
      leagueId: fixture.leagueId,
      amount: obligation.amountMinor,
      weekOf: obligation.dueAt ?? "2038-02-01T19:00:00.000Z",
      status: "paid",
      type: "cash",
    }]).returning();
    const [allocation] = await db.insert(paymentOccurrenceAllocations).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      paymentId: payment.id,
      obligationId: obligation.id,
      occurrenceId: obligation.occurrenceId,
      bowlerId: obligation.bowlerId,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      allocationKey: `f5-report-${fixture.organizationId}`,
      recordedByUserId: fixture.actorUserId,
    }).returning();
    await db.insert(paymentOccurrenceAllocationRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      allocationId: allocation.id,
      revisionNumber: allocation.currentRevision,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: allocation.state, amountMinor: allocation.amountMinor, currency: allocation.currency, paymentId: allocation.paymentId, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId },
      recordedByUserId: fixture.actorUserId,
    });
    const nextRevision = obligation.currentRevision + 1;
    await db.update(bowlerOccurrenceObligations).set({ state: "settled", currentRevision: nextRevision }).where(eq(bowlerOccurrenceObligations.id, obligation.id));
    await db.insert(bowlerOccurrenceObligationRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      obligationId: obligation.id,
      revisionNumber: nextRevision,
      snapshotSchemaVersion: 1,
      beforeSnapshot: { state: obligation.state, amountMinor: obligation.amountMinor, currency: obligation.currency, billingTermId: obligation.billingTermId, billingTermVersion: obligation.billingTermVersion, dueAt: obligation.dueAt, pastDueAt: obligation.pastDueAt },
      afterSnapshot: { state: "settled", amountMinor: obligation.amountMinor, currency: obligation.currency, billingTermId: obligation.billingTermId, billingTermVersion: obligation.billingTermVersion, dueAt: obligation.dueAt, pastDueAt: obligation.pastDueAt },
      recordedByUserId: fixture.actorUserId,
    });

    const report = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 });
    expect(report.mode).toBe("canonical");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ paymentId: payment.id, allocatedMinor: obligation.amountMinor, status: "confirmed_paid" });
    expect(report.totals.activeAllocatedMinor).toBe(obligation.amountMinor);
    expect(report.rows[0]?.allocations).toEqual([expect.objectContaining({ allocationId: allocation.id, obligationId: obligation.id, amountMinor: obligation.amountMinor })]);
  });

  it("scopes shared no-operation refund totals to an explicit paidBy payer", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const occurrenceId = fixture.occurrenceIds[0];
    if (!occurrenceId) throw new Error("shared refund fixture occurrence missing");
    const obligations = await db.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId),
      eq(bowlerOccurrenceObligations.occurrenceId, occurrenceId),
    )).limit(2);
    if (obligations.length !== 2) throw new Error("shared refund fixture obligations missing");
    const firstObligation = obligations[0];
    const secondObligation = obligations[1];
    if (!firstObligation || !secondObligation) throw new Error("shared refund fixture obligations missing");
    const [payer] = await db.insert(users).values({ email: `f5-payer-${fixture.organizationId}@example.test`, password: "test", name: "F5 payer", role: "user", organizationId: fixture.organizationId, bowlerId: firstObligation.bowlerId }).returning({ id: users.id });
    if (!payer) throw new Error("shared refund fixture payer missing");
    const insertedPayments = await db.insert(payments).values(obligations.map((obligation) => ({ bowlerId: obligation.bowlerId, leagueId: fixture.leagueId, amount: obligation.amountMinor, weekOf: "2038-02-01T19:00:00.000Z", status: "refunded" as const, type: "square" as const, paidByUserId: payer.id, refundedAt: "2038-02-02T19:00:00.000Z" }))).returning();
    if (insertedPayments.length !== obligations.length) throw new Error("shared refund fixture payments missing");
    for (const [index, obligation] of obligations.entries()) {
      const payment = insertedPayments[index];
      if (!payment) throw new Error("shared refund fixture payment missing");
      const [allocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: payment.id, obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId, amountMinor: obligation.amountMinor, currency: obligation.currency, allocationKey: `f5-shared-refund-${fixture.organizationId}-${obligation.id}`, recordedByUserId: fixture.actorUserId }).returning();
      if (!allocation) throw new Error("shared refund fixture allocation missing");
      await db.insert(paymentOccurrenceAllocationRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, allocationId: allocation.id, revisionNumber: allocation.currentRevision, snapshotSchemaVersion: 1, afterSnapshot: { state: allocation.state, amountMinor: allocation.amountMinor, currency: allocation.currency, paymentId: allocation.paymentId, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId }, recordedByUserId: fixture.actorUserId });
      const revisionNumber = obligation.currentRevision + 1;
      const [settled] = await db.update(bowlerOccurrenceObligations).set({ state: "settled", currentRevision: revisionNumber }).where(eq(bowlerOccurrenceObligations.id, obligation.id)).returning();
      if (!settled) throw new Error("shared refund fixture obligation update missing");
      await db.insert(bowlerOccurrenceObligationRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, obligationId: obligation.id, revisionNumber, snapshotSchemaVersion: 1, beforeSnapshot: obligation, afterSnapshot: settled, recordedByUserId: fixture.actorUserId });
    }
    const payerReport = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, bowlerId: firstObligation.bowlerId, limit: 10 });
    const partnerReport = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, bowlerId: secondObligation.bowlerId, limit: 10 });
    expect(payerReport.totals.refundedMinor).toBe(insertedPayments.reduce((sum, payment) => sum + payment.amount, 0));
    expect(partnerReport.totals.refundedMinor).toBe(0);
  });

  it("fails closed when the current allocation revision snapshot is tampered", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const [obligation] = await db.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId),
    )).limit(1);
    if (!obligation) throw new Error("F1 fixture obligation missing");
    const [payment] = await db.insert(payments).values({ bowlerId: obligation.bowlerId, leagueId: fixture.leagueId, amount: obligation.amountMinor, weekOf: obligation.dueAt ?? "2038-02-01T19:00:00.000Z", status: "paid", type: "cash" }).returning();
    const [allocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: payment.id, obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId, amountMinor: obligation.amountMinor, currency: obligation.currency, allocationKey: `f5-tamper-${fixture.organizationId}`, recordedByUserId: fixture.actorUserId }).returning();
    await db.insert(paymentOccurrenceAllocationRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, allocationId: allocation.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { state: "active", amountMinor: allocation.amountMinor + 1 }, recordedByUserId: fixture.actorUserId });
    await expect(readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 })).rejects.toBeInstanceOf(CanonicalPaymentReportIncompatibilityError);
  });

  it("selects an exact receipt parent without pagination and preserves tenant-wide validation", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const paymentsInserted = await db.insert(payments).values([1, 2, 3].map((amount) => ({ bowlerId: fixture.roster[0].id, leagueId: fixture.leagueId, amount: amount * 100, weekOf: `2038-03-0${amount}T19:00:00.000Z`, status: "paid" as const, type: "cash" as const }))).returning({ id: payments.id });
    const exactPaymentId = paymentsInserted[1]?.id;
    if (!exactPaymentId) throw new Error("exact payment fixture missing");
    const report = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: exactPaymentId, page: 1, limit: 1 });
    expect(report.unlinkedHistory.map((row) => row.paymentId)).toEqual([exactPaymentId]);
    expect(report.totalTransactions).toBe(3);
  });

  it("returns the complete exact-payment receipt projection from one validated read-only snapshot", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    const [payment] = await db.insert(payments).values({
      bowlerId: fixture.roster[0].id,
      leagueId: fixture.leagueId,
      amount: 500,
      weekOf: "2038-04-01T19:00:00.000Z",
      status: "paid",
      type: "cash",
    }).returning();
    const projection = await readPaymentReceiptProjection({ organizationId: fixture.organizationId, paymentId: payment.id });
    expect(projection.payment.id).toBe(payment.id);
    expect(projection.row.paymentId).toBe(payment.id);
    expect([...projection.report.rows, ...projection.report.unlinkedHistory].some((row) => row.paymentId === payment.id)).toBe(true);
    expect(projection.report.fingerprint).toMatch(/^lvpaymentreport:v1:/);
  });
});
