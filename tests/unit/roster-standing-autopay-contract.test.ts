import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { standingAutopayConsentRequestSchema, standingAutopayQuoteRequestSchema, standingAutopayRevokeRequestSchema } from "@shared/standing-autopay-contract";
import { PAYMENT_OPERATION_TYPES, paymentOperations } from "@shared/schema";

const consentCommandKey = ["standing", "consent", "fixture"].join("-");
const revokeCommandKey = ["standing", "revoke", "fixture"].join("-");
const partnerCommandKey = ["standing", "consent", "partner", "fixture"].join("-");
const sourceFixture = ["saved", "source", "fixture"].join("-");

describe("standing automatic-payment contract", () => {
  it("uses a distinct ledger operation and derives customer identity server-side", () => {
    expect(PAYMENT_OPERATION_TYPES).toContain("standing_autopay_charge");
    expect(paymentOperations.operationType.enumValues).toContain("standing_autopay_charge");
    const parsed = standingAutopayConsentRequestSchema.parse({
      commandKey: consentCommandKey,
      sourceId: sourceFixture,
      partnerBowlerIds: [8, 9],
    });
    expect(parsed).toEqual({ commandKey: consentCommandKey, sourceId: sourceFixture, partnerBowlerIds: [8, 9] });
  });

  it("rejects arbitrary payer identity and malformed command keys", () => {
    expect(() => standingAutopayConsentRequestSchema.parse({ commandKey: "short", sourceId: "card", providerName: "square", providerLocationId: "1" })).toThrow();
    expect(() => standingAutopayConsentRequestSchema.parse({ commandKey: consentCommandKey, sourceId: "card", customerId: "other-customer", providerName: "square", providerLocationId: "1", partnerBowlerIds: [] })).toThrow();
  });

  it("keeps quote/revoke requests narrow and strict", () => {
    expect(standingAutopayQuoteRequestSchema.parse({})).toEqual({});
    expect(standingAutopayRevokeRequestSchema.parse({ commandKey: revokeCommandKey }).commandKey).toBe(revokeCommandKey);
    expect(() => standingAutopayQuoteRequestSchema.parse({ obligationIds: ["legacy-id"] })).toThrow();
  });

  it("keeps partner selection explicit and bounded by accepted-link evidence", () => {
    const parsed = standingAutopayConsentRequestSchema.parse({
      commandKey: partnerCommandKey,
      sourceId: sourceFixture,
      partnerBowlerIds: [12, 14, 12],
    });
    expect(parsed.partnerBowlerIds).toEqual([12, 14, 12]);
    expect(() => standingAutopayConsentRequestSchema.parse({
      commandKey: partnerCommandKey,
      sourceId: sourceFixture,
      partnerBowlerIds: Array.from({ length: 33 }, (_, index) => index + 1),
    })).toThrow();
  });

  it("keeps the scheduler and migration on the clean standing boundary", () => {
    const wakeSource = readFileSync("server/storage/payment-operations.ts", "utf8");
    const migration = readFileSync("migrations/0034_pr3_canonical_steady_state.sql", "utf8");
    expect(wakeSource).toContain("po.operation_type = 'standing_autopay_charge'");
    expect(wakeSource).toContain("po.status <> 'provider_unknown' OR po.provider_object_id IS NULL");
    expect(migration).toContain("LOCK TABLE \"payment_schedules\", \"autopay_setup_requests\"");
    expect(migration).toContain("0034 refused: canonical financial or standing evidence is not empty");
    expect(migration).toContain("payment_operation_standing_autopay_bindings");
    expect(migration).not.toContain("CASCADE");
    expect(migration).toContain('DELETE FROM "refund_payment_operation_snapshots"');
    expect(migration).toContain('DELETE FROM "payments"');
    expect(migration).toContain('DELETE FROM "payment_operations"');
    expect(migration).toContain('ALTER TABLE "games" ALTER COLUMN "occurrence_id" SET NOT NULL');
    expect(migration).not.toContain('active legacy payment schedules require');
  });
});
