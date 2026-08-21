import { describe, expect, it } from "vitest";
import {
  CanonicalCollectionGroupingError,
  deriveCanonicalCollectionPairs,
} from "@shared/canonical-collection-groups";

function occurrence(index: number, overrides: Partial<Parameters<typeof deriveCanonicalCollectionPairs>[0]["occurrences"][number]> = {}) {
  const date = `2027-0${index + 1}-0${index + 1}`;
  return {
    occurrenceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    localDate: date,
    status: "scheduled" as const,
    lifecycle: "published" as const,
    billingTerm: {
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      obligationPolicy: "eligible_bowlers" as const,
      billingOrdinal: index + 1,
      amountMinor: 500,
      currency: "USD",
    },
    ...overrides,
  };
}

describe("canonical double-pay collection pairing", () => {
  it("pairs sorted triggers with the sorted final tail without changing rows or amounts", () => {
    const rows = Array.from({ length: 7 }, (_, index) => occurrence(index));
    const pairs = deriveCanonicalCollectionPairs({
      doublePayDates: [rows[1].localDate, rows[0].localDate],
      occurrences: rows,
    });
    expect(pairs.map((pair) => [pair.trigger.localDate, pair.paired.localDate])).toEqual([
      ["2027-01-01", "2027-06-06"],
      ["2027-02-02", "2027-07-07"],
    ]);
    expect(pairs[0]?.trigger.amountMinor).toBe(500);
    expect(pairs[0]?.paired.amountMinor).toBe(500);
    expect(new Set(pairs.flatMap((pair) => pair.paired.occurrenceId)).size).toBe(2);
  });

  it("matches the audited 19073-style final-season mapping", () => {
    const dates = [
      "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02",
      "2027-04-12", "2027-04-19", "2027-04-26", "2027-05-03",
    ];
    const rows = dates.map((localDate, index) => occurrence(index, { localDate }));
    const pairs = deriveCanonicalCollectionPairs({
      doublePayDates: ["2026-10-19", "2026-10-12"],
      occurrences: rows,
    });
    expect(pairs.map((pair) => [pair.trigger.localDate, pair.paired.localDate])).toEqual([
      ["2026-10-12", "2027-04-26"],
      ["2026-10-19", "2027-05-03"],
    ]);
  });

  it("retains skips and rejects nonbillable triggers or insufficient tails", () => {
    const skipped = occurrence(1, { status: "cancelled", billingTerm: { id: "10000000-0000-4000-8000-000000000002", obligationPolicy: "none", billingOrdinal: null, amountMinor: 0, currency: "USD" } });
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: [skipped.localDate], occurrences: [skipped, occurrence(0), occurrence(2)] }))
      .toThrowError(CanonicalCollectionGroupingError);
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-01-01", "2027-02-02"], occurrences: [occurrence(0), occurrence(1), occurrence(2)] }))
      .toThrow(/not enough final billable/);
  });

  it("rejects duplicate and invalid calendar inputs", () => {
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-01-01", "2027-01-01"], occurrences: [] }))
      .toThrow(/unique/);
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-02-30"], occurrences: [] }))
      .toThrow(/invalid double-pay date/);
  });
});
