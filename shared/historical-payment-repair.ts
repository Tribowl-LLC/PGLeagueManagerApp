import { createHash } from "node:crypto";

export type HistoricalCashAllocationRepairRequest = {
  paymentId: number;
  expectedOldAllocationFingerprint: string;
  expectedTargetAllocationFingerprint: string;
  targetAllocations: Array<{ obligationId: string; amountMinor: number }>;
  reason: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type HistoricalCashAllocationFingerprintRow = {
  allocationId?: string | null;
  obligationId: string;
  amountMinor: number;
  state?: "active" | "voided" | null;
  allocationKind?: "ordinary" | "rotating_credit" | null;
};

function commandFingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Stable evidence digest used by the one-time maintenance runner. */
export function historicalCashAllocationFingerprint(rows: HistoricalCashAllocationFingerprintRow[]): string {
  return commandFingerprint("lvrepaircashalloc:v1", [...rows]
    .map((row) => ({
      allocationId: row.allocationId ?? null,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: row.state ?? null,
      allocationKind: row.allocationKind ?? null,
    }))
    .sort((a, b) => (a.allocationId ?? "").localeCompare(b.allocationId ?? "")
      || a.obligationId.localeCompare(b.obligationId)
      || a.amountMinor - b.amountMinor));
}

export function canonicalHistoricalCashAllocationRepairFingerprint(input: {
  organizationId: number;
  leagueId: number;
  request: Omit<HistoricalCashAllocationRepairRequest, "requestFingerprint">;
}): string {
  return commandFingerprint("lvrepaircash:v1", {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    paymentId: input.request.paymentId,
    expectedOldAllocationFingerprint: input.request.expectedOldAllocationFingerprint,
    expectedTargetAllocationFingerprint: input.request.expectedTargetAllocationFingerprint,
    targetAllocations: [...input.request.targetAllocations]
      .sort((a, b) => a.obligationId.localeCompare(b.obligationId))
      .map((row) => ({ obligationId: row.obligationId, amountMinor: row.amountMinor })),
    reason: input.request.reason,
    idempotencyKey: input.request.idempotencyKey,
  });
}
