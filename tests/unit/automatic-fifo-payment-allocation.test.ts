import { describe, expect, it } from "vitest";
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
    expect(allocateAutomaticFifoPayment(100_00, rows, "weekly", "2026-02-01T00:00:00.000Z")).toEqual([
      { obligationId: "1", amountMinor: 30_00 },
      { obligationId: "2", amountMinor: 30_00 },
      { obligationId: "3", amountMinor: 30_00 },
      { obligationId: "4", amountMinor: 10_00 },
    ]);
  });

  it("continues a prior partial before later obligations", () => {
    const rows = [candidate("old", 10_00, "2026-01-01T00:00:00.000Z"), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")];
    expect(allocateAutomaticFifoPayment(40_00, rows, "weekly", "2026-02-01T00:00:00.000Z")).toEqual([{ obligationId: "old", amountMinor: 10_00 }, { obligationId: "new", amountMinor: 30_00 }]);
  });

  it("orders older debt, current trigger, paired final, then normal future", () => {
    const rows = [
      candidate("older", 30_00, "2026-01-01T00:00:00.000Z"),
      candidate("trigger", 30_00, "2026-02-01T00:00:00.000Z"),
      candidate("pair", 30_00, "2026-03-01T00:00:00.000Z", { pairedCollectionReady: true }),
      candidate("future", 30_00, "2026-04-01T00:00:00.000Z"),
    ];
    expect(allocateAutomaticFifoPayment(120_00, rows, "weekly", "2026-02-01T00:00:00.000Z")).toEqual([
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
    expect(allocateAutomaticFifoPayment(60_00, rows, "weekly", "2026-02-11T00:00:00.000Z")).toEqual([
      { obligationId: "earlier-trigger", amountMinor: 30_00 },
      { obligationId: "later-trigger", amountMinor: 30_00 },
    ]);
  });

  it("keeps an unreached paired occurrence in ordinary future-date order", () => {
    const rows = [
      candidate("normal-future", 30_00, "2026-03-01T00:00:00.000Z"),
      candidate("unreached-pair", 30_00, "2026-04-01T00:00:00.000Z"),
    ];
    expect(allocateAutomaticFifoPayment(60_00, rows, "weekly", "2026-02-01T00:00:00.000Z")).toEqual([
      { obligationId: "normal-future", amountMinor: 30_00 },
      { obligationId: "unreached-pair", amountMinor: 30_00 },
    ]);
  });

  it("can collect a payer's paired obligation when the trigger obligation is not theirs", () => {
    const paired = candidate("paired-only", 30_00, "2026-04-01T00:00:00.000Z", { pairedCollectionReady: true, effectiveCollectionAt: "2026-02-01T00:00:00.000Z" });
    expect(allocateAutomaticFifoPayment(30_00, [paired], "weekly", "2026-02-02T00:00:00.000Z")).toEqual([{ obligationId: "paired-only", amountMinor: 30_00 }]);
  });

  it("fails at the oldest reserved capacity and rejects excess", () => {
    expect(() => allocateAutomaticFifoPayment(20_00, [candidate("old", 30_00, "2026-01-01T00:00:00.000Z", { reservedMinor: 1_00 }), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")], "weekly", "2026-02-01T00:00:00.000Z")).toThrowError(AutomaticFifoAllocationError);
    expect(() => allocateAutomaticFifoPayment(61_00, [candidate("old", 30_00, "2026-01-01T00:00:00.000Z"), candidate("new", 30_00, "2026-01-08T00:00:00.000Z")], "weekly", "2026-02-01T00:00:00.000Z")).toThrowError(/exceeds/);
  });

  it("requires full remaining balance for upfront checkout", () => {
    expect(allocateAutomaticFifoPayment(60_00, [candidate("old", 30_00, "2036-01-01T00:00:00.000Z"), candidate("new", 30_00, "2036-01-08T00:00:00.000Z")], "upfront", "2026-02-01T00:00:00.000Z")).toHaveLength(2);
  });
});
