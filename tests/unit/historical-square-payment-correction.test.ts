import { describe, expect, it } from "vitest";

// The correction module owns a singleton pool, but this test only exercises
// its pure reviewed-target derivation and must never open a database.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5433/leaguevault";
process.env.SESSION_SECRET ??= "historical-square-test-session";
process.env.FIELD_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { deriveHistoricalSquareCorrectionPlan } = await import("../../server/services/historical-square-payment-correction.js");

describe("historical Square correction target derivation", () => {
  it("retains unchanged source rows while pairing only the moved subset", () => {
    const plan = deriveHistoricalSquareCorrectionPlan(
      [
        { id: "source-a", obligationId: "obligation-a", amountMinor: 100 },
        { id: "source-b", obligationId: "obligation-b", amountMinor: 100 },
        { id: "source-c", obligationId: "obligation-c", amountMinor: 100 },
      ],
      [
        { obligationId: "obligation-a", amountMinor: 100 },
        { obligationId: "obligation-b", amountMinor: 100 },
        { obligationId: "obligation-new", amountMinor: 100 },
      ],
    );

    expect(plan.retainedSources.map((row) => row.id)).toEqual(["source-a", "source-b"]);
    expect(plan.changedSources.map((row) => row.id)).toEqual(["source-c"]);
    expect(plan.replacementTargets).toEqual([{ obligationId: "obligation-new", amountMinor: 100 }]);
    expect(plan.pairs).toEqual([{
      source: { id: "source-c", obligationId: "obligation-c", amountMinor: 100 },
      target: { obligationId: "obligation-new", amountMinor: 100 },
    }]);
  });

  it("retains overlapping source obligations when their reviewed amounts are unchanged", () => {
    const plan = deriveHistoricalSquareCorrectionPlan(
      [
        { id: "source-a", obligationId: "obligation-a", amountMinor: 180 },
        { id: "source-b", obligationId: "obligation-b", amountMinor: 210 },
      ],
      [
        { obligationId: "obligation-a", amountMinor: 180 },
        { obligationId: "obligation-new", amountMinor: 210 },
      ],
    );

    expect(plan.retainedSources).toHaveLength(1);
    expect(plan.retainedSources[0]?.obligationId).toBe("obligation-a");
    expect(plan.pairs[0]?.source.obligationId).toBe("obligation-b");
    expect(plan.pairs[0]?.target.obligationId).toBe("obligation-new");
  });
});
