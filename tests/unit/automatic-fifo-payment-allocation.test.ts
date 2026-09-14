import { describe, expect, it, vi } from "vitest";
import { allocateAutomaticFifoPayment, AutomaticFifoAllocationError, type FifoPaymentCandidate } from "../../server/services/automatic-fifo-allocation";

const candidate = (id: string, outstandingMinor: number, dueAt: string, extra: Partial<FifoPaymentCandidate> = {}): FifoPaymentCandidate => ({
  id,
  occurrenceId: `occ-${id}`,
  effectiveCollectionAt: dueAt,
  outstandingMinor,
  dueAt,
  memberOrdinal: 0,
  billingOrdinal: 0,
  reservedMinor: 0,
  reviewRequired: false,
  pairedCollectionReady: false,
  ...extra,
});

describe("automatic FIFO payment allocation", () => {
  it("finishes each oldest weekly obligation before moving on", () => {
    const rows = [1, 2, 3, 4].map((id) => candidate(String(id), 30_00, `2026-01-0${id}T00:00:00.000Z`));
    expect(allocateAutomaticFifoPayment(100_00, rows)).toEqual([
      { obligationId: "1", amountMinor: 30_00 },
      { obligationId: "2", amountMinor: 30_00 },
      { obligationId: "3", amountMinor: 30_00 },
      { obligationId: "4", amountMinor: 10_00 },
    ]);
  });

  it("continues a prior partial before later obligations", () => {
    const rows = [candidate("old", 10_00, "2026-01-01T00:00:00.000Z"), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")];
    expect(allocateAutomaticFifoPayment(40_00, rows)).toEqual([{ obligationId: "old", amountMinor: 10_00 }, { obligationId: "new", amountMinor: 30_00 }]);
  });

  it("orders candidates by their published effective collection timestamp", () => {
    const rows = [
      candidate("older", 30_00, "2026-01-01T00:00:00.000Z", { effectiveCollectionAt: "2026-01-01T00:00:00.000Z" }),
      candidate("trigger", 30_00, "2026-02-01T00:00:00.000Z", { memberOrdinal: 1, effectiveCollectionAt: "2026-02-01T00:00:00.000Z" }),
      candidate("pair", 30_00, "2026-03-01T00:00:00.000Z", { memberOrdinal: 2, pairedCollectionReady: true, effectiveCollectionAt: "2026-02-01T00:00:00.000Z" }),
      candidate("future", 30_00, "2026-04-01T00:00:00.000Z", { effectiveCollectionAt: "2026-04-01T00:00:00.000Z" }),
    ];
    expect(allocateAutomaticFifoPayment(120_00, rows)).toEqual([
      { obligationId: "older", amountMinor: 30_00 },
      { obligationId: "trigger", amountMinor: 30_00 },
      { obligationId: "pair", amountMinor: 30_00 },
      { obligationId: "future", amountMinor: 30_00 },
    ]);
  });

  it("orders reached paired groups by trigger evidence rather than paired due dates", () => {
    const rows = [
      candidate("later-trigger", 30_00, "2026-03-01T00:00:00.000Z", { pairedCollectionReady: true, effectiveCollectionAt: "2026-02-10T00:00:00.000Z" }),
      candidate("earlier-trigger", 30_00, "2026-04-01T00:00:00.000Z", { pairedCollectionReady: true, effectiveCollectionAt: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(allocateAutomaticFifoPayment(60_00, rows)).toEqual([
      { obligationId: "earlier-trigger", amountMinor: 30_00 },
      { obligationId: "later-trigger", amountMinor: 30_00 },
    ]);
  });

  it("keeps a published paired occurrence in collection order before, on, and after its trigger", () => {
    const rows = [
      candidate("normal-future", 30_00, "2026-02-10T00:00:00.000Z"),
      candidate("published-pair", 30_00, "2026-04-01T00:00:00.000Z", { effectiveCollectionAt: "2026-02-05T00:00:00.000Z" }),
    ];
    vi.useFakeTimers();
    try {
      for (const now of ["2026-02-01T00:00:00.000Z", "2026-02-05T00:00:00.000Z", "2026-02-11T00:00:00.000Z"]) {
        vi.setSystemTime(new Date(now));
        expect(allocateAutomaticFifoPayment(30_00, rows)).toEqual([{ obligationId: "published-pair", amountMinor: 30_00 }]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("can collect a payer's paired obligation when the trigger obligation is not theirs", () => {
    const paired = candidate("paired-only", 30_00, "2026-04-01T00:00:00.000Z", { pairedCollectionReady: true, effectiveCollectionAt: "2026-02-01T00:00:00.000Z" });
    expect(allocateAutomaticFifoPayment(30_00, [paired])).toEqual([{ obligationId: "paired-only", amountMinor: 30_00 }]);
  });

  it("finishes a published pair's partial balance before a later ordinary obligation", () => {
    const rows = [
      candidate("ordinary", 30_00, "2026-02-06T00:00:00.000Z"),
      candidate("pair-partial", 10_00, "2026-04-01T00:00:00.000Z", { effectiveCollectionAt: "2026-02-05T00:00:00.000Z" }),
    ];
    expect(allocateAutomaticFifoPayment(10_00, rows)).toEqual([{ obligationId: "pair-partial", amountMinor: 10_00 }]);
  });

  it("skips settled candidates while retaining published order for open debt", () => {
    const rows = [
      candidate("settled", 0, "2026-02-01T00:00:00.000Z", { effectiveCollectionAt: "2026-02-01T00:00:00.000Z" }),
      candidate("pair", 30_00, "2026-04-01T00:00:00.000Z", { effectiveCollectionAt: "2026-02-05T00:00:00.000Z" }),
      candidate("ordinary", 30_00, "2026-02-06T00:00:00.000Z"),
    ];
    expect(allocateAutomaticFifoPayment(30_00, rows)).toEqual([{ obligationId: "pair", amountMinor: 30_00 }]);
  });

  it("orders the published 31-week sequence as 1-5,30,6,31,7-29", () => {
    const rows = Array.from({ length: 31 }, (_, index) => {
      const week = index + 1;
      const day = String(week).padStart(2, "0");
      return candidate(String(week), 100, `2026-01-${day}T00:00:00.000Z`, { effectiveCollectionAt: `2026-01-${day}T00:00:00.000Z` });
    });
    const week5 = rows[4];
    const week6 = rows[5];
    const week30 = rows[29];
    const week31 = rows[30];
    if (!week5 || !week6 || !week30 || !week31) throw new Error("31-week fixture is incomplete");
    Object.assign(week5, { memberOrdinal: 1 });
    Object.assign(week30, { memberOrdinal: 2, effectiveCollectionAt: week5.effectiveCollectionAt });
    Object.assign(week6, { memberOrdinal: 1 });
    Object.assign(week31, { memberOrdinal: 2, effectiveCollectionAt: week6.effectiveCollectionAt });
    expect(allocateAutomaticFifoPayment(31 * 100, rows).map((row) => row.obligationId)).toEqual([
      "1", "2", "3", "4", "5", "30", "6", "31", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
    ]);
  });

  it("fails review evidence on the oldest published paired candidate", () => {
    const rows = [
      candidate("ordinary", 30_00, "2026-02-06T00:00:00.000Z"),
      candidate("pair-review", 30_00, "2026-04-01T00:00:00.000Z", { effectiveCollectionAt: "2026-02-05T00:00:00.000Z", reviewRequired: true }),
    ];
    expect(() => allocateAutomaticFifoPayment(10_00, rows)).toThrowError(AutomaticFifoAllocationError);
  });

  it("fails at the oldest reserved capacity and rejects excess", () => {
    expect(() => allocateAutomaticFifoPayment(20_00, [candidate("old", 30_00, "2026-01-01T00:00:00.000Z", { reservedMinor: 1_00 }), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")])).toThrowError(AutomaticFifoAllocationError);
    expect(() => allocateAutomaticFifoPayment(61_00, [candidate("old", 30_00, "2026-01-01T00:00:00.000Z"), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")])).toThrowError(/exceeds/);
  });

  it("allocates a complete remaining balance for upfront checkout", () => {
    expect(allocateAutomaticFifoPayment(60_00, [candidate("old", 30_00, "2036-01-01T00:00:00.000Z"), candidate("new", 30_00, "2036-01-08T00:00:00.000Z")])).toHaveLength(2);
  });
});
