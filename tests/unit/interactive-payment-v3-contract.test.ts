import { describe, expect, it } from "vitest";
import { interactivePaymentChargeRequestV3Schema, interactivePaymentQuoteRequestV3Schema } from "@shared/interactive-payment-v3-contract";
import { buildOneTimePaymentOptions } from "@shared/one-time-payment-options";

describe("interactive payment v3 contracts", () => {
  it("requires unique recipients and bounded URL-safe idempotency keys", () => {
    expect(interactivePaymentQuoteRequestV3Schema.safeParse({ recipients: [{ bowlerId: 1, weeks: 1, fullBalance: false }, { bowlerId: 1, weeks: 2, fullBalance: false }] }).success).toBe(false);
    expect(interactivePaymentChargeRequestV3Schema.safeParse({
      recipients: [{ bowlerId: 1, weeks: 1, fullBalance: false }], sourceId: "nonce", sourceKind: "new_card", idempotencyKey: "too-short", requestFingerprint: "lvpartnerquote:v3:" + "a".repeat(64),
    }).success).toBe(false);
  });

  it("preserves the partial-credit weekly option and FIFO spill amount", () => {
    const options = buildOneTimePaymentOptions([
      { occurrenceId: "week-1", amountMinor: 3000, outstandingMinor: 1000, state: "partially_settled" },
      { occurrenceId: "week-2", amountMinor: 3000, outstandingMinor: 3000, state: "open" },
    ], 4000);
    expect(options).toEqual([{ weekCount: 1, amountMinor: 3000 }, { weekCount: 2, amountMinor: 4000 }]);
  });
});
