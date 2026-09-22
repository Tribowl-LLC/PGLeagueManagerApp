import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalManualRecordBatchQuoteRequestSchema,
  canonicalManualRecordBatchRequestSchema,
  canonicalManualRecordRequestSchema,
  occurrenceResponsibilityInputSchema,
  rosterPaymentResponsibilityRequestSchema,
  serializeCanonicalResponsibilityFingerprint,
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

  it("serializes responsibility identity in canonical order with nulls and excludes mutable evidence", () => {
    const rows = [
      {
        occurrenceId: "00000000-0000-4000-8000-000000000002",
        teamId: 7,
        slotIndex: 2,
        positionIndex: 1,
        kind: "substitute" as const,
        mainBowlerId: 10,
        substituteBowlerId: 11,
        payerBowlerId: 11,
        policy: "sub_pays_full" as const,
        amountMinor: 999,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt: "2038-01-10T03:00:00.000Z",
        pastDueAt: "2038-01-10T06:00:00.000Z",
      },
      {
        occurrenceId: "00000000-0000-4000-8000-000000000001",
        teamId: 7,
        slotIndex: 0,
        positionIndex: 0,
        kind: "vacant" as const,
        mainBowlerId: undefined,
        substituteBowlerId: undefined,
        payerBowlerId: undefined,
        policy: "main_pays_full" as const,
        amountMinor: 0,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt: "2038-01-03T03:00:00.000Z",
        pastDueAt: "2038-01-03T06:00:00.000Z",
      },
      {
        occurrenceId: "00000000-0000-4000-8000-000000000002",
        teamId: 7,
        slotIndex: 0,
        positionIndex: 0,
        kind: "main" as const,
        mainBowlerId: 10,
        substituteBowlerId: null,
        payerBowlerId: 10,
        policy: "main_pays_full" as const,
        amountMinor: 2_000,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt: "2038-01-10T03:00:00.000Z",
        pastDueAt: "2038-01-10T06:00:00.000Z",
      },
    ];

    const serialized = serializeCanonicalResponsibilityFingerprint(rows);
    expect(serialized).toBe(JSON.stringify([
      {
        occurrenceId: "00000000-0000-4000-8000-000000000001",
        teamId: 7,
        slotIndex: 0,
        positionIndex: 0,
        kind: "vacant",
        mainBowlerId: null,
        substituteBowlerId: null,
        payerBowlerId: null,
        policy: "main_pays_full",
      },
      {
        occurrenceId: "00000000-0000-4000-8000-000000000002",
        teamId: 7,
        slotIndex: 0,
        positionIndex: 0,
        kind: "main",
        mainBowlerId: 10,
        substituteBowlerId: null,
        payerBowlerId: 10,
        policy: "main_pays_full",
      },
      {
        occurrenceId: "00000000-0000-4000-8000-000000000002",
        teamId: 7,
        slotIndex: 2,
        positionIndex: 1,
        kind: "substitute",
        mainBowlerId: 10,
        substituteBowlerId: 11,
        payerBowlerId: 11,
        policy: "sub_pays_full",
      },
    ]));

    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const changedEvidence = rows.map((row, index) => ({
      ...row,
      amountMinor: 50_000 + index,
      lineageAmountMinor: index,
      prizeFundAmountMinor: 49_000 - index,
      dueAt: `2040-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      pastDueAt: `2040-02-${String(index + 1).padStart(2, "0")}T03:00:00.000Z`,
    }));
    expect(serializeCanonicalResponsibilityFingerprint(changedEvidence)).toBe(serialized);
    expect(hash(serializeCanonicalResponsibilityFingerprint(changedEvidence))).toBe(hash(serialized));

    const changedIdentity = rows.map((row) => row.occurrenceId === "00000000-0000-4000-8000-000000000002" && row.positionIndex === 1
      ? { ...row, substituteBowlerId: 12 }
      : row);
    expect(hash(serializeCanonicalResponsibilityFingerprint(changedIdentity))).not.toBe(hash(serialized));

    const changedPolicy = rows.map((row) => row.occurrenceId === "00000000-0000-4000-8000-000000000002" && row.positionIndex === 1
      ? { ...row, policy: "main_pays_full" as const, payerBowlerId: 10 }
      : row);
    expect(hash(serializeCanonicalResponsibilityFingerprint(changedPolicy))).not.toBe(hash(serialized));
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

  it("bounds management batches and keeps payer/idempotency identities distinct", () => {
    const quoteRow = (index: number) => ({ rowKey: `batch-row-${String(index).padStart(12, "0")}`, amountMinor: 2_000, payerBowlerId: index + 1 });
    expect(canonicalManualRecordBatchQuoteRequestSchema.safeParse({ rows: Array.from({ length: 200 }, (_, index) => quoteRow(index)) }).success).toBe(true);
    expect(canonicalManualRecordBatchQuoteRequestSchema.safeParse({ rows: Array.from({ length: 201 }, (_, index) => quoteRow(index)) }).success).toBe(false);
    expect(canonicalManualRecordBatchQuoteRequestSchema.safeParse({ rows: [quoteRow(1), quoteRow(1)] }).success).toBe(false);
    expect(canonicalManualRecordBatchQuoteRequestSchema.safeParse({ rows: [quoteRow(1), quoteRow(2)] }).success).toBe(true);
    expect(canonicalManualRecordBatchQuoteRequestSchema.safeParse({ rows: [quoteRow(1), { ...quoteRow(2), rowKey: "batch-row-other-123", payerBowlerId: 2 }] }).success).toBe(false);

    const row = { rowKey: "batch-record-row-1234", amountMinor: 2_000, payerBowlerId: 11, type: "cash" as const, idempotencyKey: "batch-record-key-1234", requestFingerprint: "quote" };
    expect(canonicalManualRecordBatchRequestSchema.safeParse({ rows: [row] }).success).toBe(false);
    expect(canonicalManualRecordBatchRequestSchema.safeParse({ rows: [{ ...row, rowKey: row.idempotencyKey }] }).success).toBe(true);
    expect(canonicalManualRecordBatchRequestSchema.safeParse({ rows: [{ ...row, rowKey: row.idempotencyKey, checkNumber: "123" }] }).success).toBe(false);
    expect(canonicalManualRecordBatchRequestSchema.safeParse({ rows: [
      { ...row, rowKey: "batch-record-key-one", idempotencyKey: "batch-record-key-one" },
      { ...row, rowKey: "batch-record-key-two", idempotencyKey: "batch-record-key-two" },
    ] }).success).toBe(false);
  });
});
