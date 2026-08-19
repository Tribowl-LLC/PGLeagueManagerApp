import { describe, expect, it } from "vitest";
import { canonicalizeF3QuoteItems, f3AggregatePlanFingerprint, f3AuthorizationFingerprint, f3PolicyFingerprint, f3PreauthorizationFingerprint, f3PreauthorizationQuoteSchema, f3SemanticPlanFingerprint, validateF3PolicyShape } from "@shared/f3-autopay-contract";

const occurrenceA = "00000000-0000-4000-8000-000000000001";
const occurrenceB = "00000000-0000-4000-8000-000000000002";
const activationId = "00000000-0000-4000-8000-000000000003";
const policyId = "00000000-0000-4000-8000-000000000004";
const quoteItem = { obligationId: "00000000-0000-4000-8000-000000000006", occurrenceId: occurrenceA, bowlerId: 10, collectionPointOccurrenceId: occurrenceA, amountMinor: 650, itemIndex: 0 };

function policy() {
  return {
    organizationId: 1, leagueId: 2, activationId, activationRevision: 1,
    activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`,
    policyVersion: 1, collectionPoints: [{ occurrenceId: occurrenceA }],
    occurrences: [{ occurrenceId: occurrenceA, groupKey: "normal", groupRole: "normal" as const, pairedOccurrenceId: null, collectionPoint: { occurrenceId: occurrenceA } }],
  };
}

describe("F3 canonical contracts", () => {
  it("fingerprints normalized policy order and rejects date-only pairing", () => {
    const value = policy();
    validateF3PolicyShape(value);
    expect(f3PolicyFingerprint(value)).toMatch(/^lvf3policy:v1:[0-9a-f]{64}$/);
    expect(() => validateF3PolicyShape({ ...value, occurrences: [{ ...value.occurrences[0], groupRole: "trigger", pairedOccurrenceId: occurrenceB }] })).toThrow();
  });

  it("requires reciprocal explicit double-pay pairing", () => {
    const value = policy();
    const pair = [
      { occurrenceId: occurrenceA, groupKey: "double", groupRole: "trigger" as const, pairedOccurrenceId: occurrenceB, collectionPoint: { occurrenceId: occurrenceA } },
      { occurrenceId: occurrenceB, groupKey: "double", groupRole: "paired" as const, pairedOccurrenceId: occurrenceA, collectionPoint: { occurrenceId: occurrenceA } },
    ];
    expect(() => validateF3PolicyShape({ ...value, collectionPoints: [{ occurrenceId: occurrenceA }], occurrences: pair })).not.toThrow();
    expect(() => validateF3PolicyShape({ ...value, collectionPoints: [{ occurrenceId: occurrenceA }], occurrences: [{ ...pair[0], pairedOccurrenceId: occurrenceA }, pair[1]] })).toThrow(/PAIR_REQUIRED|PAIR_MISMATCH/);
  });

  it("requires normal groups to point at themselves and declared points to be exact", () => {
    const value = policy();
    expect(() => validateF3PolicyShape({ ...value, collectionPoints: [{ occurrenceId: occurrenceB }] })).toThrow("COLLECTION_POINTS_INVALID");
    expect(() => validateF3PolicyShape({ ...value, occurrences: [{ ...value.occurrences[0], collectionPoint: { occurrenceId: occurrenceB } }] })).toThrow("NORMAL_POINT");
  });

  it("binds exact ordered obligations and amounts into preauthorization evidence", () => {
    const item = { obligationId: "00000000-0000-4000-8000-000000000006", occurrenceId: occurrenceA, bowlerId: 10, collectionPointOccurrenceId: occurrenceA, amountMinor: 650, itemIndex: 0 };
    const base = { organizationId: 1, leagueId: 2, payerBowlerId: 10, policyId, policyVersion: 1, activationRevision: 1, activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`, coveredBowlerIds: [10], acceptedPartnerIds: [], collectionPointOccurrenceIds: [occurrenceA], items: [item], timing: "at_collection_point" as const, totalAmountMinor: 650, nextAuthorizationVersion: 1 };
    const quote = f3PreauthorizationFingerprint(base);
    expect(quote).toMatch(/^lvf3quote:v1:[0-9a-f]{64}$/);
    expect(f3PreauthorizationFingerprint({ ...base, items: [{ ...item, amountMinor: 651 }] })).not.toBe(quote);
    expect(f3AuthorizationFingerprint({ organizationId: 1, leagueId: 2, payerBowlerId: 10, authorizationVersion: 1, policyId, policyVersion: 1, coveredBowlerIds: [10], acceptedPartnerIds: [], paymentMethodFingerprint: "b".repeat(64), locationId: 4, collectionPointOccurrenceIds: [occurrenceA], timing: "at_collection_point", preauthorizationFingerprint: quote, authorizedItems: [item] })).toMatch(/^lvf3auth:v1:/);
  });

  it("requires the complete server-derived preauthorization wire contract", () => {
    const valid = {
      contractVersion: "canonical-autopay-preauthorization-quote/1" as const,
      organizationId: 1, leagueId: 2,
      policy: { id: policyId, version: 1, activationRevision: 1, activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}` },
      authorization: { payerBowlerId: 10, nextAuthorizationVersion: 1, coveredBowlerIds: [10], acceptedPartnerIds: [], collectionPointOccurrenceIds: [occurrenceA], payees: [{ bowlerId: 10, name: "Payer" }] },
      items: [quoteItem], groups: [{ occurrenceId: occurrenceA, groupKey: "normal", groupRole: "normal" as const, pairedOccurrenceId: null, collectionPointOccurrenceId: occurrenceA }], timing: "at_collection_point" as const, totalAmountMinor: 650, catchUpRequired: false, fingerprint: `lvf3quote:v1:${"c".repeat(64)}`,
    };
    expect(f3PreauthorizationQuoteSchema.parse(valid).authorization.nextAuthorizationVersion).toBe(1);
    expect(() => f3PreauthorizationQuoteSchema.parse({ ...valid, fingerprint: undefined })).toThrow();
    expect(f3PreauthorizationFingerprint({ organizationId: 1, leagueId: 2, payerBowlerId: 10, policyId, policyVersion: 1, activationRevision: 1, activationSourceFingerprint: valid.policy.activationSourceFingerprint, coveredBowlerIds: [10], acceptedPartnerIds: [], collectionPointOccurrenceIds: [occurrenceA], items: [quoteItem], timing: "at_collection_point", totalAmountMinor: 650, nextAuthorizationVersion: 2 })).not.toBe(f3PreauthorizationFingerprint({ organizationId: 1, leagueId: 2, payerBowlerId: 10, policyId, policyVersion: 1, activationRevision: 1, activationSourceFingerprint: valid.policy.activationSourceFingerprint, coveredBowlerIds: [10], acceptedPartnerIds: [], collectionPointOccurrenceIds: [occurrenceA], items: [quoteItem], timing: "at_collection_point", totalAmountMinor: 650, nextAuthorizationVersion: 1 }));
  });

  it("keeps partner, collection point, and policy revisions fingerprinted", () => {
    const item = { obligationId: "00000000-0000-4000-8000-000000000006", occurrenceId: occurrenceA, bowlerId: 10, collectionPointOccurrenceId: occurrenceA, amountMinor: 100, itemIndex: 0 };
    const input = { organizationId: 1, leagueId: 2, payerBowlerId: 10, authorizationVersion: 1, policyId, policyVersion: 1, coveredBowlerIds: [10], acceptedPartnerIds: [], paymentMethodFingerprint: "b".repeat(64), locationId: 4, collectionPointOccurrenceIds: [occurrenceA], timing: "at_collection_point" as const, preauthorizationFingerprint: `lvf3quote:v1:${"c".repeat(64)}`, authorizedItems: [item] };
    expect(f3AuthorizationFingerprint({ ...input, acceptedPartnerIds: [11] })).not.toBe(f3AuthorizationFingerprint(input));
    expect(f3AuthorizationFingerprint({ ...input, authorizedItems: [{ ...item, occurrenceId: occurrenceB }] })).not.toBe(f3AuthorizationFingerprint(input));
    expect(() => f3AuthorizationFingerprint({ ...input, sourceId: "provider-card", customerId: "provider-customer", actorUserId: 99, commandKey: "client-command" } as never)).toThrow();
  });

  it("canonically indexes interleaved double-pay rows and aggregates complete plans", () => {
    const items = [
      { ...quoteItem, occurrenceId: occurrenceB, collectionPointOccurrenceId: occurrenceA, itemIndex: 4 },
      { ...quoteItem, occurrenceId: occurrenceA, collectionPointOccurrenceId: occurrenceA, itemIndex: 3 },
    ];
    const ordered = canonicalizeF3QuoteItems(items, [occurrenceA]);
    expect(ordered.map((row) => [row.occurrenceId, row.itemIndex])).toEqual([[occurrenceA, 0], [occurrenceB, 1]]);
    const plan = { organizationId: 1, leagueId: 2, payerBowlerId: 10, policyId, policyVersion: 1, authorizationId: "00000000-0000-4000-8000-000000000005", authorizationVersion: 1, collectionPointOccurrenceId: occurrenceA, planVersion: 1, items };
    const perPlan = f3SemanticPlanFingerprint(plan);
    const aggregate = f3AggregatePlanFingerprint({ authorizationId: plan.authorizationId, authorizationVersion: 1, policyId, policyVersion: 1, collectionPointOrder: [occurrenceA], plans: [{ ...plan, planFingerprint: perPlan }] });
    expect(perPlan).toMatch(/^lvf3plan:v1:/);
    expect(aggregate).toMatch(/^lvf3plan:v1:/);
    expect(f3AggregatePlanFingerprint({ authorizationId: plan.authorizationId, authorizationVersion: 1, policyId, policyVersion: 1, collectionPointOrder: [occurrenceA], plans: [{ ...plan, items: [...items].reverse(), planFingerprint: perPlan }] })).toBe(aggregate);
  });

});
