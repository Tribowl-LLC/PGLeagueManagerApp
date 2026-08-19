import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { bowlerLeagues, bowlers, bowlerPaymentLinks, leagueOccurrenceBillingTerms, leagueOccurrenceBillingTermRevisions, leagueOccurrenceGenerationRuns, leagueOccurrenceRevisions, leagueOccurrences, leagueScheduleCommands, leagues, locations, organizations, teams, users, bowlerOccurrenceObligations, bowlerOccurrenceObligationRevisions, f3CollectionPolicies, f3CollectionPolicyOccurrences, f3CollectionPolicyRevisions, f3PayerAuthorizations, f3PayerAuthorizationRevisions, f3AutopayPlanProvenance, occurrenceCollectionPlans, occurrenceCollectionPlanItems, payments, paymentOccurrenceAllocations, paymentOccurrenceAllocationRevisions, paymentOperations, paymentOperationOccurrenceSnapshots, paymentOperationOccurrenceSnapshotAllocations, interactivePaymentOperationSnapshots } from "@shared/schema";
import { getCanonicalActivationSource, activateCanonicalFinancials } from "../../server/services/canonical-due-past-due";
import { canonicalizeF3QuoteItems, f3PreauthorizationFingerprint } from "@shared/f3-autopay-contract";

const db = getTestDb();
vi.hoisted(() => { process.env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED = "1"; });

async function makeFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [organization] = await db.insert(organizations).values({ name: `F3 workflow ${suffix}`, slug: `f3-workflow-${suffix}` }).returning({ id: organizations.id });
  const [actor] = await db.insert(users).values({ email: `f3-workflow-${suffix}@example.test`, password: "test", name: "F3 workflow admin", role: "org_admin", organizationId: organization.id }).returning({ id: users.id });
  const [location] = await db.insert(locations).values({ name: "F3 lanes", organizationId: organization.id }).returning({ id: locations.id });
  const [league] = await db.insert(leagues).values({ name: `F3 league ${suffix}`, organizationId: organization.id, locationId: location.id, seasonStart: "2038-01-01", seasonEnd: "2038-12-31", weekDay: "Sunday", competitionStartTime: "19:00", timezone: "UTC", totalBowlingWeeks: 2, weeklyFee: 500, paymentMode: "weekly" }).returning({ id: leagues.id });
  const [team] = await db.insert(teams).values({ name: `F3 team ${suffix}`, number: 1, leagueId: league.id }).returning({ id: teams.id });
  const roster = await db.insert(bowlers).values([0, 1, 2].map((index) => ({ name: `F3 bowler ${index} ${suffix}`, organizationId: organization.id, active: true, paymentCustomerId: `customer-${index}`, paymentProviderLocationId: location.id }))).returning({ id: bowlers.id });
  await db.insert(bowlerLeagues).values(roster.map((bowler) => ({ bowlerId: bowler.id, leagueId: league.id, teamId: team.id, active: true })));
  await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(roster[0].id, roster[1].id), bowlerBId: Math.max(roster[0].id, roster[1].id), organizationId: organization.id, status: "accepted", createdByUserId: actor.id, respondedAt: "2037-12-01T00:00:00.000Z" });
  const [command] = await db.insert(leagueScheduleCommands).values({ organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, commandType: "publish", reason: "F3 workflow fixture", idempotencyKey: `f3-publish-${suffix}`, requestFingerprint: `lvf3publish:${suffix}` }).returning({ id: leagueScheduleCommands.id });
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({ organizationId: organization.id, leagueId: league.id, originatingCommandId: command.id, generatorVersion: "f3-fixture/1", inputFingerprint: `lvf3run:${suffix}`, sourceScheduleRevision: 1, normalizedInputSnapshot: { fixture: "f3" }, rangeStartDate: "2038-01-01", rangeEndDate: "2038-12-31", candidateOccurrenceCount: 2, generatedOccurrenceCount: 2, state: "applied", approvedAt: "2037-12-01T00:00:00.000Z", approvedByUserId: actor.id, approvalCommandId: command.id }).returning({ id: leagueOccurrenceGenerationRuns.id });
  const occurrenceIds: string[] = [];
  for (const index of [0, 1]) {
    const date = `2038-02-0${index + 1}`;
    const [occurrence] = await db.insert(leagueOccurrences).values({ organizationId: organization.id, leagueId: league.id, locationId: location.id, generationKey: `f3-occurrence-${suffix}-${index}`, generationRunId: run.id, kind: "regular", status: "scheduled", lifecycle: "published", authoritativeLocalDate: date, authoritativeLocalStartTime: "19:00:00", timezone: "UTC", startAt: `${date}T19:00:00.000Z`, selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous", resolverVersion: "f3-fixture/1", plannedOrdinal: index + 1, competitionNumber: index + 1, competitive: true, countsInStandings: true, currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id }).returning({ id: leagueOccurrences.id });
    occurrenceIds.push(occurrence.id);
    const [term] = await db.insert(leagueOccurrenceBillingTerms).values({ organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, purpose: "league_weekly_fee", obligationPolicy: "eligible_bowlers", defaultAmountMinor: 500, currency: "USD", billingOrdinal: index + 1, version: 1, state: "published", currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id }).returning({ id: leagueOccurrenceBillingTerms.id });
    await db.insert(leagueOccurrenceBillingTermRevisions).values({ organizationId: organization.id, leagueId: league.id, billingTermId: term.id, commandId: command.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { id: term.id, organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, purpose: "league_weekly_fee", obligationPolicy: "eligible_bowlers", defaultAmountMinor: 500, currency: "USD", billingOrdinal: index + 1, version: 1, state: "published", currentRevision: 1, lastCommandId: command.id } });
    await db.insert(leagueOccurrenceRevisions).values({ organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, commandId: command.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { lifecycle: "published", status: "scheduled" } });
    void term;
  }
  const activationSource = await getCanonicalActivationSource({ organizationId: organization.id, leagueId: league.id });
  const responsibilities = occurrenceIds.flatMap((occurrenceId) => roster.map((bowler, slotIndex) => ({ occurrenceId, teamId: team.id, slotIndex, bowlerId: bowler.id, role: "regular" as const, provenance: "explicit_admin_selection" as const })));
  const activation = await activateCanonicalFinancials({ organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, commandKey: `f3-activation-${suffix}`, sourceFingerprint: activationSource.sourceFingerprint, payingLineupSize: 3, responsibilities });
  return { organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, locationId: location.id, roster, occurrenceIds, obligationIds: activation.obligationIds, activationId: activation.activationId, activationSourceFingerprint: activationSource.sourceFingerprint };
}

describe("F3 real PostgreSQL workflow", () => {
  it("pure quote evidence rejects extra responsibilities, lifecycle drift, over-allocation, and over-reservation", async () => {
    const { buildF3QuoteEvidence } = await import("../../server/services/f3-workflow");
    const occurrence = "00000000-0000-4000-8000-000000000001";
    const obligation = "00000000-0000-4000-8000-000000000002";
    const base = { policyRows: [{ occurrenceId: occurrence, collectionPointOccurrenceId: occurrence }], coveredBowlerIds: [7], responsibilities: [{ occurrenceId: occurrence, bowlerId: 7, obligationId: obligation, amountMinor: 1000, currency: "USD" }], obligations: [{ id: obligation, occurrenceId: occurrence, bowlerId: 7, amountMinor: 1000, currency: "USD", state: "open", dueAt: null }], allocations: [], reservations: [], transactionNow: Date.now(), allowDueItems: true };
    expect(buildF3QuoteEvidence(base).items[0]?.amountMinor).toBe(1000);
    await expect(Promise.resolve().then(() => buildF3QuoteEvidence({ ...base, responsibilities: [...base.responsibilities, { ...base.responsibilities[0], occurrenceId: "00000000-0000-4000-8000-000000000003" }] }))).rejects.toMatchObject({ code: "OBLIGATION_EVIDENCE_INCONSISTENT" });
    await expect(Promise.resolve().then(() => buildF3QuoteEvidence({ ...base, obligations: [{ ...base.obligations[0], state: "partially_settled" }] }))).rejects.toMatchObject({ code: "OBLIGATION_EVIDENCE_INCONSISTENT" });
    await expect(Promise.resolve().then(() => buildF3QuoteEvidence({ ...base, allocations: [{ obligationId: obligation, amountMinor: 1100, status: "paid" }] }))).rejects.toMatchObject({ code: "OBLIGATION_EVIDENCE_INCONSISTENT" });
    await expect(Promise.resolve().then(() => buildF3QuoteEvidence({ ...base, reservations: [{ obligationId: obligation, amountMinor: 1001 }] }))).rejects.toMatchObject({ code: "OBLIGATION_EVIDENCE_INCONSISTENT" });
    await expect(Promise.resolve().then(() => buildF3QuoteEvidence({ ...base, allocations: [{ obligationId: obligation, amountMinor: 100, status: "paid", disputeEvidence: true }] }))).rejects.toMatchObject({ code: "OBLIGATION_REVIEW_REQUIRED" });
  });

  it("creates/approves/authorizes/revokes exact double-pay evidence and rejects stale consent without writes", async () => {
    const fixture = await makeFixture();
    const workflow = await import("../../server/services/f3-workflow");
    await db.update(leagues).set({ active: false }).where(eq(leagues.id, fixture.leagueId));
    await expect(workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: [fixture.roster[0].id] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.update(leagues).set({ active: true }).where(eq(leagues.id, fixture.leagueId));
    const policyInput = { organizationId: fixture.organizationId, leagueId: fixture.leagueId, activationId: fixture.activationId, activationRevision: 1, activationSourceFingerprint: fixture.activationSourceFingerprint, policyVersion: 1, collectionPoints: [{ occurrenceId: fixture.occurrenceIds[1] }], occurrences: [{ occurrenceId: fixture.occurrenceIds[0], groupKey: "double-1", groupRole: "paired" as const, pairedOccurrenceId: fixture.occurrenceIds[1], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } }, { occurrenceId: fixture.occurrenceIds[1], groupKey: "double-1", groupRole: "trigger" as const, pairedOccurrenceId: fixture.occurrenceIds[0], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } }] };
    const draft = await workflow.createF3Policy({ ...policyInput, actorUserId: fixture.actorUserId, commandKey: `f3-policy-${fixture.organizationId}` });
    const approved = await workflow.approveF3Policy({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, policyId: draft.id, actorUserId: fixture.actorUserId });
    expect(approved.state).toBe("approved");
    const policyRevisions = await db.select().from(f3CollectionPolicyRevisions).where(eq(f3CollectionPolicyRevisions.policyId, draft.id)).orderBy(f3CollectionPolicyRevisions.revisionNumber);
    expect(policyRevisions).toHaveLength(2);
    expect((policyRevisions[0].afterSnapshot as { contractVersion: string }).contractVersion).toBe("canonical-collection-policy/1");
    expect((policyRevisions[1].beforeSnapshot as { contractVersion: string }).contractVersion).toBe("canonical-collection-policy/1");
    expect((policyRevisions[1].afterSnapshot as { occurrences: Array<{ occurrenceId: string; groupRole: string; pairedOccurrenceId: string | null }> }).occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceId: fixture.occurrenceIds[1], groupKey: "double-1", groupRole: "trigger", pairedOccurrenceId: fixture.occurrenceIds[0], collectionPointOccurrenceId: fixture.occurrenceIds[1] }),
      expect.objectContaining({ occurrenceId: fixture.occurrenceIds[0], groupKey: "double-1", groupRole: "paired", pairedOccurrenceId: fixture.occurrenceIds[1], collectionPointOccurrenceId: fixture.occurrenceIds[1] }),
    ]));
    await expect(db.insert(f3CollectionPolicies).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, activationId: fixture.activationId, activationRevision: 1, activationSourceFingerprint: fixture.activationSourceFingerprint, policyVersion: 99, policyFingerprint: `lvf3policy:v1:${"e".repeat(64)}`, commandKey: `f3-bad-draft-${fixture.organizationId}`, state: "draft", currentRevision: 1, collectionPoints: [{ occurrenceId: fixture.occurrenceIds[1] }], createdByUserId: fixture.actorUserId, approvedByUserId: fixture.actorUserId, approvedAt: "2037-12-01T00:00:00.000Z" })).rejects.toThrow();
    await expect(db.update(f3CollectionPolicies).set({ currentRevision: approved.currentRevision + 1 }).where(eq(f3CollectionPolicies.id, draft.id))).rejects.toThrow();
    const rows = await db.select().from(f3CollectionPolicyOccurrences).where(eq(f3CollectionPolicyOccurrences.policyId, draft.id));
    const protectedRow = rows[0];
    if (!protectedRow) throw new Error("policy occurrence fixture missing");
    await expect(db.insert(f3CollectionPolicyOccurrences).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, policyId: draft.id, occurrenceId: protectedRow.occurrenceId, groupKey: protectedRow.groupKey, groupRole: protectedRow.groupRole, pairedOccurrenceId: protectedRow.pairedOccurrenceId, collectionPointOccurrenceId: protectedRow.collectionPointOccurrenceId, itemIndex: 99 })).rejects.toThrow();
    await expect(db.update(f3CollectionPolicyOccurrences).set({ groupKey: "tampered" }).where(eq(f3CollectionPolicyOccurrences.id, protectedRow.id))).rejects.toThrow();
    await expect(db.delete(f3CollectionPolicyOccurrences).where(eq(f3CollectionPolicyOccurrences.id, protectedRow.id))).rejects.toThrow();
    let obligations = await db.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId), eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId)));
    const partialObligation = obligations.find((obligation) => obligation.occurrenceId === fixture.occurrenceIds[0] && obligation.bowlerId === fixture.roster[0].id);
    if (!partialObligation) throw new Error("partial obligation fixture missing");
    const [partialPayment] = await db.insert(payments).values({ bowlerId: partialObligation.bowlerId, leagueId: fixture.leagueId, amount: 200, weekOf: "2038-01-01T00:00:00.000Z", status: "paid", type: "cash" }).returning({ id: payments.id });
    const [partialAllocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: partialPayment.id, obligationId: partialObligation.id, occurrenceId: partialObligation.occurrenceId, bowlerId: partialObligation.bowlerId, amountMinor: 200, currency: "USD", state: "active", allocationKey: `f3-partial-${fixture.organizationId}`, recordedByUserId: fixture.actorUserId }).returning();
    await db.insert(paymentOccurrenceAllocationRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, allocationId: partialAllocation.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: { amountMinor: 200, state: "active", obligationId: partialObligation.id }, recordedByUserId: fixture.actorUserId });
    await db.update(bowlerOccurrenceObligations).set({ state: "partially_settled", currentRevision: partialObligation.currentRevision + 1 }).where(eq(bowlerOccurrenceObligations.id, partialObligation.id));
    await db.insert(bowlerOccurrenceObligationRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, obligationId: partialObligation.id, revisionNumber: partialObligation.currentRevision + 1, snapshotSchemaVersion: 1, beforeSnapshot: { state: partialObligation.state }, afterSnapshot: { state: "partially_settled" }, recordedByUserId: fixture.actorUserId });
    await db.update(payments).set({ refundedAt: "2038-01-15T00:00:00.000Z" }).where(eq(payments.id, partialPayment.id));
    await expect(workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id) })).rejects.toMatchObject({ code: "OBLIGATION_REVIEW_REQUIRED" });
    await db.update(payments).set({ refundedAt: null, disputedAt: "2038-01-16T00:00:00.000Z" }).where(eq(payments.id, partialPayment.id));
    await expect(workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id) })).rejects.toMatchObject({ code: "OBLIGATION_REVIEW_REQUIRED" });
    await db.update(payments).set({ disputedAt: null }).where(eq(payments.id, partialPayment.id));
    const [pendingOperation] = await db.insert(paymentOperations).values({ organizationId: fixture.organizationId, authorizingUserId: fixture.actorUserId, operationType: "interactive_charge", targetKey: `f3-pending-${fixture.organizationId}`, amountMinor: 100, currency: "USD", requestFingerprint: `lvpayreq:v1:${"c".repeat(64)}`, providerIdempotencyKey: `f3-pending-${fixture.organizationId}`, providerName: "square", status: "pending" }).returning({ id: paymentOperations.id });
    await db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({ operationId: pendingOperation.id, snapshotFingerprint: `lvpayexecic:v2:${"e".repeat(64)}`, leagueId: fixture.leagueId, locationId: fixture.locationId, payerBowlerId: fixture.roster[0].id, requestKind: "direct", encryptedSourceId: "fixture-source", sourceKind: "saved_card", weekOf: "2038-02-01T19:00:00.000Z" });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: pendingOperation.id, organizationId: fixture.organizationId, leagueId: fixture.leagueId, snapshotFingerprint: `lvpayocc:v1:${"d".repeat(64)}`, amountMinor: 100, currency: "USD", allocationCount: 1 });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({ operationId: pendingOperation.id, allocationIndex: 0, organizationId: fixture.organizationId, leagueId: fixture.leagueId, snapshotVersion: 1, obligationId: partialObligation.id, occurrenceId: partialObligation.occurrenceId, bowlerId: partialObligation.bowlerId, amountMinor: 100, currency: "USD" });
    });
    const beforePending = (await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).length;
    const { quoteInteractiveOccurrenceAllocations: quoteF2WhilePending } = await import("../../server/services/interactive-occurrence-allocation");
    const pendingF2Quote = await quoteF2WhilePending({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, amountMinor: 50, currency: "USD", allowedBowlerIds: [fixture.roster[1].id] });
    expect(pendingF2Quote.reservedByReadyAutopayPlan ?? []).toEqual([]);
    await expect(workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id) })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED_BY_F2_OPERATION" });
    expect(await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).toHaveLength(beforePending);
    await db.update(paymentOperations).set({ status: "canceled", completedAt: new Date().toISOString(), nextAttemptAt: null }).where(eq(paymentOperations.id, pendingOperation.id));
    await expect(workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id) })).resolves.toMatchObject({ organizationId: fixture.organizationId });
    obligations = await db.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId), eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId)));
    const allocations = await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.organizationId, fixture.organizationId));
    const policyOrder = [...rows].sort((a, b) => a.itemIndex - b.itemIndex);
    const items = policyOrder.flatMap((row, rowIndex) => fixture.roster.slice(0, 2).map((bowler, bowlerIndex) => {
      const obligation = obligations.find((candidate) => candidate.occurrenceId === row.occurrenceId && candidate.bowlerId === bowler.id);
      if (!obligation) throw new Error("obligation fixture missing");
      const allocated = allocations.filter((allocation) => allocation.obligationId === obligation.id).reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      return { obligationId: obligation.id, occurrenceId: row.occurrenceId, bowlerId: bowler.id, collectionPointOccurrenceId: row.collectionPointOccurrenceId, amountMinor: 500 - allocated, itemIndex: rowIndex * 2 + bowlerIndex };
    }));
    const ordered = canonicalizeF3QuoteItems(items, [fixture.occurrenceIds[1]]);
    const preauth = f3PreauthorizationFingerprint({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, policyId: draft.id, policyVersion: 1, activationRevision: 1, activationSourceFingerprint: fixture.activationSourceFingerprint, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id), acceptedPartnerIds: [fixture.roster[1].id], collectionPointOccurrenceIds: [fixture.occurrenceIds[1]], items: ordered, timing: "at_collection_point", totalAmountMinor: ordered.reduce((sum, row) => sum + row.amountMinor, 0), nextAuthorizationVersion: 1 });
    const input = (commandKey: string) => ({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, policyId: draft.id, policyVersion: 1, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id), acceptedPartnerIds: [fixture.roster[1].id], paymentMethodFingerprint: "a".repeat(64), locationId: fixture.locationId, collectionPointOccurrenceIds: [fixture.occurrenceIds[1]], timing: "at_collection_point" as const, preauthorizationFingerprint: preauth, authorizedItems: ordered, sourceId: "card-1", customerId: "customer-0", actorUserId: fixture.actorUserId, providerValidated: true, payerOwnedPaymentMethod: true, leagueLocationId: fixture.locationId, commandKey });
    await expect(db.insert(f3PayerAuthorizations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, policyId: draft.id, policyVersion: 1, authorizationVersion: 99, authorizationFingerprint: `lvf3auth:v1:${"f".repeat(64)}`, preauthorizationQuoteFingerprint: preauth, authorizedItems: ordered, commandKey: `f3-bad-revoked-${fixture.organizationId}`, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id), acceptedPartnerIds: [fixture.roster[1].id], collectionPointOccurrenceIds: [fixture.occurrenceIds[1]], locationId: fixture.locationId, encryptedSourceId: "fixture-source", encryptedCustomerId: "fixture-customer", paymentMethodFingerprint: "a".repeat(64), timing: "at_collection_point", state: "revoked", currentRevision: 1, createdByUserId: fixture.actorUserId, authorizedAt: null, revokedAt: null })).rejects.toThrow();
    const beforeStale = { auth: (await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).length, plans: (await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.leagueId, fixture.leagueId))).length, items: (await db.select().from(occurrenceCollectionPlanItems).where(eq(occurrenceCollectionPlanItems.leagueId, fixture.leagueId))).length, provenance: (await db.select().from(f3AutopayPlanProvenance).where(eq(f3AutopayPlanProvenance.leagueId, fixture.leagueId))).length, revisions: (await db.select().from(f3PayerAuthorizationRevisions).where(eq(f3PayerAuthorizationRevisions.leagueId, fixture.leagueId))).length };
    await expect(workflow.authorizeF3Payer({ ...input(`f3-stale-${fixture.organizationId}`), preauthorizationFingerprint: `lvf3quote:v1:${"b".repeat(64)}` })).rejects.toMatchObject({ code: "PREAUTHORIZATION_QUOTE_STALE" });
    expect({ auth: (await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).length, plans: (await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.leagueId, fixture.leagueId))).length, items: (await db.select().from(occurrenceCollectionPlanItems).where(eq(occurrenceCollectionPlanItems.leagueId, fixture.leagueId))).length, provenance: (await db.select().from(f3AutopayPlanProvenance).where(eq(f3AutopayPlanProvenance.leagueId, fixture.leagueId))).length, revisions: (await db.select().from(f3PayerAuthorizationRevisions).where(eq(f3PayerAuthorizationRevisions.leagueId, fixture.leagueId))).length }).toEqual(beforeStale);
    const race = await Promise.allSettled([workflow.authorizeF3Payer(input(`f3-race-a-${fixture.organizationId}`)), workflow.authorizeF3Payer(input(`f3-race-b-${fixture.organizationId}`))]);
    expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((entry) => entry.status === "rejected").map((entry) => entry.reason.code)).toEqual(["OBLIGATION_ALREADY_RESERVED"]);
    const fulfilled = race.find((entry): entry is PromiseFulfilledResult<{ authorizationId: string; replay: boolean }> => entry.status === "fulfilled");
    if (!fulfilled) throw new Error("authorization race did not produce a winner");
    const winningInput = input(race[0].status === "fulfilled" ? `f3-race-a-${fixture.organizationId}` : `f3-race-b-${fixture.organizationId}`);
    const result = fulfilled.value;
    expect(result.replay).toBe(false);
    expect(await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.leagueId, fixture.leagueId))).toHaveLength(1);
    expect(await db.select().from(occurrenceCollectionPlanItems).where(eq(occurrenceCollectionPlanItems.leagueId, fixture.leagueId))).toHaveLength(4);
    expect(await db.select().from(f3AutopayPlanProvenance).where(eq(f3AutopayPlanProvenance.leagueId, fixture.leagueId))).toHaveLength(1);
    await expect(db.update(f3PayerAuthorizations).set({ authorizedItems: [] }).where(eq(f3PayerAuthorizations.id, result.authorizationId))).rejects.toThrow();
    await expect(db.update(f3PayerAuthorizations).set({ currentRevision: 3 }).where(eq(f3PayerAuthorizations.id, result.authorizationId))).rejects.toThrow();
    await expect(db.update(f3PayerAuthorizations).set({ state: "draft", currentRevision: 2 }).where(eq(f3PayerAuthorizations.id, result.authorizationId))).rejects.toThrow();
    await expect(db.update(f3CollectionPolicies).set({ state: "draft", currentRevision: approved.currentRevision + 1 }).where(eq(f3CollectionPolicies.id, draft.id))).rejects.toThrow();
    await expect(db.delete(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.id, result.authorizationId))).rejects.toThrow();
    const replayBefore = (await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).length;
    expect((await workflow.authorizeF3Payer(winningInput)).replay).toBe(true);
    expect(await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).toHaveLength(replayBefore);
    await expect(workflow.authorizeF3Payer({ ...winningInput, acceptedPartnerIds: [], commandKey: winningInput.commandKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const { quoteInteractiveOccurrenceAllocations } = await import("../../server/services/interactive-occurrence-allocation");
    await expect(quoteInteractiveOccurrenceAllocations({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, amountMinor: ordered[0].amountMinor, currency: "USD", allowedBowlerIds: [fixture.roster[0].id], selections: [{ obligationId: ordered[0].obligationId, amountMinor: ordered[0].amountMinor }] })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED_BY_AUTOPAY" });
    const beforeDrift = (await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).length;
    const [driftLocation] = await db.insert(locations).values({ name: "F3 drift location", organizationId: fixture.organizationId }).returning({ id: locations.id });
    await db.update(bowlers).set({ paymentProviderLocationId: driftLocation.id }).where(eq(bowlers.id, fixture.roster[0].id));
    await expect(workflow.authorizeF3Payer({ ...winningInput, commandKey: `f3-location-drift-${fixture.organizationId}` })).rejects.toMatchObject({ code: "PAYMENT_LOCATION_MISMATCH" });
    expect(await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).toHaveLength(beforeDrift);
    await db.update(bowlers).set({ paymentProviderLocationId: fixture.locationId }).where(eq(bowlers.id, fixture.roster[0].id));
    expect(await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.leagueId, fixture.leagueId))).toHaveLength(1);
    await db.update(leagues).set({ active: false }).where(eq(leagues.id, fixture.leagueId));
    await expect(workflow.readF3ReadyPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, authorizationId: result.authorizationId })).resolves.toMatchObject({ authorization: { id: result.authorizationId } });
    const revoked = await workflow.revokeF3Authorization({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, authorizationId: result.authorizationId, actorUserId: fixture.actorUserId, actorBowlerId: fixture.roster[0].id });
    expect(revoked.state).toBe("revoked");
    await db.update(leagues).set({ active: true }).where(eq(leagues.id, fixture.leagueId));
    expect((await db.select().from(f3PayerAuthorizationRevisions).where(eq(f3PayerAuthorizationRevisions.leagueId, fixture.leagueId))).length).toBeGreaterThanOrEqual(2);
  });
});
