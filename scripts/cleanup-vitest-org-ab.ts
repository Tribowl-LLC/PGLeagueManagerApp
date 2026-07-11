/**
 * Task #718: Permanently delete the two leftover baseline organizations
 * `Vitest Org A` and `Vitest Org B` from the shared dev DB.
 *
 * Now that Task #700 has isolated test databases per worker, these
 * baseline orgs (slugs `vitest-org-a` / `vitest-org-b`) are no longer
 * re-seeded against the shared dev DB and are stale fixture rows
 * cluttering the system-admin Organizations page. This script removes
 * them and all their dependent rows in a single transaction.
 *
 * Scoped strictly to the two named orgs by exact name match — any other
 * row count is a sanity-check failure and aborts.
 *
 * Behaviour:
 *   - Pre-counts every dependent / cascaded child table so the
 *     completion notes can record per-table counts (sessions, scores,
 *     payments, registrations, saved cards, payment links,
 *     teams, games, email_change_requests, etc.) before the deletes
 *     run and the rows disappear.
 *   - Deletes leaf-first inside one transaction.
 *   - Post-verifies every FK-referencing table (org / user / bowler /
 *     league / location id columns) to confirm zero residual rows.
 *
 * Safety:
 *   - Hard-refuses to run when NODE_ENV=production or REPLIT_DEPLOYMENT
 *     is set, *unless* ALLOW_TEST_CLEANUP=1 is passed.
 *   - `--dry-run` prints planned counts and exits without touching the
 *     DB. Default mode additionally requires ALLOW_TEST_CLEANUP=1.
 *   - Single transaction; failure rolls everything back.
 *
 * Usage:
 *   npx tsx scripts/cleanup-vitest-org-ab.ts --dry-run
 *   ALLOW_TEST_CLEANUP=1 npx tsx scripts/cleanup-vitest-org-ab.ts
 */
import { count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db, pool } from '../server/db';
import {
  organizations,
  users,
  bowlers,
  leagues,
  locations,
  teams,
  games,
  scores,
  payments,
  paymentSchedules,
  bowlerLeagues,
  bowlerPaymentLinks,
  leagueRegistrations,
  leagueRegistrationQuestions,
  emailChangeRequests,
  applePayJobs,
  applePayJobItems,
  deletionRequests,
  adminEmailChangeAudits,
  adminProfileEditAudits,
  adminPasswordResetAudits,
  adminRoleChangeAudits,
  orphanCleanupAudits,
} from '@shared/schema';
import { isReplitDeploymentValue } from '../server/utils/replit-env';
import { assertSafeDatabaseHost } from '../server/utils/db-safety';
import type { PgTable } from 'drizzle-orm/pg-core';

const TARGET_NAMES = ['Vitest Org A', 'Vitest Org B'] as const;

function assertSafeEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV;
  const allowOverride = process.env.ALLOW_TEST_CLEANUP === '1';
  const isReplitDeployment = isReplitDeploymentValue(process.env.REPLIT_DEPLOYMENT);
  if (allowOverride) return;
  if (nodeEnv === 'production' || isReplitDeployment) {
    throw new Error(
      'Refusing to run cleanup-vitest-org-ab: NODE_ENV=production or REPLIT_DEPLOYMENT is set. ' +
        'Set ALLOW_TEST_CLEANUP=1 only if you really intend to delete from this database.',
    );
  }
}

async function countWhere(table: PgTable, where: SQL | undefined): Promise<number> {
  if (!where) return 0;
  const r = await db.select({ value: count() }).from(table).where(where);
  return Number(r[0]?.value ?? 0);
}

async function main(): Promise<void> {
  assertSafeEnvironment();
  assertSafeDatabaseHost('cleanup-vitest-org-ab');

  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.env.ALLOW_TEST_CLEANUP === '1';
  if (!dryRun && !confirmed) {
    throw new Error(
      'Refusing to run without ALLOW_TEST_CLEANUP=1 (or --dry-run).',
    );
  }

  // 1. Locate the two orgs by exact name match.
  const doomed = await db
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(or(eq(organizations.name, TARGET_NAMES[0]), eq(organizations.name, TARGET_NAMES[1])));

  if (doomed.length === 0) {
    console.log('No matching organizations found. Nothing to do.');
    await pool.end();
    return;
  }

  const byName = new Map<string, typeof doomed>();
  for (const o of doomed) {
    const arr = byName.get(o.name) ?? [];
    arr.push(o);
    byName.set(o.name, arr);
  }
  for (const [name, rows] of byName) {
    if (rows.length > 1) {
      throw new Error(
        `Refusing to proceed: name "${name}" matches ${rows.length} rows: ${rows.map((r) => `${r.id}:${r.slug}`).join(', ')}`,
      );
    }
  }

  const doomedIds = doomed.map((o) => o.id);
  console.log(`Found ${doomed.length} organization(s) to delete:`);
  for (const o of doomed) console.log(`  ${o.id}  ${o.slug}  ${o.name}`);

  // 2. Sanity-check attached users/bowlers and resolve dependent ids.
  const userRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.organizationId, doomedIds));
  const bowlerRows = await db
    .select({ id: bowlers.id, email: bowlers.email })
    .from(bowlers)
    .where(inArray(bowlers.organizationId, doomedIds));
  const leagueRows = await db
    .select({ id: leagues.id })
    .from(leagues)
    .where(inArray(leagues.organizationId, doomedIds));
  const locationRows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(inArray(locations.organizationId, doomedIds));

  const userIds = userRows.map((r) => r.id);
  const bowlerIds = bowlerRows.map((r) => r.id);
  const leagueIds = leagueRows.map((r) => r.id);
  const locationIds = locationRows.map((r) => r.id);

  const isFixtureEmail = (email: string | null): boolean => {
    if (!email) return true;
    const e = email.toLowerCase();
    return (
      e.endsWith('@vitest.local') ||
      e.endsWith('@example.com') ||
      e.endsWith('@e2e.test') ||
      e.endsWith('@test.local')
    );
  };
  const realUsers = userRows.filter((u) => !isFixtureEmail(u.email));
  const realBowlers = bowlerRows.filter((b) => !isFixtureEmail(b.email));
  if (realUsers.length > 0 || realBowlers.length > 0) {
    throw new Error(
      `Refusing to proceed: found non-fixture-shaped emails. ` +
        `users=${JSON.stringify(realUsers.slice(0, 5))} bowlers=${JSON.stringify(realBowlers.slice(0, 5))}`,
    );
  }

  console.log(
    `  -> ${userIds.length} users, ${bowlerIds.length} bowlers, ${leagueIds.length} leagues, ${locationIds.length} locations (all fixture-shaped)`,
  );

  // 3. Pre-count cascaded dependents.
  const inOrgs = doomedIds.length > 0 ? inArray(organizations.id, doomedIds) : undefined;
  void inOrgs;
  const orgFilter = doomedIds.length > 0;
  const userFilter = userIds.length > 0;
  const bowlerFilter = bowlerIds.length > 0;
  const leagueFilter = leagueIds.length > 0;
  const locationFilter = locationIds.length > 0;

  const counts = {
    users: userFilter ? await countWhere(users, inArray(users.organizationId, doomedIds)) : 0,
    bowlers: orgFilter ? await countWhere(bowlers, inArray(bowlers.organizationId, doomedIds)) : 0,
    leagues: orgFilter ? await countWhere(leagues, inArray(leagues.organizationId, doomedIds)) : 0,
    locations: orgFilter ? await countWhere(locations, inArray(locations.organizationId, doomedIds)) : 0,
    bowlerPaymentLinks: orgFilter
      ? await countWhere(bowlerPaymentLinks, inArray(bowlerPaymentLinks.organizationId, doomedIds))
      : 0,
    leagueRegistrations: orgFilter
      ? await countWhere(leagueRegistrations, inArray(leagueRegistrations.organizationId, doomedIds))
      : 0,
    applePayJobItems: orgFilter
      ? await countWhere(applePayJobItems, inArray(applePayJobItems.organizationId, doomedIds))
      : 0,
    teams: leagueFilter ? await countWhere(teams, inArray(teams.leagueId, leagueIds)) : 0,
    games: leagueFilter ? await countWhere(games, inArray(games.leagueId, leagueIds)) : 0,
    scores: bowlerFilter ? await countWhere(scores, inArray(scores.bowlerId, bowlerIds)) : 0,
    payments:
      leagueFilter || bowlerFilter
        ? await countWhere(
            payments,
            leagueFilter && bowlerFilter
              ? or(inArray(payments.leagueId, leagueIds), inArray(payments.bowlerId, bowlerIds))
              : leagueFilter
                ? inArray(payments.leagueId, leagueIds)
                : inArray(payments.bowlerId, bowlerIds),
          )
        : 0,
    paymentSchedules:
      leagueFilter || bowlerFilter
        ? await countWhere(
            paymentSchedules,
            leagueFilter && bowlerFilter
              ? or(
                  inArray(paymentSchedules.leagueId, leagueIds),
                  inArray(paymentSchedules.bowlerId, bowlerIds),
                )
              : leagueFilter
                ? inArray(paymentSchedules.leagueId, leagueIds)
                : inArray(paymentSchedules.bowlerId, bowlerIds),
          )
        : 0,
    bowlerLeagues:
      leagueFilter || bowlerFilter
        ? await countWhere(
            bowlerLeagues,
            leagueFilter && bowlerFilter
              ? or(
                  inArray(bowlerLeagues.leagueId, leagueIds),
                  inArray(bowlerLeagues.bowlerId, bowlerIds),
                )
              : leagueFilter
                ? inArray(bowlerLeagues.leagueId, leagueIds)
                : inArray(bowlerLeagues.bowlerId, bowlerIds),
          )
        : 0,
    leagueRegistrationQuestions: leagueFilter
      ? await countWhere(
          leagueRegistrationQuestions,
          inArray(leagueRegistrationQuestions.leagueId, leagueIds),
        )
      : 0,
    emailChangeRequests: userFilter
      ? await countWhere(emailChangeRequests, inArray(emailChangeRequests.userId, userIds))
      : 0,
    emailChangeAudits: userFilter
      ? await countWhere(
          adminEmailChangeAudits,
          or(
            inArray(adminEmailChangeAudits.targetUserId, userIds),
            inArray(adminEmailChangeAudits.actorUserId, userIds),
          ),
        )
      : 0,
    profileEditAudits: userFilter
      ? await countWhere(
          adminProfileEditAudits,
          or(
            inArray(adminProfileEditAudits.targetUserId, userIds),
            inArray(adminProfileEditAudits.actorUserId, userIds),
          ),
        )
      : 0,
    passwordResetAudits: userFilter
      ? await countWhere(
          adminPasswordResetAudits,
          or(
            inArray(adminPasswordResetAudits.targetUserId, userIds),
            inArray(adminPasswordResetAudits.actorUserId, userIds),
          ),
        )
      : 0,
    roleChangeAudits: userFilter
      ? await countWhere(
          adminRoleChangeAudits,
          or(
            inArray(adminRoleChangeAudits.targetUserId, userIds),
            inArray(adminRoleChangeAudits.actorUserId, userIds),
          ),
        )
      : 0,
    orphanCleanupAudits: userFilter
      ? await countWhere(orphanCleanupAudits, inArray(orphanCleanupAudits.adminUserId, userIds))
      : 0,
    applePayJobsCreatedByToNull: userFilter
      ? await countWhere(applePayJobs, inArray(applePayJobs.createdBy, userIds))
      : 0,
    deletionRequestsReviewedByToNull: userFilter
      ? await countWhere(deletionRequests, inArray(deletionRequests.reviewedBy, userIds))
      : 0,
    usersBowlerIdToNull: bowlerFilter
      ? await countWhere(users, inArray(users.bowlerId, bowlerIds))
      : 0,
    applePayJobItemsLocationIdToNull: locationFilter
      ? await countWhere(applePayJobItems, inArray(applePayJobItems.locationId, locationIds))
      : 0,
  };

  console.log('\nPre-delete dependent row counts:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(36)} ${v}`);

  if (dryRun) {
    console.log('\n[dry-run] Not deleting. Re-run with ALLOW_TEST_CLEANUP=1 to apply.');
    await pool.end();
    return;
  }

  // 4. Apply deletes inside one transaction (leaf-first).
  await db.transaction(async (tx) => {
    if (userIds.length > 0) {
      await tx
        .delete(adminEmailChangeAudits)
        .where(inArray(adminEmailChangeAudits.targetUserId, userIds));
      await tx
        .delete(adminEmailChangeAudits)
        .where(inArray(adminEmailChangeAudits.actorUserId, userIds));
      await tx
        .delete(adminProfileEditAudits)
        .where(inArray(adminProfileEditAudits.targetUserId, userIds));
      await tx
        .delete(adminProfileEditAudits)
        .where(inArray(adminProfileEditAudits.actorUserId, userIds));
      await tx
        .delete(adminPasswordResetAudits)
        .where(inArray(adminPasswordResetAudits.targetUserId, userIds));
      await tx
        .delete(adminPasswordResetAudits)
        .where(inArray(adminPasswordResetAudits.actorUserId, userIds));
      await tx
        .delete(adminRoleChangeAudits)
        .where(inArray(adminRoleChangeAudits.targetUserId, userIds));
      await tx
        .delete(adminRoleChangeAudits)
        .where(inArray(adminRoleChangeAudits.actorUserId, userIds));
      await tx
        .delete(orphanCleanupAudits)
        .where(inArray(orphanCleanupAudits.adminUserId, userIds));
      await tx
        .update(applePayJobs)
        .set({ createdBy: null })
        .where(inArray(applePayJobs.createdBy, userIds));
      await tx
        .update(deletionRequests)
        .set({ reviewedBy: null })
        .where(inArray(deletionRequests.reviewedBy, userIds));
    }

    if (bowlerIds.length > 0) {
      await tx.update(users).set({ bowlerId: null }).where(inArray(users.bowlerId, bowlerIds));
    }

    if (locationIds.length > 0) {
      await tx
        .update(applePayJobItems)
        .set({ locationId: null })
        .where(inArray(applePayJobItems.locationId, locationIds));
    }

    await tx.delete(leagues).where(inArray(leagues.organizationId, doomedIds));
    await tx.delete(bowlers).where(inArray(bowlers.organizationId, doomedIds));
    await tx.delete(users).where(inArray(users.organizationId, doomedIds));
    await tx.delete(locations).where(inArray(locations.organizationId, doomedIds));
    await tx.delete(organizations).where(inArray(organizations.id, doomedIds));
  });

  // 5. Post-delete verification — every FK-referencing column tied to
  // the doomed org / user / bowler / league / location IDs must be zero
  // (or have been NULL'd where the FK was set-null on delete).
  const postChecks: Array<[string, number]> = [
    // Org-id FK columns.
    ['organizations.id', await countWhere(organizations, inArray(organizations.id, doomedIds))],
    ['users.organization_id', await countWhere(users, inArray(users.organizationId, doomedIds))],
    [
      'bowlers.organization_id',
      await countWhere(bowlers, inArray(bowlers.organizationId, doomedIds)),
    ],
    [
      'leagues.organization_id',
      await countWhere(leagues, inArray(leagues.organizationId, doomedIds)),
    ],
    [
      'locations.organization_id',
      await countWhere(locations, inArray(locations.organizationId, doomedIds)),
    ],
    [
      'bowler_payment_links.organization_id',
      await countWhere(bowlerPaymentLinks, inArray(bowlerPaymentLinks.organizationId, doomedIds)),
    ],
    [
      'league_registrations.organization_id',
      await countWhere(leagueRegistrations, inArray(leagueRegistrations.organizationId, doomedIds)),
    ],
    [
      'apple_pay_job_items.organization_id',
      await countWhere(applePayJobItems, inArray(applePayJobItems.organizationId, doomedIds)),
    ],
    [
      'orphan_cleanup_audits.organization_id',
      await countWhere(orphanCleanupAudits, inArray(orphanCleanupAudits.organizationId, doomedIds)),
    ],
    [
      'orphan_cleanup_audits.previous_organization_id',
      await countWhere(
        orphanCleanupAudits,
        inArray(orphanCleanupAudits.previousOrganizationId, doomedIds),
      ),
    ],
    [
      'admin_password_reset_audits.organization_id',
      await countWhere(
        adminPasswordResetAudits,
        inArray(adminPasswordResetAudits.organizationId, doomedIds),
      ),
    ],
    [
      'admin_role_change_audits.organization_id',
      await countWhere(
        adminRoleChangeAudits,
        inArray(adminRoleChangeAudits.organizationId, doomedIds),
      ),
    ],
    // User-id FK columns.
    ...(userFilter
      ? ([
          [
            'email_change_requests.user_id',
            await countWhere(emailChangeRequests, inArray(emailChangeRequests.userId, userIds)),
          ],
          [
            'admin_email_change_audits.target_user_id',
            await countWhere(
              adminEmailChangeAudits,
              inArray(adminEmailChangeAudits.targetUserId, userIds),
            ),
          ],
          [
            'admin_email_change_audits.actor_user_id',
            await countWhere(
              adminEmailChangeAudits,
              inArray(adminEmailChangeAudits.actorUserId, userIds),
            ),
          ],
          [
            'admin_profile_edit_audits.target_user_id',
            await countWhere(
              adminProfileEditAudits,
              inArray(adminProfileEditAudits.targetUserId, userIds),
            ),
          ],
          [
            'admin_profile_edit_audits.actor_user_id',
            await countWhere(
              adminProfileEditAudits,
              inArray(adminProfileEditAudits.actorUserId, userIds),
            ),
          ],
          [
            'admin_password_reset_audits.target_user_id',
            await countWhere(
              adminPasswordResetAudits,
              inArray(adminPasswordResetAudits.targetUserId, userIds),
            ),
          ],
          [
            'admin_password_reset_audits.actor_user_id',
            await countWhere(
              adminPasswordResetAudits,
              inArray(adminPasswordResetAudits.actorUserId, userIds),
            ),
          ],
          [
            'admin_role_change_audits.target_user_id',
            await countWhere(
              adminRoleChangeAudits,
              inArray(adminRoleChangeAudits.targetUserId, userIds),
            ),
          ],
          [
            'admin_role_change_audits.actor_user_id',
            await countWhere(
              adminRoleChangeAudits,
              inArray(adminRoleChangeAudits.actorUserId, userIds),
            ),
          ],
          [
            'orphan_cleanup_audits.admin_user_id',
            await countWhere(orphanCleanupAudits, inArray(orphanCleanupAudits.adminUserId, userIds)),
          ],
          [
            'apple_pay_jobs.created_by',
            await countWhere(applePayJobs, inArray(applePayJobs.createdBy, userIds)),
          ],
          [
            'deletion_requests.reviewed_by',
            await countWhere(deletionRequests, inArray(deletionRequests.reviewedBy, userIds)),
          ],
        ] satisfies Array<[string, number]>)
      : []),
    // Bowler-id FK columns.
    ...(bowlerFilter
      ? ([
          ['users.bowler_id', await countWhere(users, inArray(users.bowlerId, bowlerIds))],
          ['scores.bowler_id', await countWhere(scores, inArray(scores.bowlerId, bowlerIds))],
          [
            'bowler_leagues.bowler_id',
            await countWhere(bowlerLeagues, inArray(bowlerLeagues.bowlerId, bowlerIds)),
          ],
          ['payments.bowler_id', await countWhere(payments, inArray(payments.bowlerId, bowlerIds))],
          [
            'payment_schedules.bowler_id',
            await countWhere(paymentSchedules, inArray(paymentSchedules.bowlerId, bowlerIds)),
          ],
        ] satisfies Array<[string, number]>)
      : []),
    // League-id FK columns.
    ...(leagueFilter
      ? ([
          ['teams.league_id', await countWhere(teams, inArray(teams.leagueId, leagueIds))],
          ['games.league_id', await countWhere(games, inArray(games.leagueId, leagueIds))],
          ['payments.league_id', await countWhere(payments, inArray(payments.leagueId, leagueIds))],
          [
            'payment_schedules.league_id',
            await countWhere(paymentSchedules, inArray(paymentSchedules.leagueId, leagueIds)),
          ],
          [
            'bowler_leagues.league_id',
            await countWhere(bowlerLeagues, inArray(bowlerLeagues.leagueId, leagueIds)),
          ],
          [
            'league_registration_questions.league_id',
            await countWhere(
              leagueRegistrationQuestions,
              inArray(leagueRegistrationQuestions.leagueId, leagueIds),
            ),
          ],
        ] satisfies Array<[string, number]>)
      : []),
    // Location-id FK columns.
    ...(locationFilter
      ? ([
          [
            'apple_pay_job_items.location_id',
            await countWhere(applePayJobItems, inArray(applePayJobItems.locationId, locationIds)),
          ],
        ] satisfies Array<[string, number]>)
      : []),
  ];

  console.log('\nPost-delete verification (FK-referencing columns):');
  let ok = true;
  for (const [label, n] of postChecks) {
    console.log(`  ${label.padEnd(50)} ${n}`);
    if (n !== 0) ok = false;
  }
  if (!ok) {
    throw new Error('Post-delete verification FAILED: residual rows remain (see lines above).');
  }
  console.log('\nVerification OK: zero residual rows for any in-scope id.');

  // Quiet unused-binding lint warnings for filters that fall through
  // when one bucket is empty.
  void sql;

  await pool.end();
}

main().catch((err) => {
  console.error('cleanup-vitest-org-ab failed:', err);
  process.exit(1);
});
