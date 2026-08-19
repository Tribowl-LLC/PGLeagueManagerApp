import { createHash } from "node:crypto";
import { z } from "zod";

/** F3 wire contracts. These prefixes are intentionally distinct from every
 * v1 setup/schedule and F2 interactive quote fingerprint. */
export const F3_POLICY_CONTRACT = "canonical-collection-policy/1" as const;
export const F3_AUTHORIZATION_CONTRACT = "payer-autopay-authorization/1" as const;
export const F3_PLAN_CONTRACT = "canonical-autopay-plan/1" as const;
export const F3_PREAUTHORIZATION_QUOTE_CONTRACT = "canonical-autopay-preauthorization-quote/1" as const;
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

export const f3QuoteItemSchema = z.object({
  obligationId: z.string().uuid(), occurrenceId: z.string().uuid(), bowlerId: z.number().int().positive(),
  collectionPointOccurrenceId: z.string().uuid(), amountMinor: z.number().int().positive(), itemIndex: z.number().int().nonnegative(),
}).strict();
export const f3QuoteGroupSchema = z.object({
  occurrenceId: z.string().uuid(), groupKey: z.string().min(1), groupRole: z.enum(["normal", "trigger", "paired"]), pairedOccurrenceId: z.string().uuid().nullable(), collectionPointOccurrenceId: z.string().uuid(), localDate: z.string().nullable().optional(), localStartTime: z.string().nullable().optional(), timezone: z.string().nullable().optional(), ordinal: z.number().int().nullable().optional(),
}).strict();
export const f3PayeeDisplaySchema = z.object({ bowlerId: z.number().int().positive(), name: z.string().trim().min(1).max(200) }).strict();

export const f3AuthorizationInputSchema = z.object({
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  payerBowlerId: z.number().int().positive(),
  authorizationVersion: z.number().int().positive().optional(),
  policyId: z.string().uuid(),
  policyVersion: z.number().int().positive(),
  coveredBowlerIds: z.array(z.number().int().positive()).min(1),
  acceptedPartnerIds: z.array(z.number().int().positive()),
  paymentMethodFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  locationId: z.number().int().positive(),
  collectionPointOccurrenceIds: z.array(z.string().uuid()).min(1),
  timing: z.enum(["at_collection_point"]),
  /** The payer signs this server-derived quote; amounts and IDs are never
   * accepted as authoritative input. */
  preauthorizationFingerprint: z.string().regex(/^lvf3quote:v1:[0-9a-f]{64}$/),
  authorizedItems: z.array(f3QuoteItemSchema).min(1),
}).strict();

export const f3PreauthorizationQuoteSchema = z.object({
  contractVersion: z.literal(F3_PREAUTHORIZATION_QUOTE_CONTRACT), organizationId: z.number().int().positive(), leagueId: z.number().int().positive(),
  policy: z.object({ id: z.string().uuid(), version: z.number().int().positive(), activationRevision: z.number().int().positive(), activationSourceFingerprint: z.string().regex(/^lvfinancialsource:v1:[0-9a-f]{64}$/) }).strict(),
  authorization: z.object({ payerBowlerId: z.number().int().positive(), nextAuthorizationVersion: z.number().int().positive(), coveredBowlerIds: z.array(z.number().int().positive()).min(1), acceptedPartnerIds: z.array(z.number().int().positive()), collectionPointOccurrenceIds: z.array(z.string().uuid()).min(1), payees: z.array(f3PayeeDisplaySchema).min(1) }).strict(),
  items: z.array(f3QuoteItemSchema).min(1), groups: z.array(f3QuoteGroupSchema).min(1), timing: z.literal("at_collection_point"), totalAmountMinor: z.number().int().nonnegative(), catchUpRequired: z.boolean(), fingerprint: z.string().regex(/^lvf3quote:v1:[0-9a-f]{64}$/),
}).strict();

export type F3PolicyOccurrence = z.infer<typeof f3PolicyOccurrenceSchema>;
export type F3PolicyInput = z.infer<typeof f3PolicyInputSchema>;
export type F3AuthorizationInput = z.infer<typeof f3AuthorizationInputSchema>;
export type F3QuoteItem = z.infer<typeof f3QuoteItemSchema>;
export type F3QuoteGroup = z.infer<typeof f3QuoteGroupSchema>;
export type F3PayeeDisplay = z.infer<typeof f3PayeeDisplaySchema>;
export type F3PreauthorizationQuote = z.infer<typeof f3PreauthorizationQuoteSchema>;

/** Immutable post-authorization evidence. This is deliberately distinct from
 * the preauthorization quote: once ready, the client must render persisted D2
 * items and must not derive a new quote from live obligations. */
export const f3ReadyPlanSchema = z.object({
  contractVersion: z.literal(F3_PLAN_CONTRACT),
  policy: z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  authorization: z.object({ id: z.string().uuid(), version: z.number().int().positive(), coveredBowlerIds: z.array(z.number().int().positive()).min(1), collectionPointOccurrenceIds: z.array(z.string().uuid()).min(1), payees: z.array(f3PayeeDisplaySchema).min(1) }).strict(),
  items: z.array(f3QuoteItemSchema).min(1),
  groups: z.array(f3QuoteGroupSchema).min(1),
  totalAmountMinor: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^lvf3plan:v1:[0-9a-f]{64}$/),
  aggregateFingerprint: z.string().regex(/^lvf3plan:v1:[0-9a-f]{64}$/),
}).strict();
export type F3ReadyPlan = z.infer<typeof f3ReadyPlanSchema>;

/** One deterministic ordering for prequote, persistence, fingerprints, and reads. */
export function orderF3QuoteItems(items: readonly F3QuoteItem[], collectionPointOrder: readonly string[] = []): F3QuoteItem[] {
  const rank = new Map(collectionPointOrder.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.collectionPointOccurrenceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.collectionPointOccurrenceId) ?? Number.MAX_SAFE_INTEGER) || a.itemIndex - b.itemIndex || a.occurrenceId.localeCompare(b.occurrenceId) || a.bowlerId - b.bowlerId || a.obligationId.localeCompare(b.obligationId));
}

/** Canonical ordered rows are always re-indexed after sorting. This is the
 * only ordering/indexing operation used by quote, persistence, and reads. */
export function canonicalizeF3QuoteItems(items: readonly F3QuoteItem[], collectionPointOrder: readonly string[] = []): F3QuoteItem[] {
  return orderF3QuoteItems(items, collectionPointOrder).map((item, itemIndex) => ({ ...item, itemIndex }));
}

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
    if (paired.length === 2) {
      const trigger = rows.find((row) => row.groupRole === "trigger");
      const pair = rows.find((row) => row.groupRole === "paired");
      if (!trigger || !pair || trigger.pairedOccurrenceId !== pair.occurrenceId || pair.pairedOccurrenceId !== trigger.occurrenceId) throw new Error("F3_POLICY_PAIR_MISMATCH");
      if (trigger.collectionPoint.occurrenceId !== trigger.occurrenceId || pair.collectionPoint.occurrenceId !== trigger.occurrenceId) throw new Error("F3_POLICY_DOUBLE_PAY_POINT");
    } else if (rows[0]?.collectionPoint.occurrenceId !== rows[0]?.occurrenceId) {
      throw new Error("F3_POLICY_NORMAL_POINT");
    }
  }
  for (const row of policy.occurrences) {
    if (!occurrenceIds.has(row.collectionPoint.occurrenceId)) throw new Error("F3_POLICY_COLLECTION_POINT_UNKNOWN");
    const pairedId = row.pairedOccurrenceId;
    if (row.groupRole !== "normal" && (!pairedId || !occurrenceIds.has(pairedId))) throw new Error("F3_POLICY_PAIR_UNKNOWN");
  }
  const pointIds = new Set(policy.collectionPoints.map((p) => p.occurrenceId));
  const derivedPointIds = new Set(policy.occurrences.filter((row) => row.groupRole === "trigger" || row.groupRole === "normal").map((row) => row.collectionPoint.occurrenceId));
  if (pointIds.size !== policy.collectionPoints.length || [...pointIds].some((id) => !occurrenceIds.has(id)) || pointIds.size !== derivedPointIds.size || [...derivedPointIds].some((id) => !pointIds.has(id))) throw new Error("F3_POLICY_COLLECTION_POINTS_INVALID");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
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
    authorizedItems: input.authorizedItems ? canonicalizeF3QuoteItems(input.authorizedItems, input.collectionPointOccurrenceIds) : undefined,
  };
  return fingerprint(F3_AUTHORIZATION_FINGERPRINT_PREFIX, normalized);
}

export type F3PreauthorizationSemanticInput = { organizationId: number; leagueId: number; payerBowlerId: number; policyId: string; policyVersion: number; activationRevision: number; activationSourceFingerprint: string; coveredBowlerIds: number[]; acceptedPartnerIds: number[]; collectionPointOccurrenceIds: string[]; items: F3QuoteItem[]; timing: "at_collection_point"; totalAmountMinor: number; nextAuthorizationVersion: number; paymentMethodFingerprint?: string; locationId?: number };
export function f3PreauthorizationFingerprint(input: F3PreauthorizationSemanticInput): string {
  const normalized = {
    contractVersion: F3_PREAUTHORIZATION_QUOTE_CONTRACT,
    ...input,
    coveredBowlerIds: [...input.coveredBowlerIds].sort((a, b) => a - b),
    acceptedPartnerIds: [...input.acceptedPartnerIds].sort((a, b) => a - b),
    collectionPointOccurrenceIds: [...input.collectionPointOccurrenceIds].sort(),
    items: canonicalizeF3QuoteItems(input.items, input.collectionPointOccurrenceIds),
  };
  return fingerprint("lvf3quote:v1:", normalized);
}

export function f3PlanFingerprint(value: unknown): string {
  return fingerprint(F3_PLAN_FINGERPRINT_PREFIX, value);
}

export type F3SemanticPlan = { organizationId: number; leagueId: number; payerBowlerId: number; policyId: string; policyVersion: number; authorizationId: string; authorizationVersion: number; collectionPointOccurrenceId: string; planVersion: number; items: F3QuoteItem[] };
export function f3SemanticPlanFingerprint(input: F3SemanticPlan): string {
  return f3PlanFingerprint({ ...input, items: canonicalizeF3QuoteItems(input.items, [input.collectionPointOccurrenceId]) });
}
export function f3AggregatePlanFingerprint(input: { authorizationId: string; authorizationVersion: number; policyId: string; policyVersion: number; collectionPointOrder: string[]; plans: Array<F3SemanticPlan & { planFingerprint: string }> }): string {
  const rank = new Map(input.collectionPointOrder.map((id, index) => [id, index]));
  const plans = [...input.plans].sort((a, b) => (rank.get(a.collectionPointOccurrenceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.collectionPointOccurrenceId) ?? Number.MAX_SAFE_INTEGER) || a.collectionPointOccurrenceId.localeCompare(b.collectionPointOccurrenceId));
  return f3PlanFingerprint({ authorizationId: input.authorizationId, authorizationVersion: input.authorizationVersion, policyId: input.policyId, policyVersion: input.policyVersion, plans: plans.map((plan) => ({ ...plan, items: canonicalizeF3QuoteItems(plan.items, [plan.collectionPointOccurrenceId]) })) });
}
