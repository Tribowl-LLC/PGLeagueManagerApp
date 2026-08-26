import { describe, expect, it } from "vitest";
import {
  canonicalManualRecordRequestSchema,
  occurrenceResponsibilityInputSchema,
  rosterPaymentResponsibilityRequestSchema,
} from "@shared/roster-payment-contract";

describe("roster-driven payment contracts", () => {
  it("requires every stable slot and permits explicit VACANT", () => {
    const parsed = rosterPaymentResponsibilityRequestSchema.safeParse({
      commandKey: "roster-1",
      requestFingerprint: "fp-1",
      lineupSize: 3,
      slots: [
        { slotIndex: 0, occupant: "main", mainBowlerId: 11 },
        { slotIndex: 1, occupant: "vacant" },
        { slotIndex: 2, occupant: "unassigned" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts split component evidence without turning it into score input", () => {
    const parsed = occurrenceResponsibilityInputSchema.safeParse({
      occurrenceId: "00000000-0000-4000-8000-000000000001",
      teamId: 7,
      slotIndex: 0,
      positionIndex: 0,
      kind: "split",
      mainBowlerId: 11,
      substituteBowlerId: 12,
      policy: "special_split",
      amountMinor: 2000,
      lineageAmountMinor: 1200,
      prizeFundAmountMinor: 800,
      dueAt: "2032-10-01T00:00:00.000Z",
      pastDueAt: "2032-10-08T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a positive tender amount and quote fingerprint for manual entry", () => {
    expect(canonicalManualRecordRequestSchema.safeParse({
      amountMinor: 2_000,
      payerBowlerId: 11,
      type: "cash",
      idempotencyKey: "manual-1",
      requestFingerprint: "lvrosterquote:v1:abc",
    }).success).toBe(true);
    expect(canonicalManualRecordRequestSchema.safeParse({
      type: "cash",
      idempotencyKey: "manual-1",
      requestFingerprint: "quote",
    }).success).toBe(false);
  });
});
