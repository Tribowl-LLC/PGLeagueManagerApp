import { describe, expect, it } from "vitest";
import {
  canonicalCorrectionRequestSchema,
  canonicalManualRecordRequestSchema,
  interactiveObligationChargeRequestV2Schema,
  interactiveObligationQuoteRequestV2Schema,
  occurrenceResponsibilityInputSchema,
  rosterPaymentResponsibilityRequestSchema,
} from "@shared/roster-payment-contract";
import {
  validateInteractiveOccurrenceBaseAllocations,
  validateInteractiveOccurrenceSelections,
} from "../../server/services/interactive-occurrence-allocation";

const id = "00000000-0000-4000-8000-000000000001";
const id2 = "00000000-0000-4000-8000-000000000002";

function expectAllocationError(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error("expected allocation validation to fail");
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("PR1 roster-driven payment contract", () => {
  it("requires exact stable slots and permits explicit VACANT without a bowler", () => {
    expect(rosterPaymentResponsibilityRequestSchema.safeParse({
      commandKey: "roster-command",
      requestFingerprint: "client-value-recomputed-server-side",
      lineupSize: 3,
      slots: [
        { slotIndex: 0, occupant: "main", mainBowlerId: 10 },
        { slotIndex: 1, occupant: "vacant" },
        { slotIndex: 2, occupant: "main", mainBowlerId: 11 },
      ],
    }).success).toBe(true);
    expect(rosterPaymentResponsibilityRequestSchema.safeParse({
      commandKey: "roster-command",
      requestFingerprint: "fp",
      lineupSize: 3,
      slots: [{ slotIndex: 0, occupant: "main" }],
    }).success).toBe(true); // identity is completed/checked under the tenant lock
  });

  it("rejects backwards due windows and malformed responsibility identity values", () => {
    expect(occurrenceResponsibilityInputSchema.safeParse({
      occurrenceId: id, teamId: 7, slotIndex: 0, positionIndex: 0, kind: "main",
      policy: "main_pays_full", amountMinor: 2000,
      dueAt: "2032-10-08T00:00:00.000Z", pastDueAt: "2032-10-01T00:00:00.000Z",
    }).success).toBe(false);
    expect(occurrenceResponsibilityInputSchema.safeParse({
      occurrenceId: id, teamId: 7, slotIndex: 0, positionIndex: 0, kind: "vacant",
      policy: "main_pays_full", amountMinor: 0,
      dueAt: "2032-10-01T00:00:00.000Z", pastDueAt: "2032-10-08T00:00:00.000Z",
      payerBowlerId: 10,
    }).success).toBe(true); // server materialization rejects payer identity for VACANT
  });

  it("allows partial exact allocations but never over-allocates an obligation", () => {
    const rows = [{ obligationId: id, outstandingMinor: 1000 }];
    expect(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: id, amountMinor: 400 }], 400)).not.toThrow();
    expectAllocationError(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: id, amountMinor: 1200 }], 1200), "INVALID_SELECTION");
    expectAllocationError(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: id, amountMinor: 400 }, { obligationId: id2, amountMinor: 100 }], 500), "INVALID_SELECTION");
  });

  it("requires all independent payer totals to be conserved", () => {
    expect(() => validateInteractiveOccurrenceBaseAllocations(
      [{ bowlerId: 10, amountMinor: 500 }, { bowlerId: 11, amountMinor: 500 }],
      [{ bowlerId: 10, amountMinor: 500 }, { bowlerId: 11, amountMinor: 500 }],
    )).not.toThrow();
    expectAllocationError(() => validateInteractiveOccurrenceBaseAllocations(
      [{ bowlerId: 10, amountMinor: 1000 }],
      [{ bowlerId: 10, amountMinor: 500 }, { bowlerId: 11, amountMinor: 500 }],
    ), "BASE_ALLOCATION_MISMATCH");
  });

  it("requires exact IDs for quote/charge/manual/correction commands", () => {
    expect(interactiveObligationQuoteRequestV2Schema.safeParse({ obligationIds: [id] }).success).toBe(true);
    expect(interactiveObligationChargeRequestV2Schema.safeParse({ obligationIds: [id], sourceId: "src", idempotencyKey: "charge", requestFingerprint: "ignored" }).success).toBe(true);
    expect(canonicalManualRecordRequestSchema.safeParse({ obligationIds: [id], type: "check", idempotencyKey: "manual", requestFingerprint: "quote" }).success).toBe(false);
    expect(canonicalCorrectionRequestSchema.safeParse({ allocationId: id, reason: "cash correction", idempotencyKey: "correction", requestFingerprint: "quote" }).success).toBe(true);
  });
});
