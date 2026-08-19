import { createHash } from "node:crypto";
import { z } from "zod";

export const F4_EXECUTION_CONTRACT = "canonical-autopay-execution/1" as const;
export const F4_EXECUTION_SNAPSHOT_VERSION = 1 as const;
export const F4_EXECUTION_SNAPSHOT_FINGERPRINT_PREFIX = "lvf4exec:v1:" as const;
export const F4_PROVIDER_IDEMPOTENCY_PREFIX = "lv-f4-pay-" as const;
export const F4_OPERATION_TARGET_PREFIX = "canonical-autopay-plan:" as const;

export const f4PlanItemSchema = z.object({
  obligationId: z.string().uuid(), occurrenceId: z.string().uuid(), bowlerId: z.number().int().positive(),
  amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), itemIndex: z.number().int().nonnegative(),
}).strict();

export const f4ExecutionSnapshotSchema = z.object({
  contractVersion: z.literal(F4_EXECUTION_CONTRACT), snapshotVersion: z.literal(F4_EXECUTION_SNAPSHOT_VERSION),
  operationId: z.string().uuid(), organizationId: z.number().int().positive(), leagueId: z.number().int().positive(),
  d2PlanId: z.string().uuid(), collectionPointOccurrenceId: z.string().uuid(), triggerOccurrenceId: z.string().uuid(),
  payerBowlerId: z.number().int().positive(), locationId: z.number().int().positive(), providerLocationId: z.string().trim().min(1).max(255),
  activationId: z.string().uuid(), activationRevision: z.number().int().positive(), activationSourceFingerprint: z.string().regex(/^lvfinancialsource:v1:[0-9a-f]{64}$/),
  policyId: z.string().uuid(), policyVersion: z.number().int().positive(), policyFingerprint: z.string().regex(/^lvf3policy:v1:[0-9a-f]{64}$/),
  authorizationId: z.string().uuid(), authorizationVersion: z.number().int().positive(), authorizationFingerprint: z.string().regex(/^lvf3auth:v1:[0-9a-f]{64}$/),
  planVersion: z.number().int().positive(), planFingerprint: z.string().regex(/^lvf3plan:v1:[0-9a-f]{64}$/),
  amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), items: z.array(f4PlanItemSchema).min(1).max(100),
  encryptedSourceId: z.string().min(1), encryptedCustomerId: z.string().nullable(), snapshotFingerprint: z.string().regex(/^lvf4exec:v1:[0-9a-f]{64}$/).optional(),
}).strict().superRefine((snapshot, ctx) => {
  const indexes = snapshot.items.map((item) => item.itemIndex);
  if (indexes.some((item, index) => item !== index)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "F4 items must be contiguous and ordered" });
  if (snapshot.items.some((item) => item.currency !== snapshot.currency)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "F4 item currency mismatch" });
  if (snapshot.items.reduce((total, item) => total + item.amountMinor, 0) !== snapshot.amountMinor) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "F4 item total mismatch" });
});

export type F4ExecutionSnapshot = z.infer<typeof f4ExecutionSnapshotSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function canonicalAutopayTargetKey(d2PlanId: string): string {
  const planId = z.string().uuid().parse(d2PlanId);
  return `${F4_OPERATION_TARGET_PREFIX}${planId}`;
}

/** F4's provider key is a distinct namespace and never reuses v1/v2 keys. */
export function canonicalAutopayProviderIdempotencyKey(input: { organizationId: number; d2PlanId: string; amountMinor: number; currency: string; providerName: string }): string {
  const normalized = { domain: "canonical-autopay-charge", ...input, d2PlanId: z.string().uuid().parse(input.d2PlanId), currency: input.currency.toUpperCase() };
  const digest = createHash("sha256").update(canonicalJson(normalized)).digest("base64url").slice(0, 32);
  return `${F4_PROVIDER_IDEMPOTENCY_PREFIX}${digest}`;
}

export function f4ExecutionSnapshotFingerprint(snapshot: Omit<F4ExecutionSnapshot, "snapshotFingerprint">): string {
  const parsed = f4ExecutionSnapshotSchema.omit({ snapshotFingerprint: true }).parse(snapshot);
  return `${F4_EXECUTION_SNAPSHOT_FINGERPRINT_PREFIX}${createHash("sha256").update(canonicalJson(parsed)).digest("hex")}`;
}

export function validateF4ExecutionSnapshot(input: unknown): F4ExecutionSnapshot {
  const parsed = f4ExecutionSnapshotSchema.parse(input);
  const expected = f4ExecutionSnapshotFingerprint(parsed);
  if (parsed.snapshotFingerprint !== expected) throw new Error("F4 execution snapshot fingerprint mismatch");
  return parsed;
}
