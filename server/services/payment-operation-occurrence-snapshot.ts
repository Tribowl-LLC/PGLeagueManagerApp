import { createHash } from "node:crypto";
import { z } from "zod";
import { PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION } from "@shared/schema";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";

export const PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT =
  "payment-operation-occurrence-snapshot/1" as const;
export const PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_FINGERPRINT_PREFIX =
  "lvpayocc:v1:" as const;

const allocationV1Schema = z.object({
  allocationIndex: z.number().int().min(0),
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  occurrenceId: z.string().uuid(),
  bowlerId: z.number().int().positive(),
  obligationId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

const snapshotV1Schema = z.object({
  contractVersion: z.literal(PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT),
  snapshotVersion: z.literal(PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION),
  operationId: z.string().uuid(),
  operationType: z.enum(["scheduled_charge", "interactive_charge", "canonical_autopay_charge"]),
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  allocations: z.array(allocationV1Schema).min(1).max(100),
}).strict().superRefine((snapshot, ctx) => {
  const indexes = snapshot.allocations.map((allocation) => allocation.allocationIndex);
  if (indexes.some((value, index) => value !== index)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "occurrence allocation indexes must be contiguous and ordered",
    });
  }
  if (snapshot.allocations.some((allocation) => (
    allocation.organizationId !== snapshot.organizationId
    || allocation.leagueId !== snapshot.leagueId
  ))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "occurrence allocations must use the snapshot tenant and league",
    });
  }
  if (snapshot.allocations.some((allocation) => allocation.currency !== snapshot.currency)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "occurrence allocations must use the snapshot currency",
    });
  }
  const total = snapshot.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  if (!Number.isSafeInteger(total) || total !== snapshot.amountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "occurrence allocation total must match the operation amount",
    });
  }
  const obligationIds = snapshot.allocations.map((allocation) => allocation.obligationId);
  if (new Set(obligationIds).size !== obligationIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "occurrence allocation obligations must be unique",
    });
  }
});

export type PaymentOperationOccurrenceSnapshotV1 = z.infer<typeof snapshotV1Schema>;

export class PaymentOperationOccurrenceSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentOperationOccurrenceSnapshotValidationError";
  }
}

/**
 * Explicit version dispatch for the dormant obligation-allocation supplement.
 * Current scheduled v1 and interactive v1/v2 execution snapshots do not call
 * this function and retain their existing bowler-level uniqueness semantics.
 */
export function validatePaymentOperationOccurrenceSnapshot(
  input: unknown,
): PaymentOperationOccurrenceSnapshotV1 {
  if (typeof input !== "object" || input === null || !("snapshotVersion" in input)) {
    throw new PaymentOperationOccurrenceSnapshotValidationError(
      "payment operation occurrence snapshot version is missing",
    );
  }
  const version = (input as { snapshotVersion?: unknown }).snapshotVersion;
  switch (version) {
    case PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION: {
      const parsed = snapshotV1Schema.safeParse(input);
      if (!parsed.success) {
        throw new PaymentOperationOccurrenceSnapshotValidationError(
          "payment operation occurrence snapshot v1 is invalid",
          { cause: parsed.error },
        );
      }
      return parsed.data;
    }
    default:
      throw new PaymentOperationOccurrenceSnapshotValidationError(
        "payment operation occurrence snapshot version is unsupported",
      );
  }
}

export function fingerprintPaymentOperationOccurrenceSnapshot(
  input: PaymentOperationOccurrenceSnapshotV1,
): string {
  const snapshot = validatePaymentOperationOccurrenceSnapshot(input);
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput(snapshot))
    .digest("hex");
  return `${PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}
