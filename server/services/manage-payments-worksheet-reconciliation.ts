import type { ManagePaymentFeeComponent } from "@shared/manage-payments-contract";

export interface ManagePaymentsExistingComponent {
  responsibilityId: string;
  teamId: number;
  bowlerId: number;
  component: ManagePaymentFeeComponent;
  amountMinor: number;
  obligationId: string;
  /** Legacy split groups with one payer are displayed as one full-fee row. */
  coalescedSplitResponsibility?: boolean;
  /** Only an existing worksheet row can preserve a zero-fee choice. */
  zeroWorksheet?: false;
}

export interface ManagePaymentsExistingZeroWorksheet {
  responsibilityId: string;
  teamId: number;
  bowlerId: number;
  component: ManagePaymentFeeComponent;
  amountMinor: 0;
  obligationId: null;
  zeroWorksheet: true;
}

export type ManagePaymentsExistingEvidence = ManagePaymentsExistingComponent | ManagePaymentsExistingZeroWorksheet;

export interface ManagePaymentsDesiredComponent {
  teamId: number;
  bowlerId: number;
  responsible: boolean;
  component: ManagePaymentFeeComponent;
  amountMinor: number;
}

export interface ManagePaymentsReconciliationPlan {
  retainedObligationIds: ReadonlySet<string>;
  retainedZeroResponsibilityIds: ReadonlySet<string>;
  retireObligationIds: ReadonlySet<string>;
  createWorksheetRows: readonly ManagePaymentsDesiredComponent[];
}

export class ManagePaymentsReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagePaymentsReconciliationError";
  }
}

function countExact(
  evidence: readonly ManagePaymentsExistingEvidence[],
  predicate: (row: ManagePaymentsExistingEvidence) => boolean,
): ManagePaymentsExistingEvidence[] {
  return evidence.filter(predicate);
}

function uniqueMatch(matches: readonly ManagePaymentsExistingEvidence[]): ManagePaymentsExistingEvidence | undefined {
  if (matches.length > 1) {
    throw new ManagePaymentsReconciliationError("More than one existing component matches the desired worksheet row");
  }
  return matches[0];
}

/**
 * Retain exact legacy/worksheet obligation components and create worksheet
 * evidence only for desired rows not already represented by those components.
 * A same-owner lineage/prize pair may represent one full-fee row without
 * rewriting either historical component.
 */
export function reconcileManagePaymentsComponents(
  existing: readonly ManagePaymentsExistingEvidence[],
  desired: readonly ManagePaymentsDesiredComponent[],
): ManagePaymentsReconciliationPlan {
  const remaining = [...existing];
  const retainedObligationIds = new Set<string>();
  const retainedZeroResponsibilityIds = new Set<string>();
  const createWorksheetRows: ManagePaymentsDesiredComponent[] = [];

  for (const row of [...desired].sort((left, right) => left.teamId - right.teamId || left.bowlerId - right.bowlerId)) {
    if (!row.responsible) continue;

    const exact = uniqueMatch(countExact(remaining, (candidate) => candidate.teamId === row.teamId
      && candidate.bowlerId === row.bowlerId
      && candidate.component === row.component
      && candidate.amountMinor === row.amountMinor
      && (row.amountMinor > 0 ? candidate.obligationId !== null : candidate.zeroWorksheet === true)));

    if (exact) {
      remaining.splice(remaining.indexOf(exact), 1);
      if (exact.obligationId !== null) retainedObligationIds.add(exact.obligationId);
      else retainedZeroResponsibilityIds.add(exact.responsibilityId);
      continue;
    }

    if (row.amountMinor > 0 && row.component === "full") {
      const lineage = countExact(remaining, (candidate) => candidate.teamId === row.teamId
        && candidate.bowlerId === row.bowlerId
        && candidate.component === "lineage"
        && candidate.obligationId !== null);
      const prize = countExact(remaining, (candidate) => candidate.teamId === row.teamId
        && candidate.bowlerId === row.bowlerId
        && candidate.component === "prize"
        && candidate.obligationId !== null);
      const pairs = lineage.flatMap((lineageRow) => prize
        .filter((prizeRow) => lineageRow.responsibilityId === prizeRow.responsibilityId
          && lineageRow.amountMinor + prizeRow.amountMinor === row.amountMinor)
        .map((prizeRow) => [lineageRow, prizeRow] as const));
      if (pairs.length > 1) {
        throw new ManagePaymentsReconciliationError("More than one split component pair matches the desired full-fee row");
      }
      const pair = pairs[0];
      if (pair) {
        for (const evidence of pair) {
          remaining.splice(remaining.indexOf(evidence), 1);
          if (evidence.obligationId !== null) retainedObligationIds.add(evidence.obligationId);
        }
        continue;
      }
      const coalescedSingle = uniqueMatch(remaining.filter((candidate) => candidate.teamId === row.teamId
        && candidate.bowlerId === row.bowlerId
        && candidate.component !== "full"
        && candidate.amountMinor === row.amountMinor
        && candidate.obligationId !== null
        && candidate.coalescedSplitResponsibility === true));
      if (coalescedSingle) {
        remaining.splice(remaining.indexOf(coalescedSingle), 1);
        if (coalescedSingle.obligationId !== null) retainedObligationIds.add(coalescedSingle.obligationId);
        continue;
      }
    }

    createWorksheetRows.push(row);
  }

  const retireObligationIds = new Set(remaining.flatMap((evidence) => evidence.obligationId === null ? [] : [evidence.obligationId]));
  return { retainedObligationIds, retainedZeroResponsibilityIds, retireObligationIds, createWorksheetRows };
}
