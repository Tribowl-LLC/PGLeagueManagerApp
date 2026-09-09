import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  autopayConsents,
  autopayConsentPartners,
  bowlerLeagues,
  bowlers,
  bowlerPaymentLinks,
  leagueOccurrences,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  paymentVoids,
  payments,
  standingAutopayPreparationAttempts,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { deleteUnusedBowler } from "../../server/services/bowler-deletion";
import { getTestDb, getTestPool } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];
let fixtureSequence = 0;

interface Fixture {
  organizationId: number;
  locationId: number;
  leagueId: number;
  teamId: number;
  actorUserId: number;
  bowlerId: number;
  otherBowlerId: number;
  occurrenceId: string;
}

async function fixture(label: string): Promise<Fixture> {
  fixtureSequence += 1;
  const key = `${label.toLowerCase()}-${suffix}-${fixtureSequence}`;
  const [organization] = await db.insert(organizations).values({
    name: `Bowler deletion ${label}`,
    slug: `bowler-deletion-${key}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("bowler deletion organization was not created");
  organizationIds.push(organization.id);

  const [location] = await db.insert(locations).values({
    organizationId: organization.id,
    name: `Bowler deletion ${label} location`,
  }).returning({ id: locations.id });
  if (!location) throw new Error("bowler deletion location was not created");

  const [league] = await db.insert(leagues).values({
    name: `Bowler deletion ${label} league`,
    organizationId: organization.id,
    locationId: location.id,
    payingLineupSize: 3,
    seasonStart: "2039-01-01T00:00:00.000Z",
    seasonEnd: "2039-12-31T23:59:59.000Z",
    weekDay: "Sunday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("bowler deletion league was not created");

  const [actor] = await db.insert(users).values({
    email: `bowler-deletion-${key}@example.test`,
    password: "deterministic-test-password-hash",
    name: `Bowler deletion ${label} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("bowler deletion actor was not created");

  const [team] = await db.insert(teams).values({
    name: `Bowler deletion ${label} team`,
    number: 1,
    leagueId: league.id,
  }).returning({ id: teams.id });
  if (!team) throw new Error("bowler deletion team was not created");

  const [bowler] = await db.insert(bowlers).values({
    name: `Bowler deletion ${label} target`,
    email: `target-${key}@example.test`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  const [otherBowler] = await db.insert(bowlers).values({
    name: `Bowler deletion ${label} other`,
    email: `other-${key}@example.test`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  if (!bowler || !otherBowler) throw new Error("bowler deletion bowlers were not created");

  await db.insert(teamPaymentSlots).values([
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "vacant", recordedByUserId: actor.id },
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "unassigned", recordedByUserId: actor.id },
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "unassigned", recordedByUserId: actor.id },
  ]);

  const occurrenceId = randomUUID();
  await db.insert(leagueOccurrences).values({
    id: occurrenceId,
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    generationKey: `bowler-deletion-occurrence-${key}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: "2039-01-07",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: "2039-01-07T19:00:00.000Z",
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "bowler-deletion-test",
    currentRevision: 1,
  });

  return {
    organizationId: organization.id,
    locationId: location.id,
    leagueId: league.id,
    teamId: team.id,
    actorUserId: actor.id,
    bowlerId: bowler.id,
    otherBowlerId: otherBowler.id,
    occurrenceId,
  };
}

async function addMembership(f: Fixture, active: boolean): Promise<number> {
  const [row] = await db.insert(bowlerLeagues).values({
    bowlerId: f.bowlerId,
    leagueId: f.leagueId,
    teamId: f.teamId,
    active,
    order: 1,
  }).returning({ id: bowlerLeagues.id });
  if (!row) throw new Error("bowler deletion membership was not created");
  return row.id;
}

async function addResponsibility(
  f: Fixture,
  options: {
    state?: "active" | "voided";
    mainBowlerId?: number | null;
    substituteBowlerId?: number | null;
    payerBowlerId?: number | null;
    amountMinor?: number;
    positionIndex?: number;
  } = {},
): Promise<string> {
  const state = options.state ?? "voided";
  const mainBowlerId = options.mainBowlerId === undefined ? f.bowlerId : options.mainBowlerId;
  const substituteBowlerId = options.substituteBowlerId === undefined ? null : options.substituteBowlerId;
  const payerBowlerId = options.payerBowlerId === undefined ? f.bowlerId : options.payerBowlerId;
  const amountMinor = options.amountMinor ?? 1_000;
  const positionIndex = options.positionIndex ?? 0;
  const [row] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    occurrenceId: f.occurrenceId,
    teamId: f.teamId,
    slotId: (await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, f.organizationId),
      eq(teamPaymentSlots.leagueId, f.leagueId),
      eq(teamPaymentSlots.teamId, f.teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    )))[0]?.id ?? (() => { throw new Error("bowler deletion slot was not created"); })(),
    slotIndex: 0,
    positionIndex,
    state,
    responsibilityKind: substituteBowlerId === null ? "main" : "substitute",
    mainBowlerId,
    substituteBowlerId,
    payerBowlerId,
    policy: "main_pays_full",
    amountMinor,
    dueAt: "2039-01-01T00:00:00.000Z",
    pastDueAt: "2039-01-02T00:00:00.000Z",
    recordedByUserId: f.actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  if (!row) throw new Error("bowler deletion responsibility was not created");
  return row.id;
}

async function addObligation(
  f: Fixture,
  responsibilityId: string,
  payerBowlerId = f.bowlerId,
  state: "open" | "partially_settled" | "settled" | "voided" = "voided",
): Promise<string> {
  const [row] = await db.insert(paymentObligations).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    occurrenceId: f.occurrenceId,
    responsibilityId,
    component: "full",
    payerBowlerId,
    amountMinor: 1_000,
    dueAt: "2039-01-01T00:00:00.000Z",
    pastDueAt: "2039-01-02T00:00:00.000Z",
    state,
    voidedAt: state === "voided" ? "2039-01-03T00:00:00.000Z" : null,
    createdByUserId: f.actorUserId,
  }).returning({ id: paymentObligations.id });
  if (!row) throw new Error("bowler deletion obligation was not created");
  return row.id;
}

async function addPayment(
  f: Fixture,
  bowlerId: number,
  status: "paid" | "voided",
  type: "cash" | "check" = "cash",
  obligationId: string,
) {
  // The migrated schema has a deferred conservation trigger requiring every
  // payment parent to be inserted atomically with at least one allocation.
  const paymentId = await db.transaction(async (tx) => {
    const [row] = await tx.insert(payments).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      bowlerId,
      amount: 1_000,
      type,
      status,
      checkNumber: type === "check" ? `check-${fixtureSequence}` : null,
    }).returning({ id: payments.id });
    if (!row) throw new Error("bowler deletion payment was not created");
    await tx.insert(paymentAllocations).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      paymentId: row.id,
      obligationId,
      amountMinor: 1_000,
      state: status === "voided" ? "voided" : "active",
      recordedByUserId: f.actorUserId,
    });
    if (status === "voided") {
      await tx.insert(paymentVoids).values({
        organizationId: f.organizationId,
        leagueId: f.leagueId,
        paymentId: row.id,
        reason: "synthetic duplicate correction",
        recordedByUserId: f.actorUserId,
      });
    }
    return row.id;
  });
  return paymentId;
}

async function addInteractiveOperationEvidence(f: Fixture, obligationId: string, status: "pending" | "failed_terminal" | "succeeded") {
  const operationId = randomUUID();
  const fingerprint = "a".repeat(64);
  await db.insert(paymentOperations).values({
    id: operationId,
    organizationId: f.organizationId,
    authorizingUserId: f.actorUserId,
    operationType: "interactive_charge",
    targetKey: `bowler-deletion-operation-${operationId}`,
    leagueId: f.leagueId,
    amountMinor: 1_000,
    currency: "USD",
    requestFingerprint: `lvpayreq:v1:${fingerprint}`,
    providerIdempotencyKey: `bowler-delete-${operationId}`.slice(0, 45),
    providerName: "square",
    providerObjectId: status === "succeeded" ? `provider-${operationId}` : null,
    status,
    nextAttemptAt: status === "pending" ? "2039-01-01T00:00:00.000Z" : null,
    attemptCount: status === "pending" ? 0 : 1,
    startedAt: status === "pending" ? null : "2039-01-01T00:00:00.000Z",
    completedAt: status === "pending" ? null : "2039-01-01T00:01:00.000Z",
    errorClassification: status === "failed_terminal" ? "hard_decline" : null,
    errorCode: status === "failed_terminal" ? "DECLINED" : null,
  });
  await db.transaction(async (tx) => {
    // Parent and item are committed together because the migrated template
    // has a deferred snapshot-total conservation trigger.
    await tx.insert(paymentOperationRosterSnapshots).values({
      operationId,
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      snapshotKind: "interactive",
      amountMinor: 1_000,
      currency: "USD",
      obligations: [{ id: obligationId, responsibilityId: "synthetic", responsibilityVersion: 1, payerBowlerId: f.bowlerId, amountMinor: 1_000 }],
      locationId: f.locationId,
      payerBowlerId: f.bowlerId,
      requestKind: "direct",
      encryptedSourceId: "synthetic-source",
      sourceKind: "new_card",
      quoteFingerprint: `lvrosterquote:v1:${fingerprint}`,
      snapshotFingerprint: `lvrosterexec:v1:${fingerprint}`,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values({
      operationId,
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      obligationId,
      allocationIndex: 0,
      amountMinor: 1_000,
      state: "released",
    });
  });
}

async function addConsent(f: Fixture, state: "pending" | "active" | "revoked" | "expired" = "pending", payerBowlerId = f.bowlerId): Promise<string> {
  const consentId = randomUUID();
  const fingerprint = "b".repeat(64);
  const providerFields = state === "active" || state === "revoked" || state === "expired"
    ? { providerName: "square", providerLocationId: "synthetic-location", encryptedSourceId: "synthetic-source", encryptedCustomerId: "synthetic-customer" }
    : {};
  await db.insert(autopayConsents).values({
    id: consentId,
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    payerBowlerId,
    consentVersion: 1,
    state,
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${fingerprint}`,
    createdByUserId: f.actorUserId,
    ...providerFields,
    revokedAt: state === "revoked" || state === "expired" ? "2039-01-03T00:00:00.000Z" : null,
  });
  return consentId;
}

async function expectBlocked(f: Fixture, code: string): Promise<void> {
  await expect(deleteUnusedBowler(f.bowlerId)).rejects.toMatchObject({
    blockers: [{ code }],
  });
  expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]?.id)
    .toBe(f.bowlerId);
}

async function expectDependencyChangedQuickly(deletion: Promise<void>): Promise<void> {
  const timeout = Symbol("deletion timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<unknown>((resolve) => {
    timer = setTimeout(() => resolve(timeout), 2_000);
    deletion.then(resolve, resolve);
  });
  if (timer !== undefined) clearTimeout(timer);
  expect(outcome).not.toBe(timeout);
  expect(outcome).toMatchObject({ blockers: [{ code: "DEPENDENCY_CHANGED" }] });
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("safe unused bowler deletion", () => {
  it("rejects active roster membership, payment slots, and active responsibilities", async () => {
    const membership = await fixture("active-membership");
    await addMembership(membership, true);
    await expectBlocked(membership, "ACTIVE_ROSTER_MEMBERSHIP");

    const slot = await fixture("active-slot");
    await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: slot.bowlerId })
      .where(and(eq(teamPaymentSlots.organizationId, slot.organizationId), eq(teamPaymentSlots.teamId, slot.teamId), eq(teamPaymentSlots.slotIndex, 0)));
    await expectBlocked(slot, "ROSTER_PAYMENT_SLOT");

    const responsibility = await fixture("active-responsibility");
    await addResponsibility(responsibility, { state: "active" });
    await expectBlocked(responsibility, "ACTIVE_RESPONSIBILITY");
  });

  it("rejects linked logins and open obligations without mutating retained rows", async () => {
    const linked = await fixture("linked-login");
    await db.insert(users).values({
      email: `linked-${suffix}-${fixtureSequence}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Linked login",
      role: "user",
      organizationId: linked.organizationId,
      bowlerId: linked.bowlerId,
    });
    await expectBlocked(linked, "LINKED_LOGIN");

    const open = await fixture("open-obligation");
    const responsibilityId = await addResponsibility(open);
    const obligationId = await addObligation(open, responsibilityId, open.bowlerId, "open");
    await expectBlocked(open, "OPEN_PAYMENT_OBLIGATION");
    expect((await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligationId)))[0]?.id)
      .toBe(obligationId);
  });

  it("blocks every direct payment row, including voided cash, and retains replacements", async () => {
    const f = await fixture("cash-history");
    const originalObligationId = await addObligation(f, await addResponsibility(f), f.bowlerId, "voided");
    const replacementObligationId = await addObligation(f, await addResponsibility(f, { positionIndex: 1 }), f.bowlerId, "settled");
    const originalPaymentId = await addPayment(f, f.bowlerId, "voided", "cash", originalObligationId);
    const replacementPaymentId = await addPayment(f, f.bowlerId, "paid", "check", replacementObligationId);
    await expectBlocked(f, "PAYMENT_EVIDENCE");
    const rows = await db.select({ id: payments.id, status: payments.status, type: payments.type })
      .from(payments).where(eq(payments.organizationId, f.organizationId));
    expect(rows).toEqual(expect.arrayContaining([
      { id: originalPaymentId, status: "voided", type: "cash" },
      { id: replacementPaymentId, status: "paid", type: "check" },
    ]));
  });

  it("blocks allocations even when another bowler paid and the allocation is voided", async () => {
    const f = await fixture("other-payer-allocation");
    const responsibilityId = await addResponsibility(f);
    const obligationId = await addObligation(f, responsibilityId);
    const paymentId = await addPayment(f, f.otherBowlerId, "voided", "cash", obligationId);
    const [allocation] = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.paymentId, paymentId),
      eq(paymentAllocations.obligationId, obligationId),
    ));
    if (!allocation) throw new Error("bowler deletion allocation was not created");
    await expectBlocked(f, "PAYMENT_ALLOCATION_EVIDENCE");
    expect((await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(eq(paymentAllocations.id, allocation.id)))[0]?.id)
      .toBe(allocation.id);
  });

  it.each(["pending", "failed_terminal", "succeeded"] as const)(
    "blocks %s provider operations and released roster snapshots",
    async (status) => {
      const f = await fixture(`operation-${status}`);
      const responsibilityId = await addResponsibility(f);
      const obligationId = await addObligation(f, responsibilityId);
      await addInteractiveOperationEvidence(f, obligationId, status);
      await expectBlocked(f, "PAYMENT_OPERATION_EVIDENCE");
      expect((await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligationId)))[0]?.id)
        .toBe(obligationId);
    },
  );

  it("blocks standing participant and consent-binding operation history", async () => {
    const participant = await fixture("standing-participant");
    const responsibilityId = await addResponsibility(participant);
    const obligationId = await addObligation(participant, responsibilityId);
    const otherConsentId = await addConsent(participant, "active", participant.otherBowlerId);
    const [link] = await db.insert(bowlerPaymentLinks).values({
      bowlerAId: Math.min(participant.bowlerId, participant.otherBowlerId),
      bowlerBId: Math.max(participant.bowlerId, participant.otherBowlerId),
      organizationId: participant.organizationId,
      status: "accepted",
      createdByUserId: participant.actorUserId,
      respondedAt: "2039-01-01T00:00:00.000Z",
    }).returning({ id: bowlerPaymentLinks.id });
    if (!link) throw new Error("standing participant payment link was not created");
    const linkFingerprint = `lvpartnerlink:v1:${"1".repeat(64)}`;
    await db.insert(autopayConsentPartners).values({
      organizationId: participant.organizationId,
      leagueId: participant.leagueId,
      consentId: otherConsentId,
      consentVersion: 1,
      partnerBowlerId: participant.bowlerId,
      paymentLinkId: link.id,
      linkFingerprint,
    });
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId: participant.organizationId,
      authorizingUserId: participant.actorUserId,
      operationType: "standing_autopay_charge",
      targetKey: `standing-participant-${operationId}`,
      triggerOccurrenceId: participant.occurrenceId,
      leagueId: participant.leagueId,
      amountMinor: 1_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"c".repeat(64)}`,
      providerIdempotencyKey: `standing-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "failed_terminal",
      nextAttemptAt: null,
      attemptCount: 1,
      startedAt: "2039-01-01T00:00:00.000Z",
      completedAt: "2039-01-01T00:01:00.000Z",
      errorClassification: "hard_decline",
      errorCode: "DECLINED",
    });
    const standingSnapshot = {
      operationId,
      organizationId: participant.organizationId,
      leagueId: participant.leagueId,
      snapshotKind: "standing_autopay" as const,
      collectionMode: "weekly" as const,
      cutoffAt: "2039-01-07T19:00:00.000Z",
      amountMinor: 1_000,
      currency: "USD",
      obligations: [{ id: obligationId, responsibilityId: "synthetic", responsibilityVersion: 1, payerBowlerId: participant.bowlerId, amountMinor: 1_000 }],
      snapshotFingerprint: `lvstandingcutoff:v1:${"2".repeat(64)}`,
    };
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values(standingSnapshot);
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId,
        organizationId: participant.organizationId,
        leagueId: participant.leagueId,
        obligationId,
        allocationIndex: 0,
        amountMinor: 1_000,
        state: "released",
      });
      await tx.insert(paymentOperationStandingAutopayBindings).values({
        operationId,
        organizationId: participant.organizationId,
        leagueId: participant.leagueId,
        consentId: otherConsentId,
        consentVersion: 1,
        providerName: "square",
        providerLocationId: "synthetic-location",
        triggerOccurrenceId: participant.occurrenceId,
        cutoffAt: "2039-01-07T19:00:00.000Z",
        collectionMode: "weekly",
        evidenceFingerprint: `lvstandingcutoff:v1:${"d".repeat(64)}`,
      });
      await tx.insert(paymentOperationStandingAutopayParticipants).values({
        operationId,
        organizationId: participant.organizationId,
        leagueId: participant.leagueId,
        allocationIndex: 0,
        obligationId,
        bowlerId: participant.bowlerId,
        role: "partner",
        paymentLinkId: link.id,
        linkFingerprint,
        consentVersion: 1,
      });
    });
    const [participantRow] = await db.select({ id: paymentOperationStandingAutopayParticipants.id })
      .from(paymentOperationStandingAutopayParticipants)
      .where(eq(paymentOperationStandingAutopayParticipants.operationId, operationId));
    if (!participantRow) throw new Error("standing participant evidence was not created");
    await expectBlocked(participant, "PAYMENT_OPERATION_EVIDENCE");

    const binding = await fixture("consent-binding");
    const bindingResponsibility = await addResponsibility(binding);
    const bindingObligation = await addObligation(binding, bindingResponsibility);
    const consentId = await addConsent(binding, "revoked");
    const bindingOperationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: bindingOperationId,
      organizationId: binding.organizationId,
      authorizingUserId: binding.actorUserId,
      operationType: "standing_autopay_charge",
      targetKey: `standing-binding-${bindingOperationId}`,
      triggerOccurrenceId: binding.occurrenceId,
      leagueId: binding.leagueId,
      amountMinor: 1_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"e".repeat(64)}`,
      providerIdempotencyKey: `binding-${bindingOperationId}`.slice(0, 45),
      providerName: "square",
      status: "failed_terminal",
      nextAttemptAt: null,
      attemptCount: 1,
      startedAt: "2039-01-01T00:00:00.000Z",
      completedAt: "2039-01-01T00:01:00.000Z",
      errorClassification: "hard_decline",
      errorCode: "DECLINED",
    });
    await db.insert(paymentOperationStandingAutopayBindings).values({
      operationId: bindingOperationId,
      organizationId: binding.organizationId,
      leagueId: binding.leagueId,
      consentId,
      consentVersion: 1,
      providerName: "square",
      providerLocationId: "synthetic-location",
      triggerOccurrenceId: binding.occurrenceId,
      cutoffAt: "2039-01-07T19:00:00.000Z",
      collectionMode: "weekly",
      evidenceFingerprint: `lvstandingcutoff:v1:${"f".repeat(64)}`,
    });
    expect(bindingObligation).toBeTruthy();
    await expectBlocked(binding, "PAYMENT_OPERATION_EVIDENCE");
  });

  it("blocks active autopay and provider preparation activity", async () => {
    const active = await fixture("active-consent");
    await addConsent(active, "active");
    await expectBlocked(active, "AUTOPAY_NOT_CANCELLED");

    const activity = await fixture("provider-activity");
    const consentId = await addConsent(activity, "revoked");
    await db.insert(standingAutopayPreparationAttempts).values({
      organizationId: activity.organizationId,
      leagueId: activity.leagueId,
      consentId,
      consentVersion: 1,
      cutoffAt: "2039-01-01T00:00:00.000Z",
      occurrenceRevision: 1,
      state: "failed_terminal",
      attemptCount: 1,
      lastErrorCode: "PROVIDER_DECLINED",
      nextAttemptAt: null,
    });
    await expectBlocked(activity, "AUTOPAY_PROVIDER_ACTIVITY");
  });

  it("retains shared responsibility history and another bowler's replacement rows", async () => {
    const f = await fixture("shared-history");
    const responsibilityId = await addResponsibility(f, {
      mainBowlerId: f.bowlerId,
      substituteBowlerId: f.otherBowlerId,
      payerBowlerId: f.otherBowlerId,
    });
    const obligationId = await addObligation(f, responsibilityId, f.otherBowlerId);
    const otherPaymentId = await addPayment(f, f.otherBowlerId, "paid", "check", obligationId);
    await expectBlocked(f, "SHARED_RESPONSIBILITY_HISTORY");
    expect((await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, responsibilityId)))[0]?.id)
      .toBe(responsibilityId);
    expect((await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligationId)))[0]?.id)
      .toBe(obligationId);
    expect((await db.select({ id: payments.id }).from(payments).where(eq(payments.id, otherPaymentId)))[0]?.id)
      .toBe(otherPaymentId);
  });

  it("cleans only unused voided evidence and inactive consents, while removing duplicate memberships", async () => {
    const f = await fixture("clean");
    const duplicateMembershipA = await addMembership(f, false);
    const duplicateMembershipB = await addMembership(f, false);
    const responsibilityId = await addResponsibility(f);
    const obligationId = await addObligation(f, responsibilityId);
    const consentId = await addConsent(f, "pending");

    // The append-only guard is active in the migrated test template. The
    // service is allowed to remove only these proven-unused rows after it
    // sets its transaction-local teardown marker.
    await expect(db.delete(paymentObligations).where(eq(paymentObligations.id, obligationId)))
      .rejects.toThrow();

    await expect(deleteUnusedBowler(f.bowlerId)).resolves.toBeUndefined();
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]).toBeUndefined();
    expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
      eq(bowlerLeagues.bowlerId, f.bowlerId),
      sql`${bowlerLeagues.id} IN (${duplicateMembershipA}, ${duplicateMembershipB})`,
    )))).toHaveLength(0);
    expect((await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, responsibilityId)))[0]).toBeUndefined();
    expect((await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligationId)))[0]).toBeUndefined();
    expect((await db.select({ id: autopayConsents.id }).from(autopayConsents).where(eq(autopayConsents.id, consentId)))[0]).toBeUndefined();
    const marker = await db.execute(sql`SELECT current_setting('leaguevault.organization_teardown', true) AS marker`);
    expect(marker.rows[0]?.marker ?? null).toBe(null);
  });

  it("retains an inactive membership that points at another organization's league", async () => {
    const target = await fixture("cross-org-target");
    const foreign = await fixture("cross-org-foreign");
    const [membership] = await db.insert(bowlerLeagues).values({
      bowlerId: target.bowlerId,
      leagueId: foreign.leagueId,
      teamId: foreign.teamId,
      active: false,
      order: 1,
    }).returning({ id: bowlerLeagues.id });
    if (!membership) throw new Error("cross-organization membership was not created");

    await expectBlocked(target, "CROSS_ORGANIZATION_MEMBERSHIP");
    expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues)
      .where(eq(bowlerLeagues.id, membership.id)))[0]?.id).toBe(membership.id);
  });

  it("fails fast and retains the bowler while a league writer holds the lock", async () => {
    const f = await fixture("race");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, f.organizationId, f.leagueId);
      acquired();
      await held;
      await tx.insert(bowlerLeagues).values({ bowlerId: f.bowlerId, leagueId: f.leagueId, teamId: f.teamId, active: true });
    });
    await lockAcquired;
    try {
      await expectDependencyChangedQuickly(deleteUnusedBowler(f.bowlerId));
    } finally {
      release();
      await writer;
    }
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]?.id).toBe(f.bowlerId);
    expect((await db.select({ active: bowlerLeagues.active }).from(bowlerLeagues).where(eq(bowlerLeagues.bowlerId, f.bowlerId)))[0]?.active).toBe(true);
  });

  it("fails fast when the target bowler row is busy", async () => {
    const f = await fixture("busy-bowler");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM bowlers WHERE id = ${f.bowlerId} FOR UPDATE`);
      acquired();
      await held;
    });
    await lockAcquired;
    try {
      await expectDependencyChangedQuickly(deleteUnusedBowler(f.bowlerId));
    } finally {
      release();
      await writer;
    }
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]?.id).toBe(f.bowlerId);
  });

  it("proves a concurrent new membership is blocked by the bowler lock and then fails its FK", async () => {
    const f = await fixture("concurrent-membership");
    const deleter = await getTestPool().connect();
    const inserter = await getTestPool().connect();
    const probe = await getTestPool().connect();
    let insertPromise: Promise<unknown> | undefined;
    try {
      await deleter.query("BEGIN");
      await deleter.query("SELECT id FROM bowlers WHERE id = $1 FOR UPDATE", [f.bowlerId]);
      const pidResult = await inserter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const inserterPid = pidResult.rows[0]?.pid;
      if (!inserterPid) throw new Error("membership inserter pid was not available");

      await inserter.query("BEGIN");
      insertPromise = inserter.query(
        `INSERT INTO bowler_leagues (bowler_id, league_id, team_id, active, "order")
         VALUES ($1, $2, $3, true, 1) RETURNING id`,
        [f.bowlerId, f.leagueId, f.teamId],
      );

      let waitingLocks = 0;
      for (let attempt = 0; attempt < 200 && waitingLocks === 0; attempt += 1) {
        const waiting = await probe.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_locks WHERE pid = $1 AND granted = false",
          [inserterPid],
        );
        waitingLocks = Number(waiting.rows[0]?.count ?? 0);
        if (waitingLocks === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingLocks).toBeGreaterThan(0);

      await expect(deleter.query("DELETE FROM bowlers WHERE id = $1", [f.bowlerId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await deleter.query("COMMIT");
      await expect(insertPromise).rejects.toMatchObject({ code: "23503" });
      await inserter.query("ROLLBACK");
    } finally {
      await deleter.query("ROLLBACK").catch(() => undefined);
      await insertPromise?.catch(() => undefined);
      await inserter.query("ROLLBACK").catch(() => undefined);
      probe.release();
      inserter.release();
      deleter.release();
    }
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]).toBeUndefined();
    expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(eq(bowlerLeagues.bowlerId, f.bowlerId)))).toHaveLength(0);
  });

  it("rolls back cleanup after the final bowler delete fails and restores the marker", async () => {
    const f = await fixture("rollback");
    await addMembership(f, false);
    const responsibilityId = await addResponsibility(f);
    const obligationId = await addObligation(f, responsibilityId);
    const consentId = await addConsent(f, "pending");
    await db.execute(sql`CREATE OR REPLACE FUNCTION bowler_delete_test_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional bowler deletion failure'; END; $$`);
    await db.execute(sql`CREATE TRIGGER bowler_delete_test_failure_trigger
      BEFORE DELETE ON bowlers FOR EACH ROW
      EXECUTE FUNCTION bowler_delete_test_failure()`);
    try {
      // Drizzle's wrapped query error does not always preserve PostgreSQL's
      // trigger text, so assert the transaction failed rather than pinning a
      // driver-specific message.
      await expect(deleteUnusedBowler(f.bowlerId)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS bowler_delete_test_failure_trigger ON bowlers`);
      await db.execute(sql`DROP FUNCTION IF EXISTS bowler_delete_test_failure()`);
    }
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, f.bowlerId)))[0]?.id).toBe(f.bowlerId);
    expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(eq(bowlerLeagues.bowlerId, f.bowlerId)))).toHaveLength(1);
    expect((await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, responsibilityId)))[0]?.id).toBe(responsibilityId);
    expect((await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligationId)))[0]?.id).toBe(obligationId);
    expect((await db.select({ id: autopayConsents.id }).from(autopayConsents).where(eq(autopayConsents.id, consentId)))[0]?.id).toBe(consentId);
    const marker = await db.execute(sql`SELECT current_setting('leaguevault.organization_teardown', true) AS marker`);
    expect(marker.rows[0]?.marker ?? null).toBe(null);
  });
});
