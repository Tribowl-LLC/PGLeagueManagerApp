import { createHash } from "node:crypto";
import { z } from "zod";

/** F3 wire contracts. These prefixes are intentionally distinct from every
 * v1 setup/schedule and F2 interactive quote fingerprint. */
export const F3_POLICY_CONTRACT = "canonical-collection-policy/1" as const;
export const F3_AUTHORIZATION_CONTRACT = "payer-autopay-authorization/1" as const;
export const F3_PLAN_CONTRACT = "canonical-autopay-plan/1" as const;
export const F3_POLICY_FINGERPRINT_PREFIX = "lvf3policy:v1:" as const;
export const F3_AUTHORIZATION_FINGERPRINT_PREFIX = "lvf3auth:v1:" as const;
export const F3_PLAN_FINGERPRINT_PREFIX = "lvf3plan:v1:" as const;

export const f3CollectionPointSchema = z.object({
  occurrenceId: z.string().uuid(),
}).strict();

export const f3PolicyOccurrenceSchema = z.object({
  occurrenceId: z.string().uuid(),
  groupKey: z.string().min(1).max(128),
  groupRole: z.enum(["normal", "trigger", "paired"]),
  pairedOccurrenceId: z.string().uuid().nullable(),
  collectionPoint: f3CollectionPointSchema,
}).strict();

export const f3PolicyInputSchema = z.object({
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  activationId: z.string().uuid(),
  activationRevision: z.number().int().positive(),
  activationSourceFingerprint: z.string().regex(/^lvfinancialsource:v1:[0-9a-f]{64}$/),
  policyVersion: z.number().int().positive(),
  collectionPoints: z.array(f3CollectionPointSchema).min(1),
  occurrences: z.array(f3PolicyOccurrenceSchema).min(1),
}).strict();

export const f3AuthorizationInputSchema = z.object({
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  payerBowlerId: z.number().int().positive(),
  authorizationVersion: z.number().int().positive(),
  policyId: z.string().uuid(),
  policyVersion: z.number().int().positive(),
  coveredBowlerIds: z.array(z.number().int().positive()).min(1),
  acceptedPartnerIds: z.array(z.number().int().positive()),
  paymentMethodFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  locationId: z.number().int().positive(),
  collectionPointOccurrenceIds: z.array(z.string().uuid()).min(1),
  timing: z.enum(["at_collection_point"]),
}).strict();

export type F3PolicyOccurrence = z.infer<typeof f3PolicyOccurrenceSchema>;
export type F3PolicyInput = z.infer<typeof f3PolicyInputSchema>;
export type F3AuthorizationInput = z.infer<typeof f3AuthorizationInputSchema>;

export function normalizeF3Policy(input: F3PolicyInput): F3PolicyInput {
  const parsed = f3PolicyInputSchema.parse(input);
  const occurrences = [...parsed.occurrences]
    .map((row) => ({ ...row, collectionPoint: { occurrenceId: row.collectionPoint.occurrenceId } }))
    .sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId) || a.groupKey.localeCompare(b.groupKey));
  const collectionPoints = [...parsed.collectionPoints]
    .sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
  return { ...parsed, collectionPoints, occurrences };
}

/** Enforces that a double-pay group is exactly two real, distinct occurrences
 * and names both the trigger and paired row. Dates/order are deliberately not
 * accepted as pairing evidence. */
export function validateF3PolicyShape(input: F3PolicyInput): void {
  const policy = normalizeF3Policy(input);
  const occurrenceIds = new Set<string>();
  for (const row of policy.occurrences) {
    if (occurrenceIds.has(row.occurrenceId)) throw new Error("F3_POLICY_DUPLICATE_OCCURRENCE");
    occurrenceIds.add(row.occurrenceId);
    if (row.collectionPoint.occurrenceId !== row.occurrenceId && !occurrenceIds.has(row.collectionPoint.occurrenceId)) {
      // collection points may be an occurrence not yet visited in sorted input;
      // existence is checked after the complete set below.
    }
    if (row.groupRole === "normal" && row.pairedOccurrenceId !== null) throw new Error("F3_POLICY_NORMAL_PAIR");
    if (row.groupRole !== "normal" && (!row.pairedOccurrenceId || row.pairedOccurrenceId === row.occurrenceId)) {
      throw new Error("F3_POLICY_PAIR_REQUIRED");
    }
  }
  const groups = new Map<string, F3PolicyOccurrence[]>();
  for (const row of policy.occurrences) groups.set(row.groupKey, [...(groups.get(row.groupKey) ?? []), row]);
  for (const rows of groups.values()) {
    const paired = rows.filter((row) => row.groupRole !== "normal");
    if (paired.length === 0 && rows.length !== 1) throw new Error("F3_POLICY_GROUP_SIZE");
    if (paired.length > 0 && (rows.length !== 2 || paired.length !== 2 || new Set(rows.map((row) => row.occurrenceId)).size !== 2)) {
      throw new Error("F3_POLICY_DOUBLE_PAY_GROUP");
    }
    if (paired.length === 2 && new Set(rows.map((row) => row.pairedOccurrenceId)).size !== 2) throw new Error("F3_POLICY_PAIR_MISMATCH");
  }
  for (const row of policy.occurrences) {
    if (!occurrenceIds.has(row.collectionPoint.occurrenceId)) throw new Error("F3_POLICY_COLLECTION_POINT_UNKNOWN");
    const pairedId = row.pairedOccurrenceId;
    if (row.groupRole !== "normal" && (!pairedId || !occurrenceIds.has(pairedId))) throw new Error("F3_POLICY_PAIR_UNKNOWN");
  }
  const pointIds = new Set(policy.collectionPoints.map((p) => p.occurrenceId));
  if (pointIds.size !== policy.collectionPoints.length || [...pointIds].some((id) => !occurrenceIds.has(id))) throw new Error("F3_POLICY_COLLECTION_POINTS_INVALID");
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function f3PolicyFingerprint(input: F3PolicyInput): string {
  const normalized = normalizeF3Policy(input);
  validateF3PolicyShape(normalized);
  return fingerprint(F3_POLICY_FINGERPRINT_PREFIX, normalized);
}

export function f3AuthorizationFingerprint(input: F3AuthorizationInput): string {
  const normalized = {
    ...f3AuthorizationInputSchema.parse(input),
    coveredBowlerIds: [...input.coveredBowlerIds].sort((a, b) => a - b),
    acceptedPartnerIds: [...input.acceptedPartnerIds].sort((a, b) => a - b),
    collectionPointOccurrenceIds: [...input.collectionPointOccurrenceIds].sort(),
  };
  return fingerprint(F3_AUTHORIZATION_FINGERPRINT_PREFIX, normalized);
}

export function f3PlanFingerprint(value: unknown): string {
  return fingerprint(F3_PLAN_FINGERPRINT_PREFIX, value);
}

export function isCanonicalF3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED === "1" || env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED === "true";
}
