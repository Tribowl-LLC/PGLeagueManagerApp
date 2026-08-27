/**
 * Integration tests for the SQL-level payment-by-org filter (task #295).
 *
 * Pins the contract that `/api/payments` enforces via the storage helpers
 * `getPayments({ organizationId })` and `getAllPaymentsSystemAdmin()` — the
 * SAME behavior matrix the in-memory `filterPaymentsByOrganization` helper
 * documents. If a future refactor of `buildPaymentConditions` quietly drops
 * the per-org JOIN clause, these tests fail.
 *
 * Scope note: this file deliberately covers only scenarios that can be set
 * up with type-safe inserts and zero schema mutation. The `excludeOrgLessLeagues`
 * branch of `buildPaymentConditions` (which suppresses payments whose parent
 * league has `organization_id IS NULL`) is covered by the in-memory unit test
 * `tests/unit/payments-by-org.test.ts`, which pins the same semantic against
 * the documented behavior matrix in `server/utils/access-control.ts`. We do
 * not exercise that branch here because constructing an org-less league
 * requires DDL mutation of the shared `leagues.organization_id` NOT NULL
 * constraint, which is brittle in parallel test runs and fights the type
 * system. See task #295's description for the source-of-truth matrix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  leagues,
  bowlers,
  leagueOccurrences,
  leagueScheduleCommands,
  locations,
  occurrencePaymentResponsibilities,
  paymentAllocations,
  paymentObligations,
  payments,
  organizations,
  teamPaymentSlots,
  teams,
} from '@shared/schema';
import {
  login,
  apiGet,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';

interface PaymentRow {
  id: number;
  leagueId: number;
}

const TEST_ORG_A_SLUG = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
const TEST_ORG_B_SLUG = process.env.TEST_ORG_B_SLUG || 'vitest-org-b';

describe('GET /api/payments — SQL-level org filtering', () => {
  let sysAdmin: AuthSession;
  let orgAAdmin: AuthSession;
  let orgBAdmin: AuthSession;

  let orgAId = 0;
  let orgBId = 0;

  let leagueOrgAId = 0;
  let leagueOrgBId = 0;

  let bowlerId = 0;
  let bowlerOrgBId = 0;
  let paymentOrgAId = 0;
  let paymentOrgBId = 0;
  const paymentEvidence: Array<{
    organizationId: number;
    paymentId: number;
    allocationId: string;
    obligationId: string;
    responsibilityId: string;
    occurrenceId: string;
    commandId: string;
    slotId: string;
    teamId: number;
    locationId: number;
  }> = [];

  async function createCanonicalPayment(input: {
    organizationId: number;
    leagueId: number;
    bowlerId: number;
    actorUserId: number;
    amount: number;
    label: string;
  }): Promise<number> {
    const [location] = await db.insert(locations).values({
      organizationId: input.organizationId,
      name: `${input.label} payment location`,
    }).returning({ id: locations.id });
    const [team] = await db.insert(teams).values({
      name: `${input.label} payment team`,
      number: Math.floor(Math.random() * 900_000) + 10_000,
      leagueId: input.leagueId,
    }).returning({ id: teams.id });
    const [slot] = await db.insert(teamPaymentSlots).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      teamId: team.id,
      slotIndex: 0,
      lineupSize: 3,
      occupant: 'main',
      mainBowlerId: input.bowlerId,
      recordedByUserId: input.actorUserId,
    }).returning({ id: teamPaymentSlots.id });
    const commandId = randomUUID();
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: 'publish',
      idempotencyKey: `${input.label}-${randomUUID()}`,
      requestFingerprint: `payments-by-org-${randomUUID()}`,
    });
    const [occurrence] = await db.insert(leagueOccurrences).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      locationId: location.id,
      generationKey: `${input.label}-occurrence-${randomUUID()}`,
      kind: 'regular',
      status: 'scheduled',
      lifecycle: 'published',
      authoritativeLocalDate: '2037-04-01',
      authoritativeLocalStartTime: '19:00:00',
      timezone: 'UTC',
      startAt: '2037-04-01T19:00:00.000Z',
      selectedUtcOffsetMinutes: 0,
      foldResolution: 'unambiguous',
      resolverVersion: 'payments-by-org-test',
      plannedOrdinal: 1,
      competitionNumber: 1,
      publishedAt: '2037-04-01T19:00:00.000Z',
      publishedByUserId: input.actorUserId,
      publicationCommandId: commandId,
      lastCommandId: commandId,
    }).returning({ id: leagueOccurrences.id });
    const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      occurrenceId: occurrence.id,
      teamId: team.id,
      slotId: slot.id,
      slotIndex: 0,
      positionIndex: 0,
      responsibilityKind: 'main',
      mainBowlerId: input.bowlerId,
      payerBowlerId: input.bowlerId,
      policy: 'main_pays_full',
      amountMinor: input.amount,
      currency: 'USD',
      dueAt: '2037-04-01T19:00:00.000Z',
      pastDueAt: '2037-04-01T19:00:00.000Z',
      recordedByUserId: input.actorUserId,
    }).returning({ id: occurrencePaymentResponsibilities.id });
    const [obligation] = await db.insert(paymentObligations).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      occurrenceId: occurrence.id,
      responsibilityId: responsibility.id,
      payerBowlerId: input.bowlerId,
      amountMinor: input.amount,
      currency: 'USD',
      dueAt: '2037-04-01T19:00:00.000Z',
      pastDueAt: '2037-04-01T19:00:00.000Z',
      createdByUserId: input.actorUserId,
    }).returning({ id: paymentObligations.id });
    const [payment] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(payments).values({
        organizationId: input.organizationId,
        bowlerId: input.bowlerId,
        leagueId: input.leagueId,
        amount: input.amount,
        type: 'cash',
        status: 'paid',
      }).returning({ id: payments.id });
      const [allocation] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: created.id,
        obligationId: obligation.id,
        amountMinor: input.amount,
        currency: 'USD',
        recordedByUserId: input.actorUserId,
      }).returning({ id: paymentAllocations.id });
      paymentEvidence.push({
        organizationId: input.organizationId,
        paymentId: created.id,
        allocationId: allocation.id,
        obligationId: obligation.id,
        responsibilityId: responsibility.id,
        occurrenceId: occurrence.id,
        commandId,
        slotId: slot.id,
        teamId: team.id,
        locationId: location.id,
      });
      return [created] as const;
    });
    return payment.id;
  }

  beforeAll(async () => {
    sysAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    orgAAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    orgBAdmin = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    const [orgA] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_A_SLUG));
    const [orgB] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_B_SLUG));
    if (!orgA || !orgB) throw new Error('Test orgs missing — run seed-test-users');
    orgAId = orgA.id;
    orgBId = orgB.id;

    const leagueDefaults = {
      seasonStart: '2025-01-01 00:00:00',
      seasonEnd: '2025-12-31 00:00:00',
      weekDay: 'Monday' as const,
    };

    const [la] = await db
      .insert(leagues)
      .values({ name: 'Vitest #295 Org-A League', ...leagueDefaults, organizationId: orgAId })
      .returning({ id: leagues.id });
    leagueOrgAId = la.id;

    const [lb] = await db
      .insert(leagues)
      .values({ name: 'Vitest #295 Org-B League', ...leagueDefaults, organizationId: orgBId })
      .returning({ id: leagues.id });
    leagueOrgBId = lb.id;

    const [bw] = await db
      .insert(bowlers)
      .values({ name: 'Vitest #295 Bowler', organizationId: orgAId })
      .returning({ id: bowlers.id });
    bowlerId = bw.id;
    const [bwB] = await db
      .insert(bowlers)
      .values({ name: 'Vitest #295 Org-B Bowler', organizationId: orgBId })
      .returning({ id: bowlers.id });
    bowlerOrgBId = bwB.id;

    paymentOrgAId = await createCanonicalPayment({
      organizationId: orgAId,
      leagueId: leagueOrgAId,
      bowlerId,
      actorUserId: orgAAdmin.user.id,
      amount: 100,
      label: 'payments-by-org-a',
    });
    paymentOrgBId = await createCanonicalPayment({
      organizationId: orgBId,
      leagueId: leagueOrgBId,
      bowlerId: bowlerOrgBId,
      actorUserId: orgBAdmin.user.id,
      amount: 100,
      label: 'payments-by-org-b',
    });
  });

  afterAll(async () => {
    // Deterministic teardown: each step throws on failure so CI surfaces
    // any cleanup regression rather than masking it.
    for (const evidence of paymentEvidence) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
        await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, evidence.allocationId));
        await tx.delete(payments).where(eq(payments.id, evidence.paymentId));
        await tx.delete(paymentObligations).where(eq(paymentObligations.id, evidence.obligationId));
        await tx.delete(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, evidence.responsibilityId));
        await tx.delete(leagueOccurrences).where(eq(leagueOccurrences.id, evidence.occurrenceId));
        await tx.delete(leagueScheduleCommands).where(eq(leagueScheduleCommands.id, evidence.commandId));
        await tx.delete(teamPaymentSlots).where(eq(teamPaymentSlots.id, evidence.slotId));
        await tx.delete(teams).where(eq(teams.id, evidence.teamId));
        await tx.delete(locations).where(eq(locations.id, evidence.locationId));
      });
    }
    if (bowlerId) {
      await db.delete(bowlers).where(eq(bowlers.id, bowlerId));
    }
    if (bowlerOrgBId) {
      await db.delete(bowlers).where(eq(bowlers.id, bowlerOrgBId));
    }
    const leagueIds = [leagueOrgAId, leagueOrgBId].filter(Boolean);
    if (leagueIds.length) {
      await db.delete(leagues).where(inArray(leagues.id, leagueIds));
    }
  });

  it('org A admin sees the org A payment, never the org B one', async () => {
    const { status, data } = await apiGet<PaymentRow[]>('/api/payments', orgAAdmin);
    expect(status).toBe(200);
    const ids = (data.data ?? []).map((p) => p.id);
    expect(ids).toContain(paymentOrgAId);
    expect(ids).not.toContain(paymentOrgBId);
  });

  it('org B admin sees the org B payment, never the org A one', async () => {
    const { status, data } = await apiGet<PaymentRow[]>('/api/payments', orgBAdmin);
    expect(status).toBe(200);
    const ids = (data.data ?? []).map((p) => p.id);
    expect(ids).toContain(paymentOrgBId);
    expect(ids).not.toContain(paymentOrgAId);
  });

  it('system admin (unscoped) sees both org payments', async () => {
    const { status, data } = await apiGet<PaymentRow[]>('/api/payments', sysAdmin);
    expect(status).toBe(200);
    const ids = (data.data ?? []).map((p) => p.id);
    expect(ids).toContain(paymentOrgAId);
    expect(ids).toContain(paymentOrgBId);
  });

  it('system admin scoped via ?organizationId sees only the matching org', async () => {
    const { status, data } = await apiGet<PaymentRow[]>(
      `/api/payments?organizationId=${orgAId}`,
      sysAdmin,
    );
    expect(status).toBe(200);
    const ids = (data.data ?? []).map((p) => p.id);
    expect(ids).toContain(paymentOrgAId);
    expect(ids).not.toContain(paymentOrgBId);
  });

  it('unauthenticated callers are rejected (auth gate, not a leak)', async () => {
    const { status } = await apiGet<PaymentRow[]>('/api/payments');
    expect(status).toBe(401);
  });
});
