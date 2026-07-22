/**
 * Tests for the automated account-data deletion service added in
 * task #251 (server/services/account-deletion.ts).
 *
 * Covers `executeAccountDeletion`:
 *   - Anonymizes every bowler row matching the email and clears stored
 *     payment-provider customer references
 *   - Deletes the matching user account row
 *   - Returns a structured audit summary with counts that match what
 *     was actually changed
 *   - Reports `user.deleted = false` with a reason when no user row
 *     matches the email (still scrubs bowler rows)
 *
 * Hits the real test database; cleans up after itself. Bowlers are
 * created without paymentCustomerId so the provider-deletion branch is a
 * no-op (and does not require live Square credentials).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectErrorLog, getCapturedErrorLogs } from '../helpers/expected-error-logs';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb } from '../setup/test-db';
const db = getTestDb();
import {
  users,
  bowlers,
  locations,
  leagues,
  bowlerLeagues,
  teams,
} from '@shared/schema';
import { executeAccountDeletion } from '../../server/services/account-deletion';
import { hashPassword } from '../../server/lib/password';
import * as paymentProviderFactory from '../../server/services/payment-provider-factory';
import { ProviderNotConfiguredError } from '../../server/services/payment-provider-factory';
import * as emailService from '../../server/services/email';
import { getBaselineOrgAId } from '../helpers';

const createdUserIds: number[] = [];
const createdBowlerIds: number[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
    createdBowlerIds.length = 0;
  }
  // Baseline org is preserved across runs (Task #607).
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vitest.local`;
}

// Task #607: every test attaches its scratch users/bowlers/leagues
// to the seeded vitest-org-a baseline. executeAccountDeletion is
// keyed by email (anonymises matching bowlers, deletes the matching
// user) — it has no last-admin or sole-occupant guard at this layer,
// so multiple tests sharing the baseline org never trip each other up.
async function makeOrg(): Promise<number> {
  return getBaselineOrgAId();
}

async function makeUser(email: string, organizationId: number): Promise<number> {
  const password = await hashPassword('vitest-deletion-pw');
  const [row] = await db
    .insert(users)
    .values({ email, password, name: 'Vitest Person', role: 'user', organizationId })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row.id;
}

async function makeBowler(email: string, organizationId: number): Promise<number> {
  const [row] = await db
    .insert(bowlers)
    .values({ name: 'Vitest Bowler', email, organizationId })
    .returning({ id: bowlers.id });
  createdBowlerIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Provider cleanup helpers (#316)
//
// The account-deletion service calls Square to remove the
// user's stored customer records. The original test suite intentionally
// skipped this branch by leaving paymentCustomerId
// null on every bowler, because exercising it for real would require
// live Square credentials. To get CI coverage of that loop
// without leaving the test database, we stub `getPaymentProvider` so
// each (locationId -> mock provider) wiring is local to a single test
// and the production cache is left untouched.
// ---------------------------------------------------------------------------

interface MockProvider {
  providerName: string;
  deleteCustomer: (customerId: string) => Promise<void>;
}

const createdLocationIds: number[] = [];
const createdLeagueIds: number[] = [];
const createdTeamIds: number[] = [];

async function makeTeam(leagueId: number): Promise<number> {
  // Use a per-call counter so multiple teams in one test get distinct
  // "number" values (the table has a unique index on (leagueId, number)).
  const num = createdTeamIds.length + 1;
  const [row] = await db
    .insert(teams)
    .values({ name: `Vitest Team ${num}`, number: num, leagueId })
    .returning({ id: teams.id });
  createdTeamIds.push(row.id);
  return row.id;
}

async function makeLocation(organizationId: number): Promise<number> {
  const [row] = await db
    .insert(locations)
    .values({ name: `Vitest Location ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, organizationId })
    .returning({ id: locations.id });
  createdLocationIds.push(row.id);
  return row.id;
}

async function makeLeague(organizationId: number, locationId: number): Promise<number> {
  const [row] = await db
    .insert(leagues)
    .values({
      name: `Vitest League ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      organizationId,
      locationId,
      // Required NOT NULL columns with no default.
      seasonStart: '2026-01-01',
      seasonEnd: '2026-12-31',
      weekDay: 'Monday',
    })
    .returning({ id: leagues.id });
  createdLeagueIds.push(row.id);
  return row.id;
}

async function makeBowlerWithCustomerIds(
  email: string,
  paymentCustomerId: string | null,
  _retiredCustomerId: string | null,
  organizationId: number,
  paymentProviderLocationId: number | null = null,
): Promise<number> {
  const [row] = await db
    .insert(bowlers)
    .values({
      name: 'Vitest Bowler',
      email,
      organizationId,
      paymentCustomerId,
      paymentProviderLocationId,
    })
    .returning({ id: bowlers.id });
  createdBowlerIds.push(row.id);
  return row.id;
}

async function linkBowlerToLeague(
  bowlerId: number,
  leagueId: number,
  teamId: number,
): Promise<void> {
  await db.insert(bowlerLeagues).values({ bowlerId, leagueId, teamId });
}

afterEach(async () => {
  // bowler_leagues cascade-deletes when its bowler row goes away, so
  // the existing afterEach handles those rows. Teams, leagues, and
  // locations need explicit cleanup since they outlive the bowler
  // graph.
  if (createdTeamIds.length > 0) {
    await db.delete(teams).where(inArray(teams.id, createdTeamIds));
    createdTeamIds.length = 0;
  }
  if (createdLeagueIds.length > 0) {
    await db.delete(leagues).where(inArray(leagues.id, createdLeagueIds));
    createdLeagueIds.length = 0;
  }
  if (createdLocationIds.length > 0) {
    await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    createdLocationIds.length = 0;
  }
});

describe('executeAccountDeletion — service', () => {
  // These tests run executeAccountDeletion with the default
  // notifyOnCompletion=true and do not stub the email helper, so the
  // real sendAccountDeletionConfirmation emits a SENDGRID_API_KEY-not-
  // configured [ERROR] line in CI. Allowlist it so the in-process
  // error-log guard (Task #746) doesn't fail these otherwise-green tests.
  beforeEach(() => {
    expectErrorLog(/Cannot send account-deletion confirmation/);
  });

  it('anonymizes matching bowlers and deletes the matching user', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('target');
    const userId = await makeUser(targetEmail, orgId);
    const bowlerOneId = await makeBowler(targetEmail, orgId);
    const bowlerTwoId = await makeBowler(targetEmail, orgId);
    const otherBowlerId = await makeBowler(uniqueEmail('other'), orgId);

    const summary = await executeAccountDeletion(targetEmail, adminId);

    expect(summary.email).toBe(targetEmail);
    expect(summary.executedBy).toBe(adminId);
    expect(summary.user.deleted).toBe(true);
    expect(summary.user.userId).toBe(userId);
    expect(summary.bowlers).toHaveLength(2);
    expect(summary.bowlers.every((b) => b.anonymized)).toBe(true);
    expect(summary.bowlers.map((b) => b.bowlerId).sort()).toEqual(
      [bowlerOneId, bowlerTwoId].sort(),
    );

    const [userAfter] = await db.select().from(users).where(eq(users.id, userId));
    expect(userAfter).toBeUndefined();

    const scrubbed = await db
      .select()
      .from(bowlers)
      .where(inArray(bowlers.id, [bowlerOneId, bowlerTwoId]));
    expect(scrubbed).toHaveLength(2);
    for (const b of scrubbed) {
      expect(b.email).toBeNull();
      expect(b.phone).toBeNull();
      expect(b.name).toBe('Deleted Bowler');
      expect(b.active).toBe(false);
      expect(b.paymentCustomerId).toBeNull();
    }

    // The unrelated bowler row must be untouched.
    const [other] = await db.select().from(bowlers).where(eq(bowlers.id, otherBowlerId));
    expect(other.email).not.toBeNull();
    expect(other.name).toBe('Vitest Bowler');
    expect(other.active).toBe(true);
  });

  it('still scrubs bowlers when no user account exists for the email', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('orphan-target');
    const bowlerId = await makeBowler(targetEmail, orgId);

    const summary = await executeAccountDeletion(targetEmail, adminId);

    expect(summary.user.deleted).toBe(false);
    expect(summary.user.userId).toBeNull();
    expect(summary.user.reason).toMatch(/no user account/i);
    expect(summary.bowlers).toHaveLength(1);
    expect(summary.bowlers[0].bowlerId).toBe(bowlerId);
    expect(summary.bowlers[0].anonymized).toBe(true);

    const [scrubbed] = await db.select().from(bowlers).where(eq(bowlers.id, bowlerId));
    expect(scrubbed.email).toBeNull();
    expect(scrubbed.name).toBe('Deleted Bowler');
  });

  it('reports zero work when no bowlers and no user match the email', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('nobody');

    const summary = await executeAccountDeletion(targetEmail, adminId);

    expect(summary.bowlers).toHaveLength(0);
    expect(summary.paymentProvider).toHaveLength(0);
    expect(summary.user.deleted).toBe(false);
    expect(summary.user.userId).toBeNull();
    expect(summary.emailChangeRequestsDeleted).toBe(0);
  });
});

describe('executeAccountDeletion — payment-provider cleanup (#316)', () => {
  let getPaymentProviderSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getPaymentProviderSpy = vi.spyOn(paymentProviderFactory, 'getPaymentProvider');
    // These tests run executeAccountDeletion with the default
    // notifyOnCompletion=true and do not stub the email helper, so the
    // real sendAccountDeletionConfirmation emits a SENDGRID_API_KEY-not-
    // configured [ERROR] line in CI. Allowlist it so the in-process
    // error-log guard (Task #746) doesn't fail these otherwise-green
    // tests. Harmless for the nested confirmation-email block, which
    // stubs the email helper (the matcher simply finds zero matches).
    expectErrorLog(/Cannot send account-deletion confirmation/);
  });

  afterEach(() => {
    getPaymentProviderSpy.mockRestore();
  });

  it('invokes deleteCustomer once per (provider, customerId) pair collected from the bowler→league→location join', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('provider-target');
    await makeUser(targetEmail, orgId);

    const locA = await makeLocation(orgId);
    const locB = await makeLocation(orgId);
    const leagueA = await makeLeague(orgId, locA);
    const leagueB = await makeLeague(orgId, locB);
    const teamA1 = await makeTeam(leagueA);
    const teamA2 = await makeTeam(leagueA);
    const teamA3 = await makeTeam(leagueA);
    const teamB = await makeTeam(leagueB);

    // Three bowlers under the same email — bowlerOne and bowlerThree
    // intentionally share the same paymentCustomerId ("sq-1") and
    // both reach locA, so the loop must DEDUPE that pair to a single
    // deleteCustomer call.
    //   bowlerOne:   sq-1, linked to leagueA + leagueB
    //                -> (locA,sq-1) + (locB,sq-1)
    //   bowlerTwo:   sq-2, linked to leagueA only -> (locA,sq-2)
    //   bowlerThree: sq-1 (DUPLICATE of bowlerOne's), linked to
    //                leagueA only
    //                -> (locA,sq-1) — must collapse into bowlerOne's
    //                target, not produce a 5th call
    const bowlerOne = await makeBowlerWithCustomerIds(targetEmail, 'sq-1', null, orgId);
    const bowlerTwo = await makeBowlerWithCustomerIds(targetEmail, 'sq-2', 'cp-2', orgId);
    const bowlerThree = await makeBowlerWithCustomerIds(targetEmail, 'sq-1', null, orgId);
    await linkBowlerToLeague(bowlerOne, leagueA, teamA1);
    await linkBowlerToLeague(bowlerOne, leagueB, teamB);
    await linkBowlerToLeague(bowlerTwo, leagueA, teamA2);
    await linkBowlerToLeague(bowlerThree, leagueA, teamA3);

    const deleteCustomer = vi.fn().mockResolvedValue(undefined);
    const provider: MockProvider = { providerName: 'square', deleteCustomer };
    getPaymentProviderSpy.mockResolvedValue(provider as unknown as Awaited<
      ReturnType<typeof paymentProviderFactory.getPaymentProvider>
    >);

    const summary = await executeAccountDeletion(targetEmail, adminId);

    // 4 distinct (locationId, customerId) targets above — bowlerThree's
    // (locA, sq-1) collapses into bowlerOne's, so still 4 calls and not
    // 5. The two sq-1 entries are for distinct locations (locA, locB).
    expect(deleteCustomer).toHaveBeenCalledTimes(3);
    const calledWith = deleteCustomer.mock.calls.map((c) => c[0]).sort();
    expect(calledWith).toEqual(['sq-1', 'sq-1', 'sq-2']);

    // Provider was resolved once per target, with the expected
    // locationIds — confirms the join-to-provider wiring.
    const resolvedLocationIds = (getPaymentProviderSpy.mock.calls as [number | null][])
      .map((c) => c[0])
      .sort();
    expect(resolvedLocationIds).toEqual([locA, locA, locB].sort());

    expect(summary.paymentProvider).toHaveLength(3);
    expect(summary.paymentProvider.every((p) => p.deleted)).toBe(true);
    expect(summary.paymentProvider.every((p) => p.providerName === 'square')).toBe(true);
    const pairs = summary.paymentProvider
      .map((p) => `${p.locationId}:${p.customerId}`)
      .sort();
    expect(pairs).toEqual(
      [
        `${locA}:sq-1`,
        `${locA}:sq-2`,
        `${locB}:sq-1`,
      ].sort(),
    );
  });

  it('continues with remaining targets and the user/bowler scrub when a provider call throws (e.g. NOT_FOUND)', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('provider-fail');
    const userId = await makeUser(targetEmail, orgId);

    const locA = await makeLocation(orgId);
    const locB = await makeLocation(orgId);
    const leagueA = await makeLeague(orgId, locA);
    const leagueB = await makeLeague(orgId, locB);
    const teamA = await makeTeam(leagueA);
    const teamB = await makeTeam(leagueB);

    const bowlerId = await makeBowlerWithCustomerIds(targetEmail, 'cust-x', null, orgId);
    await linkBowlerToLeague(bowlerId, leagueA, teamA);
    await linkBowlerToLeague(bowlerId, leagueB, teamB);

    // locA: provider raises a NOT_FOUND-style error (customer already
    // gone upstream). locB: provider succeeds. The overall deletion
    // must still finish: the second target is attempted and the
    // bowler/user are still anonymized + deleted.
    const failingDelete = vi
      .fn()
      .mockRejectedValue(new Error('NOT_FOUND: customer cust-x not found'));
    const succeedingDelete = vi.fn().mockResolvedValue(undefined);
    const failingProvider: MockProvider = { providerName: 'square', deleteCustomer: failingDelete };
    const succeedingProvider: MockProvider = {
      providerName: 'square',
      deleteCustomer: succeedingDelete,
    };
    getPaymentProviderSpy.mockImplementation(async (locationId: number | null) => {
      if (locationId === locA) return failingProvider as unknown as Awaited<
        ReturnType<typeof paymentProviderFactory.getPaymentProvider>
      >;
      return succeedingProvider as unknown as Awaited<
        ReturnType<typeof paymentProviderFactory.getPaymentProvider>
      >;
    });

    const summary = await executeAccountDeletion(targetEmail, adminId);

    expect(failingDelete).toHaveBeenCalledTimes(1);
    expect(succeedingDelete).toHaveBeenCalledTimes(1);

    expect(summary.paymentProvider).toHaveLength(2);
    const failedEntry = summary.paymentProvider.find((p) => p.locationId === locA)!;
    const okEntry = summary.paymentProvider.find((p) => p.locationId === locB)!;
    expect(failedEntry.deleted).toBe(false);
    expect(failedEntry.error).toMatch(/NOT_FOUND/);
    expect(okEntry.deleted).toBe(true);
    expect(okEntry.error).toBeUndefined();

    // The downstream cleanup must not have been short-circuited by
    // the provider failure.
    expect(summary.bowlers).toHaveLength(1);
    expect(summary.bowlers[0].anonymized).toBe(true);
    expect(summary.user.deleted).toBe(true);
    expect(summary.user.userId).toBe(userId);

    const [userAfter] = await db.select().from(users).where(eq(users.id, userId));
    expect(userAfter).toBeUndefined();
    const [bowlerAfter] = await db.select().from(bowlers).where(eq(bowlers.id, bowlerId));
    expect(bowlerAfter.email).toBeNull();
    expect(bowlerAfter.paymentCustomerId).toBeNull();
  });

  // Task #346: bowlers now record `paymentProviderLocationId` at the
  // time the customer record is first written. The deletion service
  // uses that column to target exactly one processor per saved card
  // instead of fanning out across every league-reachable location.
  // The next two tests pin that contract.
  it('targets only the recorded paymentProviderLocationId when present, ignoring other league-reachable locations', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('origin-recorded');
    await makeUser(targetEmail, orgId);

    // Two locations the bowler is reachable through, but the
    // customer record was originally created at locA.
    const locA = await makeLocation(orgId);
    const locB = await makeLocation(orgId);
    const leagueA = await makeLeague(orgId, locA);
    const leagueB = await makeLeague(orgId, locB);
    const teamA = await makeTeam(leagueA);
    const teamB = await makeTeam(leagueB);
    const bowlerId = await makeBowlerWithCustomerIds(
      targetEmail,
      'sq-recorded',
      null,
      orgId,
      locA, // <- origin recorded
    );
    await linkBowlerToLeague(bowlerId, leagueA, teamA);
    await linkBowlerToLeague(bowlerId, leagueB, teamB);

    const deleteCustomer = vi.fn().mockResolvedValue(undefined);
    const provider: MockProvider = { providerName: 'square', deleteCustomer };
    getPaymentProviderSpy.mockResolvedValue(provider as unknown as Awaited<
      ReturnType<typeof paymentProviderFactory.getPaymentProvider>
    >);

    const summary = await executeAccountDeletion(targetEmail, adminId);

    // Only one provider call — locA — and the spurious (locB, sq-recorded)
    // entry that the legacy fan-out would have produced is gone.
    expect(deleteCustomer).toHaveBeenCalledTimes(1);
    expect(deleteCustomer).toHaveBeenCalledWith('sq-recorded');
    const resolvedLocationIds = (getPaymentProviderSpy.mock.calls as [number | null][])
      .map((c) => c[0]);
    expect(resolvedLocationIds).toEqual([locA]);

    expect(summary.paymentProvider).toHaveLength(1);
    expect(summary.paymentProvider[0]).toMatchObject({
      locationId: locA,
      customerId: 'sq-recorded',
      deleted: true,
    });
    // Audit summary must NOT contain a (locB, sq-recorded) failure
    // record like the pre-#346 noise.
    expect(
      summary.paymentProvider.find((p) => p.locationId === locB),
    ).toBeUndefined();
  });

  it('mixes recorded-origin bowlers and legacy (NULL) bowlers in the same deletion', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('mixed-origin');
    await makeUser(targetEmail, orgId);

    const locA = await makeLocation(orgId);
    const locB = await makeLocation(orgId);
    const leagueA = await makeLeague(orgId, locA);
    const leagueB = await makeLeague(orgId, locB);
    const teamA = await makeTeam(leagueA);
    const teamB = await makeTeam(leagueB);

    // Bowler 1: modern row — origin = locA, reachable through locA + locB.
    //           Should produce ONLY (locA, sq-modern).
    const modernBowler = await makeBowlerWithCustomerIds(
      targetEmail,
      'sq-modern',
      null,
      orgId,
      locA,
    );
    await linkBowlerToLeague(modernBowler, leagueA, teamA);
    await linkBowlerToLeague(modernBowler, leagueB, teamB);

    // Bowler 2: legacy row — origin NULL, reachable through locA + locB.
    //           Falls back to the join: produces (locA, sq-legacy)
    //           and (locB, sq-legacy).
    const legacyBowler = await makeBowlerWithCustomerIds(
      targetEmail,
      'sq-legacy',
      null,
      orgId,
      null,
    );
    const teamA2 = await makeTeam(leagueA);
    const teamB2 = await makeTeam(leagueB);
    await linkBowlerToLeague(legacyBowler, leagueA, teamA2);
    await linkBowlerToLeague(legacyBowler, leagueB, teamB2);

    const deleteCustomer = vi.fn().mockResolvedValue(undefined);
    const provider: MockProvider = { providerName: 'square', deleteCustomer };
    getPaymentProviderSpy.mockResolvedValue(provider as unknown as Awaited<
      ReturnType<typeof paymentProviderFactory.getPaymentProvider>
    >);

    const summary = await executeAccountDeletion(targetEmail, adminId);

    // 3 calls total: 1 from modernBowler (locA only) + 2 from
    // legacyBowler (locA + locB). The locA call for modernBowler is
    // for sq-modern, distinct from sq-legacy, so no dedup collapse.
    expect(deleteCustomer).toHaveBeenCalledTimes(3);
    const pairs = summary.paymentProvider
      .map((p) => `${p.locationId}:${p.customerId}`)
      .sort();
    expect(pairs).toEqual(
      [
        `${locA}:sq-modern`,
        `${locA}:sq-legacy`,
        `${locB}:sq-legacy`,
      ].sort(),
    );
    expect(summary.paymentProvider.every((p) => p.deleted)).toBe(true);
  });

  // --------------------------------------------------------------------
  // Tasks #349 + #351: post-deletion confirmation email.
  //
  // #349 wired the third `notifyOnCompletion` argument (default true)
  // and the `summary.confirmationEmail` audit field. #351 pinned the
  // contract with `sendAccountDeletionConfirmation` (called once with a
  // payload whose counts match the summary; SendGrid failures never
  // roll back the GDPR scrub; thrown exceptions are caught and logged).
  //
  // Originally this lived in two describe blocks of 4 + 3 tests with
  // overlapping happy / soft-fail / hard-fail coverage. Consolidated
  // to four tests that, between them, cover every behavior:
  //   - happy + payload  : default notify path, helper called once with
  //                         counts that match the summary (sent=true)
  //   - suppressed       : notifyOnCompletion=false skips SendGrid
  //   - returns false    : soft failure → recorded, scrub completes
  //   - throws + logged  : hard failure → caught, recorded, logged at
  //                         ERROR level, scrub completes
  // --------------------------------------------------------------------
  describe('confirmation email (#349, #351)', () => {
    let sendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      sendSpy = vi.spyOn(emailService, 'sendAccountDeletionConfirmation');
    });

    afterEach(() => {
      sendSpy.mockRestore();
    });

    it('default notify path: calls sendAccountDeletionConfirmation once with a payload whose counts match the summary', async () => {
      const orgId = await makeOrg();
      const adminId = await makeUser(uniqueEmail('admin'), orgId);
      const targetEmail = uniqueEmail('happy-payload');
      await makeUser(targetEmail, orgId);

      // Two bowlers + one payment-provider customer-id so the payload
      // counts are non-trivial (catches a regression where the call
      // site hard-codes 1 or forgets a count).
      const locA = await makeLocation(orgId);
      const leagueA = await makeLeague(orgId, locA);
      const teamA = await makeTeam(leagueA);
      const bowlerA = await makeBowlerWithCustomerIds(targetEmail, 'cust-happy-1', null, orgId);
      await linkBowlerToLeague(bowlerA, leagueA, teamA);
      await makeBowler(targetEmail, orgId);

      // Square call must succeed so paymentProviderRecordsDeleted=1.
      const fakeProvider = {
        deleteCustomer: vi.fn().mockResolvedValue(undefined),
      };
      getPaymentProviderSpy.mockResolvedValue(fakeProvider as unknown as Awaited<
        ReturnType<typeof paymentProviderFactory.getPaymentProvider>
      >);

      sendSpy.mockResolvedValue(true);

      const summary = await executeAccountDeletion(targetEmail, adminId);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(summary.confirmationEmail).toEqual({
        sent: true,
        suppressedByUser: false,
      });
      const [emailArg, payloadArg] = sendSpy.mock.calls[0]!;
      expect(emailArg).toBe(targetEmail);

      // The payload that lands in the email body must agree with the
      // numbers the admin sees in the audit summary — otherwise the
      // user gets a misleading confirmation.
      const bowlersAnonymized = summary.bowlers.filter((b) => b.anonymized).length;
      const providerDeletes = summary.paymentProvider.filter((p) => p.deleted).length;
      expect(payloadArg).toMatchObject({
        bowlersAnonymized,
        userAccountDeleted: summary.user.deleted,
        paymentProviderRecordsDeleted: providerDeletes,
        emailChangeRequestsDeleted: summary.emailChangeRequestsDeleted,
        executedAt: summary.executedAt,
      });
      expect(bowlersAnonymized).toBeGreaterThanOrEqual(2);
      expect(providerDeletes).toBe(1);
      expect(summary.confirmationEmail).toEqual({ sent: true, suppressedByUser: false });
    });

    it('skips the SendGrid call and marks suppressedByUser when notifyOnCompletion=false', async () => {
      const orgId = await makeOrg();
      const adminId = await makeUser(uniqueEmail('admin'), orgId);
      const targetEmail = uniqueEmail('opt-out');
      await makeUser(targetEmail, orgId);
      await makeBowler(targetEmail, orgId);

      // Stub sendgrid so even if the gate were wrong, no real email
      // would leave the test environment.
      sendSpy.mockResolvedValue(true);

      const summary = await executeAccountDeletion(targetEmail, adminId, false);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(summary.confirmationEmail).toEqual({
        sent: false,
        suppressedByUser: true,
      });
      // The deletion itself must still happen — opting out of the
      // confirmation email is unrelated to the actual scrub.
      expect(summary.user.deleted).toBe(true);
      expect(summary.bowlers[0].anonymized).toBe(true);
    });

    it('soft failure: SendGrid returns false → records error, scrub still completes (no rollback)', async () => {
      const orgId = await makeOrg();
      const adminId = await makeUser(uniqueEmail('admin'), orgId);
      const targetEmail = uniqueEmail('notify-returns-false');
      await makeUser(targetEmail, orgId);
      await makeBowler(targetEmail, orgId);

      sendSpy.mockResolvedValue(false);

      // Critically: this call must not throw. A SendGrid outage is
      // not allowed to roll back the GDPR scrub.
      const summary = await executeAccountDeletion(targetEmail, adminId, true);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(summary.confirmationEmail?.sent).toBe(false);
      expect(summary.confirmationEmail?.suppressedByUser).toBe(false);
      // Distinct, non-empty error string so the admin UI shows
      // something useful in the "failed to send" pill.
      expect(summary.confirmationEmail?.error).toMatch(/SendGrid send returned false/);
      // Every load-bearing field on the summary is still populated.
      expect(summary.executedAt).toEqual(expect.any(String));
      expect(summary.executedBy).toBe(adminId);
      expect(summary.email).toBe(targetEmail);
      expect(summary.user.deleted).toBe(true);
      expect(summary.bowlers.length).toBeGreaterThan(0);
      expect(summary.bowlers.every((b) => b.anonymized)).toBe(true);
    });

    it('hard failure: SendGrid throws → caught, recorded, logged at ERROR, scrub still completes', async () => {
      // This test name says it: the confirmation-email failure is logged at [ERROR] on purpose.
      expectErrorLog(/Account-deletion confirmation email threw/);
      const orgId = await makeOrg();
      const adminId = await makeUser(uniqueEmail('admin'), orgId);
      const targetEmail = uniqueEmail('notify-throws');
      await makeUser(targetEmail, orgId);
      await makeBowler(targetEmail, orgId);

      sendSpy.mockRejectedValue(new Error('SendGrid hard failure: connection reset'));

      // The whole point of catching the throw inside the service is
      // so a flaky email provider can't masquerade as a failed
      // deletion. If a future refactor lets the rejection bubble out,
      // this `await` will throw and the test will fail loudly.
      const summary = await executeAccountDeletion(targetEmail, adminId, true);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      // The thrown message lands on the audit summary so admins (and
      // the #350 UI) can see WHY the email didn't go.
      expect(summary.confirmationEmail?.sent).toBe(false);
      expect(summary.confirmationEmail?.suppressedByUser).toBe(false);
      expect(summary.confirmationEmail?.error).toMatch(/connection reset/);
      // GDPR scrub still completed end-to-end despite the email blowup.
      expect(summary.user.deleted).toBe(true);
      expect(summary.bowlers.length).toBeGreaterThan(0);
      expect(summary.bowlers.every((b) => b.anonymized)).toBe(true);

      // And the same throw was logged at ERROR level with both the
      // helpful prefix and the underlying error message so on-call
      // can trace it. The in-process error-log guard (Task #746)
      // suppresses *declared-expected* [ERROR] lines from stdout to
      // keep green runs quiet, so we assert against the guard's
      // captured-line buffer (which records the line regardless of
      // suppression) rather than spying on process.stdout directly.
      const errorLogged = getCapturedErrorLogs().some(
        (line) =>
          /\[ERROR\]/.test(line) &&
          /Account-deletion confirmation email threw/.test(line) &&
          /connection reset/.test(line),
      );
      expect(errorLogged).toBe(true);
    });
  });

  it('records ProviderNotConfiguredError without aborting and proceeds to anonymize', async () => {
    const orgId = await makeOrg();
    const adminId = await makeUser(uniqueEmail('admin'), orgId);
    const targetEmail = uniqueEmail('provider-unconfigured');
    await makeUser(targetEmail, orgId);

    const locA = await makeLocation(orgId);
    const leagueA = await makeLeague(orgId, locA);
    const teamA = await makeTeam(leagueA);
    const bowlerId = await makeBowlerWithCustomerIds(targetEmail, 'cust-y', null, orgId);
    await linkBowlerToLeague(bowlerId, leagueA, teamA);

    getPaymentProviderSpy.mockRejectedValue(
      new ProviderNotConfiguredError('Square is not configured for location ' + locA, locA),
    );

    const summary = await executeAccountDeletion(targetEmail, adminId);

    expect(summary.paymentProvider).toHaveLength(1);
    expect(summary.paymentProvider[0].deleted).toBe(false);
    expect(summary.paymentProvider[0].error).toMatch(/not configured/i);
    expect(summary.bowlers[0].anonymized).toBe(true);
    expect(summary.user.deleted).toBe(true);
  });
});
