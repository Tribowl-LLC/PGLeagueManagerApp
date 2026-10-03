import { describe, expect, it } from "vitest";
import {
  ManagePaymentsReconciliationError,
  reconcileManagePaymentsComponents,
  type ManagePaymentsDesiredComponent,
  type ManagePaymentsExistingEvidence,
} from "../../server/services/manage-payments-worksheet-reconciliation.js";

const desired = (overrides: Partial<ManagePaymentsDesiredComponent> = {}): ManagePaymentsDesiredComponent => ({
  teamId: 31,
  bowlerId: 501,
  responsible: true,
  component: "full",
  amountMinor: 1_000,
  ...overrides,
});

const component = (overrides: Partial<Extract<ManagePaymentsExistingEvidence, { obligationId: string }>> = {}): Extract<ManagePaymentsExistingEvidence, { obligationId: string }> => ({
  responsibilityId: "legacy-responsibility",
  teamId: 31,
  bowlerId: 501,
  component: "full",
  amountMinor: 1_000,
  obligationId: "legacy-obligation",
  ...overrides,
});

describe("Manage Payments responsibility reconciliation", () => {
  it("retains an exact legacy component without creating a worksheet duplicate", () => {
    const plan = reconcileManagePaymentsComponents([component()], [desired()]);

    expect(plan.retainedObligationIds).toEqual(new Set(["legacy-obligation"]));
    expect(plan.retireObligationIds).toEqual(new Set());
    expect(plan.createWorksheetRows).toEqual([]);
  });

  it("retains an unchanged sibling while creating only a moved split component", () => {
    const evidence = [
      component({ component: "lineage", amountMinor: 700, obligationId: "lineage-obligation" }),
      component({ component: "prize", bowlerId: 502, amountMinor: 300, obligationId: "prize-obligation" }),
    ];
    const rows = [
      desired({ component: "lineage", amountMinor: 700 }),
      desired({ bowlerId: 503, component: "prize", amountMinor: 300 }),
    ];

    const plan = reconcileManagePaymentsComponents(evidence, rows);

    expect(plan.retainedObligationIds).toEqual(new Set(["lineage-obligation"]));
    expect(plan.retireObligationIds).toEqual(new Set(["prize-obligation"]));
    expect(plan.createWorksheetRows).toEqual([rows[1]]);
  });

  it("retains both exact components when a same-owner split is shown as full", () => {
    const plan = reconcileManagePaymentsComponents([
      component({ component: "lineage", amountMinor: 700, obligationId: "lineage-obligation" }),
      component({ component: "prize", amountMinor: 300, obligationId: "prize-obligation" }),
    ], [desired()]);

    expect(plan.retainedObligationIds).toEqual(new Set(["lineage-obligation", "prize-obligation"]));
    expect(plan.retireObligationIds).toEqual(new Set());
    expect(plan.createWorksheetRows).toEqual([]);
  });

  it("retains the sole positive side of a same-owner split shown as full", () => {
    const plan = reconcileManagePaymentsComponents([
      component({ component: "prize", amountMinor: 300, obligationId: "prize-obligation", coalescedSplitResponsibility: true }),
    ], [desired({ amountMinor: 300 })]);

    expect(plan.retainedObligationIds).toEqual(new Set(["prize-obligation"]));
    expect(plan.retireObligationIds).toEqual(new Set());
    expect(plan.createWorksheetRows).toEqual([]);
  });

  it("creates a zero-fee worksheet row while retaining an existing worksheet zero choice", () => {
    const existing: ManagePaymentsExistingEvidence = {
      responsibilityId: "zero-worksheet",
      teamId: 31,
      bowlerId: 501,
      component: "lineage",
      amountMinor: 0,
      obligationId: null,
      zeroWorksheet: true,
    };
    const plan = reconcileManagePaymentsComponents([existing], [desired({ component: "lineage", amountMinor: 0 })]);
    expect(plan.retainedZeroResponsibilityIds).toEqual(new Set(["zero-worksheet"]));
    expect(plan.createWorksheetRows).toEqual([]);
  });

  it("fails closed when duplicate exact liabilities would otherwise be silently preferred", () => {
    expect(() => reconcileManagePaymentsComponents([
      component({ obligationId: "duplicate-a" }),
      component({ responsibilityId: "other-responsibility", obligationId: "duplicate-b" }),
    ], [desired()])).toThrow(ManagePaymentsReconciliationError);
  });
});
