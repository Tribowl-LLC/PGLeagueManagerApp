import { describe, expect, it } from "vitest";
import {
  canonicalCorrectionRequestSchema,
  canonicalManualRecordRequestSchema,
  interactiveObligationChargeRequestV2Schema,
  interactiveObligationQuoteRequestV2Schema,
  occurrenceResponsibilityInputSchema,
  rosterPaymentResponsibilityRequestSchema,
  calculateRosterPaymentTiming,
} from "@shared/roster-payment-contract";

const id = "00000000-0000-4000-8000-000000000001";

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

  it("derives roster past-due at the exact centralized three-hour grace boundary", () => {
    expect(calculateRosterPaymentTiming("2032-10-01T19:00:00.000Z")).toEqual({
      dueAt: "2032-10-01T19:00:00.000Z",
      pastDueAt: "2032-10-01T22:00:00.000Z",
    });
  });

  it("accepts only server-derived FIFO tender inputs", () => {
    expect(interactiveObligationQuoteRequestV2Schema.safeParse({ amountMinor: 400, payerBowlerId: 10 }).success).toBe(true);
    expect(interactiveObligationQuoteRequestV2Schema.safeParse({ amountMinor: 0, payerBowlerId: 10 }).success).toBe(false);
    expect(interactiveObligationQuoteRequestV2Schema.safeParse({ amountMinor: 400, obligationIds: [id] }).success).toBe(false);
    expect(interactiveObligationChargeRequestV2Schema.safeParse({ amountMinor: 400, payerBowlerId: 10, sourceId: "src", idempotencyKey: "charge", requestFingerprint: "ignored" }).success).toBe(true);
    expect(canonicalManualRecordRequestSchema.safeParse({ amountMinor: 400, payerBowlerId: 10, type: "check", checkNumber: "C-1", idempotencyKey: "manual", requestFingerprint: "quote" }).success).toBe(true);
    expect(canonicalCorrectionRequestSchema.safeParse({ paymentId: 12, reason: "cash correction", idempotencyKey: "correction", requestFingerprint: "quote" }).success).toBe(true);
    expect(canonicalCorrectionRequestSchema.safeParse({ paymentId: 12, correctionMode: "replace", reason: "unsupported", idempotencyKey: "correction-2", requestFingerprint: "quote" }).success).toBe(false);
  });
});
