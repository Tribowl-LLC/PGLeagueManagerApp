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
} from "@shared/schema";
import { CanonicalPaymentReportIncompatibilityError, readCanonicalPaymentReport } from "../../server/services/canonical-payment-report";

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
    expect(report.rows).toEqual([]);
    expect(report.unlinkedHistory).toHaveLength(1);
    expect(report.unlinkedHistory[0]).toMatchObject({ paymentId: payment.id, amountMinor: 750, businessDate: payment.weekOf });
    expect(report.totals).toMatchObject({ grossConfirmedPaidMinor: 0, activeAllocatedMinor: 0, unallocatedLegacyMinor: 750 });
    expect(report.fingerprint).toMatch(/^lvpaymentreport:v1:[0-9a-f]{64}$/);
  });

  it("fails closed on a cross-tenant league scope", async () => {
    const fixture = await makeF3WorkflowFixture();
    organizations.push(fixture.organizationId);
    await expect(readCanonicalPaymentReport({
      organizationId: fixture.organizationId + 1000000,
      leagueId: fixture.leagueId,
    })).rejects.toBeInstanceOf(CanonicalPaymentReportIncompatibilityError);
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
      afterSnapshot: { state: allocation.state, amountMinor: allocation.amountMinor },
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
      beforeSnapshot: { state: obligation.state },
      afterSnapshot: { state: "settled" },
      recordedByUserId: fixture.actorUserId,
    });

    const report = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, limit: 10 });
    expect(report.mode).toBe("canonical");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ paymentId: payment.id, allocatedMinor: obligation.amountMinor, status: "confirmed_paid" });
    expect(report.totals.activeAllocatedMinor).toBe(obligation.amountMinor);
    expect(report.rows[0]?.allocations).toEqual([expect.objectContaining({ allocationId: allocation.id, obligationId: obligation.id, amountMinor: obligation.amountMinor })]);
  });
});
