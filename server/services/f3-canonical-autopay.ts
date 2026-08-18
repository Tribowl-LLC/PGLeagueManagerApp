import { F3_PLAN_CONTRACT, f3PlanFingerprint, f3PolicyFingerprint, validateF3PolicyShape, type F3PolicyInput } from "@shared/f3-autopay-contract";

export type F3ObligationEvidence = {
  obligationId: string;
  occurrenceId: string;
  bowlerId: number;
  amountMinor: number;
  allocatedMinor: number;
  reservedMinor: number;
  currency: string;
  state: "open" | "partially_settled" | "settled" | "voided";
  reviewRequired: boolean;
  dueAt?: string | null;
};

export type F3ReadyPlanItem = {
  obligationId: string;
  occurrenceId: string;
  bowlerId: number;
  collectionPointOccurrenceId: string;
  amountMinor: number;
  itemIndex: number;
};

export type F3ReadyPlanInput = {
  organizationId: number;
  leagueId: number;
  paymentMode: "weekly" | "upfront";
  f3Enabled: boolean;
  activation: { id: string; revision: number; sourceFingerprint: string; complete: boolean } | null;
  policy: { id: string; version: number; state: "draft" | "approved" | "superseded"; activationId: string; activationRevision: number; activationSourceFingerprint: string; collectionPoints: string[]; occurrenceCollectionPoints: Array<{ occurrenceId: string; collectionPointOccurrenceId: string }> } | null;
  authorization: { id: string; version: number; state: "draft" | "authorized" | "revoked" | "superseded"; payerBowlerId: number; policyId: string; policyVersion: number; coveredBowlerIds: number[]; collectionPointOccurrenceIds: string[] } | null;
  acceptedPartnerIds?: number[];
  payerOwnedPaymentMethod?: boolean;
  paymentMethodLocationId?: number;
  leagueLocationId?: number | null;
  obligations: F3ObligationEvidence[];
};

export class F3ReadinessError extends Error {
  constructor(public readonly code: string, message = "Canonical auto-pay plan is unavailable") {
    super(message);
    this.name = "F3ReadinessError";
  }
}

function fail(code: string): never { throw new F3ReadinessError(code); }

/** Derives exact ready items from server-owned obligations. Client amounts and
 * UUID combinations are not accepted here. This is intentionally provider
 * free and can be reused by quote/readiness routes and race-safe transactions. */
export function deriveF3ReadyPlan(input: F3ReadyPlanInput): { contractVersion: typeof F3_PLAN_CONTRACT; items: F3ReadyPlanItem[]; totalAmountMinor: number; fingerprint: string } {
  if (!input.f3Enabled) fail("F3_DISABLED");
  if (input.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED");
  const activation = input.activation;
  if (!activation?.complete) fail("F1_ACTIVATION_REQUIRED");
  const policy = input.policy;
  if (!policy || policy.state !== "approved") fail("POLICY_NOT_APPROVED");
  if (policy.activationId !== activation.id || policy.activationRevision !== activation.revision || policy.activationSourceFingerprint !== activation.sourceFingerprint) fail("POLICY_ACTIVATION_DRIFT");
  const auth = input.authorization;
  if (!auth || auth.state !== "authorized") fail("PAYER_AUTHORIZATION_REQUIRED");
  if (auth.policyId !== policy.id || auth.policyVersion !== policy.version) fail("AUTHORIZATION_POLICY_DRIFT");
  if (!auth.coveredBowlerIds.includes(auth.payerBowlerId) || new Set(auth.coveredBowlerIds).size !== auth.coveredBowlerIds.length) fail("COVERAGE_INVALID");
  if (input.payerOwnedPaymentMethod === false) fail("PAYMENT_METHOD_NOT_OWNED");
  if (input.paymentMethodLocationId !== undefined && input.paymentMethodLocationId !== input.leagueLocationId) fail("PAYMENT_LOCATION_MISMATCH");
  const acceptedPartners = new Set(input.acceptedPartnerIds ?? []);
  if (auth.coveredBowlerIds.some((id) => id !== auth.payerBowlerId && !acceptedPartners.has(id))) fail("PARTNER_NOT_ACCEPTED");
  const collectionPoints = new Set(policy.collectionPoints);
  const authorizedPoints = new Set(auth.collectionPointOccurrenceIds);
  if (collectionPoints.size !== authorizedPoints.size || [...collectionPoints].some((id) => !authorizedPoints.has(id))) fail("COLLECTION_POINT_MISMATCH");
  const items: F3ReadyPlanItem[] = [];
  const obligationByKey = new Map<string, F3ObligationEvidence>();
  for (const obligation of input.obligations) {
    const key = `${obligation.occurrenceId}:${obligation.bowlerId}`;
    if (obligationByKey.has(key)) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    obligationByKey.set(key, obligation);
  }
  for (const mapping of policy.occurrenceCollectionPoints) for (const bowlerId of auth.coveredBowlerIds) {
    const obligation = obligationByKey.get(`${mapping.occurrenceId}:${bowlerId}`);
    if (!obligation || obligation.currency !== "USD" || obligation.reviewRequired || obligation.state === "settled" || obligation.state === "voided") fail("OBLIGATION_UNAVAILABLE");
    if (obligation.dueAt && new Date(obligation.dueAt).getTime() <= Date.now()) fail("IMMEDIATE_CATCHUP_REQUIRED");
    const remaining = obligation.amountMinor - obligation.allocatedMinor - obligation.reservedMinor;
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail("OBLIGATION_ALREADY_RESERVED");
    items.push({ obligationId: obligation.obligationId, occurrenceId: obligation.occurrenceId, bowlerId, collectionPointOccurrenceId: mapping.collectionPointOccurrenceId, amountMinor: remaining, itemIndex: items.length });
  }
  if (items.length === 0) fail("NO_COLLECTABLE_OBLIGATIONS");
  const total = items.reduce((sum, row) => sum + row.amountMinor, 0);
  if (!Number.isSafeInteger(total) || total <= 0) fail("AMOUNT_INVALID");
  return { contractVersion: F3_PLAN_CONTRACT, items, totalAmountMinor: total, fingerprint: f3PlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, activationId: activation.id, activationRevision: activation.revision, policyId: policy.id, policyVersion: policy.version, authorizationId: auth.id, authorizationVersion: auth.version, collectionPoints: [...collectionPoints].sort(), items }) };
}

export function canonicalF3PolicyFingerprint(policy: F3PolicyInput): string {
  validateF3PolicyShape(policy);
  return f3PolicyFingerprint(policy);
}
