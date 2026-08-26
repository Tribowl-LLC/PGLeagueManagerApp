import { asc, eq, and, sql, inArray, or } from "drizzle-orm";
import { db } from "../db.js";
import {
  adminEmailChangeAudits,
  adminPasswordResetAudits,
  adminProfileEditAudits,
  adminRoleChangeAudits,
  alerterState,
  applePayJobItems,
  applePayJobs,
  autopaySetupRequests,
  bowlerPaymentLinks,
  bowlers,
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationDiscrepancyRevisions,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationshipRevisions,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrenceBillingTerms,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  leagueScheduleCommands,
  leagueOccurrences,
  deletionRequests,
  games,
  leagues,
  locations,
  organizations,
  orphanCleanupAudits,
  paymentDisputeNotifications,
  paymentDisputeReplayAudits,
  identityLinkEvents,
  accountActionRequests,
  paymentDisputes,
  paymentOperations,
  teamPaymentSlots,
  teamPaymentSlotRevisions,
  teamPaymentPolicies,
  teamPaymentPolicyRevisions,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentAllocations,
  autopayConsents,
  autopayConsentPartners,
  financialCommands,
  paymentOperationRosterSnapshots,
  paymentOperationRosterSnapshotItems,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  canonicalCollectionGroups,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroupMemberRevisions,
  paymentSchedules,
  users,
  webhookEvents,
  type Organization, type InsertOrganization, type UpdateOrganization,
  type User,
} from "@shared/schema";
import { createLogger } from '../logger';
import { cacheInvalidate } from '../utils/cache';
import { NonAdminMissingOrgError } from './users';
import { getPgErrorCode, getPgErrorConstraint } from '../utils/db-errors';

export type OrganizationDbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const log = createLogger("StorageOrgs");

const HOSTNAME_CONSTRAINTS = new Set([
  'organization_hostname_namespace_guard',
  'organization_slug_idx',
  'organization_subdomain_idx',
  'organizations_slug_unique',
]);

export class OrganizationHostnameConflictError extends Error {
  constructor() {
    super('Organization hostname is already in use');
    this.name = 'OrganizationHostnameConflictError';
  }
}

function rethrowOrganizationHostnameConflict(error: unknown): never {
  if (
    getPgErrorCode(error) === '23505'
    && HOSTNAME_CONSTRAINTS.has(getPgErrorConstraint(error) ?? '')
  ) {
    throw new OrganizationHostnameConflictError();
  }
  throw error;
}

export async function getOrganizations(): Promise<Organization[]> {
  return db.select().from(organizations).orderBy(organizations.name);
}

export async function getOrganization(id: number): Promise<Organization | undefined> {
  const [result] = await db.select().from(organizations).where(eq(organizations.id, id));
  return result;
}

export async function getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
  const [result] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return result;
}

export async function getOrganizationBySubdomain(subdomain: string): Promise<Organization | undefined> {
  const [result] = await db.select().from(organizations).where(eq(organizations.subdomain, subdomain));
  return result;
}

export async function createOrganization(
  organization: InsertOrganization,
  executor: OrganizationDbExecutor = db,
): Promise<Organization> {
  try {
    const [result] = await executor.insert(organizations).values(organization).returning();
    return result;
  } catch (error) {
    rethrowOrganizationHostnameConflict(error);
  }
}

export async function updateOrganization(id: number, organization: UpdateOrganization): Promise<Organization> {
  try {
    const [result] = await db.update(organizations).set(organization).where(eq(organizations.id, id)).returning();
    return result;
  } catch (error) {
    rethrowOrganizationHostnameConflict(error);
  }
}

export async function archiveOrganization(id: number): Promise<Organization> {
  const [result] = await db.update(organizations).set({ active: false }).where(eq(organizations.id, id)).returning();
  return result;
}

export async function restoreOrganization(id: number): Promise<Organization> {
  const [result] = await db.update(organizations).set({ active: true }).where(eq(organizations.id, id)).returning();
  return result;
}

export async function deleteOrganization(id: number): Promise<void> {
  let affectedUserIds: number[] = [];
  await db.transaction(async (tx) => {
    // Explicit system-admin teardown is the only operation allowed to remove
    // append-only roster evidence. The trigger checks this transaction-local
    // marker; ordinary commands cannot bypass the evidence guard.
    await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
    // Keep tenant mutation serialized while remaining compatible with the
    // KEY SHARE lock PostgreSQL takes to validate a concurrent webhook's
    // organization FK. Payment preparation locks schedules before league rows
    // and locations, so teardown follows that same deterministic order.
    await tx.execute(sql`SELECT id FROM ${organizations} WHERE id = ${id} FOR NO KEY UPDATE`);

    // The system-admin-only delete route is an intentional full teardown.
    // Clear restrictive audit FKs and organization-owned join rows first,
    // null global references that must survive, then remove tenant data in
    // dependency order. Every write shares this transaction, so a foreign-key
    // conflict leaves the organization entirely intact.
    const orgUsers = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.organizationId, id));
    const userIds = orgUsers
      .filter((user) => user.role !== 'system_admin')
      .map((user) => user.id);
    const systemAdminIds = orgUsers
      .filter((user) => user.role === 'system_admin')
      .map((user) => user.id);
    affectedUserIds = orgUsers.map((user) => user.id);
    const orgBowlers = await tx
      .select({ id: bowlers.id })
      .from(bowlers)
      .where(eq(bowlers.organizationId, id));
    const bowlerIds = orgBowlers.map((bowler) => bowler.id);
    // Payment preparation locks each schedule row before it reaches the
    // league advisory/row lock. Gather IDs without locking, then follow that
    // same schedule -> league -> location order for teardown.
    const candidateLeagues = await tx
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.organizationId, id));
    const candidateLeagueIds = candidateLeagues.map((league) => league.id);
    if (candidateLeagueIds.length > 0) {
      await tx
        .select({ id: paymentSchedules.id })
        .from(paymentSchedules)
        .where(inArray(paymentSchedules.leagueId, candidateLeagueIds))
        .orderBy(asc(paymentSchedules.id))
        .for('update');
    }
    const orgLeagues = await tx
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.organizationId, id))
      .orderBy(asc(leagues.id))
      .for('update');
    const leagueIds = orgLeagues.map((league) => league.id);
    const orgLocations = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.organizationId, id))
      .orderBy(asc(locations.id))
      .for('update');
    const locationIds = orgLocations.map((location) => location.id);

    const organizationAlertKinds = [
      ...leagueIds.map((leagueId) => `league_square_missing:${leagueId}`),
      ...locationIds.map((locationId) => `square_catalog_cap:loc:${locationId}`),
    ];

    // Standing participant/binding evidence and consent-partner evidence
    // reference the link with restrictive FKs. Remove every child evidence
    // row before retiring the tenant's link rows. This ordering is also
    // shared with normal link retirement: a teardown must never leave the
    // durable operation evidence pointing at a deleted link.
    await tx.delete(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.organizationId, id));
    await tx.delete(paymentOperationStandingAutopayBindings).where(eq(paymentOperationStandingAutopayBindings.organizationId, id));
    await tx.delete(autopayConsentPartners).where(eq(autopayConsentPartners.organizationId, id));
    await tx.delete(bowlerPaymentLinks).where(eq(bowlerPaymentLinks.organizationId, id));
    await tx.delete(applePayJobItems).where(eq(applePayJobItems.organizationId, id));
    await tx.delete(adminRoleChangeAudits).where(eq(adminRoleChangeAudits.organizationId, id));
    await tx.delete(adminPasswordResetAudits).where(eq(adminPasswordResetAudits.organizationId, id));
    await tx.delete(identityLinkEvents).where(eq(identityLinkEvents.organizationId, id));
    await tx.delete(accountActionRequests).where(eq(accountActionRequests.organizationId, id));
    await tx
      .delete(orphanCleanupAudits)
      .where(or(
        eq(orphanCleanupAudits.organizationId, id),
        eq(orphanCleanupAudits.previousOrganizationId, id),
      ));

    if (organizationAlertKinds.length > 0) {
      await tx
        .delete(alerterState)
        .where(inArray(alerterState.kind, organizationAlertKinds));
    }

    if (userIds.length > 0) {
      // The session table stores passport's user id inside JSON and has no
      // foreign key to users, so remove sessions for tenant users explicitly
      // before deleting their accounts.
      for (const userId of userIds) {
        await tx.execute(sql`
          DELETE FROM "session"
          WHERE sess->'passport'->>'user' = ${String(userId)}
        `);
      }

      await tx.delete(adminEmailChangeAudits).where(or(
        inArray(adminEmailChangeAudits.actorUserId, userIds),
        inArray(adminEmailChangeAudits.targetUserId, userIds),
      ));
      await tx.delete(adminProfileEditAudits).where(or(
        inArray(adminProfileEditAudits.actorUserId, userIds),
        inArray(adminProfileEditAudits.targetUserId, userIds),
      ));
      await tx.delete(adminPasswordResetAudits).where(or(
        inArray(adminPasswordResetAudits.actorUserId, userIds),
        inArray(adminPasswordResetAudits.targetUserId, userIds),
      ));
      await tx.delete(adminRoleChangeAudits).where(or(
        inArray(adminRoleChangeAudits.actorUserId, userIds),
        inArray(adminRoleChangeAudits.targetUserId, userIds),
      ));
      await tx.delete(orphanCleanupAudits).where(inArray(orphanCleanupAudits.adminUserId, userIds));

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
      await tx
        .update(users)
        .set({ bowlerId: null })
        .where(inArray(users.bowlerId, bowlerIds));
    }
    if (locationIds.length > 0) {
      await tx
        .update(users)
        .set({ locationId: null })
        .where(inArray(users.locationId, locationIds));
    }
    if (systemAdminIds.length > 0) {
      // System administrators are platform accounts, not tenant-owned
      // accounts. Preserve them while detaching the organization that is
      // about to be deleted. Their bowler/location links were cleared above
      // only when those linked rows belong to this teardown.
      await tx
        .update(users)
        .set({ organizationId: null })
        .where(inArray(users.id, systemAdminIds));
    }

    // Setup workflows retain restrictive operation/schedule references, so
    // explicit tenant teardown removes them before either referenced table.
    await tx.delete(autopaySetupRequests).where(eq(autopaySetupRequests.organizationId, id));

    // PR1 roster-driven evidence is tenant-owned and uses restrictive links.
    // Remove corrections/obligations/responsibilities before slots and the
    // retained general payment ledger. This path is the explicit teardown
    // exception; ordinary mutations remain append-only/locked.
    await tx.delete(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.organizationId, id));
    await tx.delete(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.organizationId, id));
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.organizationId, id));
    await tx.delete(paymentObligations).where(eq(paymentObligations.organizationId, id));
    await tx.delete(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.organizationId, id));
    await tx.delete(teamPaymentPolicyRevisions).where(eq(teamPaymentPolicyRevisions.organizationId, id));
    await tx.delete(teamPaymentPolicies).where(eq(teamPaymentPolicies.organizationId, id));
    await tx.delete(teamPaymentSlotRevisions).where(eq(teamPaymentSlotRevisions.organizationId, id));
    await tx.delete(teamPaymentSlots).where(eq(teamPaymentSlots.organizationId, id));
    await tx.delete(autopayConsents).where(eq(autopayConsents.organizationId, id));
    await tx.delete(financialCommands).where(eq(financialCommands.organizationId, id));

    // Replay audits and in-app notifications retain restrictive user,
    // dispute, and webhook-evidence references. Full tenant teardown is the
    // explicit retention-policy exception and removes them first.
    await tx.delete(paymentDisputeReplayAudits).where(eq(paymentDisputeReplayAudits.organizationId, id));
    await tx.delete(paymentDisputeNotifications).where(eq(paymentDisputeNotifications.organizationId, id));

    // Disputes retain restrictive operation and webhook-evidence references.
    // Ordinary location deletion therefore remains rejected, while explicit
    // full tenant teardown removes the independently retained dispute record
    // before either referenced audit store.
    await tx.delete(paymentDisputes).where(eq(paymentDisputes.organizationId, id));

    // Payment operations intentionally retain a restrictive schedule FK so
    // ordinary schedule deletion cannot erase the durable provider audit.
    // Full tenant teardown is the explicit exception and removes these rows
    // before deleting the organization's leagues/schedules.
    await tx.delete(paymentOperations).where(eq(paymentOperations.organizationId, id));

    // D1 compatibility references are restrictive by design. Full tenant
    // teardown removes their legacy dependants before canonical occurrences;
    // ordinary row deletion remains blocked while evidence is linked.
    if (leagueIds.length > 0) {
      await tx.delete(games).where(inArray(games.leagueId, leagueIds));
      await tx.delete(paymentSchedules).where(inArray(paymentSchedules.leagueId, leagueIds));
    }

    // Collection groups are retained canonical schedule evidence and must be
    // removed only as part of explicit organization teardown, in child-first
    // order so their revision/member history cannot block league deletion.
    await tx.delete(canonicalCollectionGroupMemberRevisions).where(eq(canonicalCollectionGroupMemberRevisions.organizationId, id));
    await tx.delete(canonicalCollectionGroupRevisions).where(eq(canonicalCollectionGroupRevisions.organizationId, id));
    await tx.delete(canonicalCollectionGroupMembers).where(eq(canonicalCollectionGroupMembers.organizationId, id));
    await tx.delete(canonicalCollectionGroups).where(eq(canonicalCollectionGroups.organizationId, id));

    // Ordinary location deletion retains webhook evidence and is rejected.
    // Full tenant teardown is the explicit retention-policy exception: remove
    // the tenant's encrypted inbox evidence inside this same transaction before
    // deleting the locked locations and organization.
    await tx.delete(webhookEvents).where(eq(webhookEvents.organizationId, id));

    // Phase A1 canonical occurrence data is durable and uses restrictive
    // parent FKs. Full organization deletion is the explicit retention-policy
    // exception, so remove child audit rows before current rows, then remove
    // runs and immutable commands before tenant actors and parents.
    await tx.delete(leagueOccurrenceGenerationDiscrepancyRevisions).where(eq(leagueOccurrenceGenerationDiscrepancyRevisions.organizationId, id));
    await tx.delete(leagueOccurrenceGenerationDiscrepancies).where(eq(leagueOccurrenceGenerationDiscrepancies.organizationId, id));
    await tx.delete(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.organizationId, id));
    await tx.delete(leagueScheduleExceptionRevisions).where(eq(leagueScheduleExceptionRevisions.organizationId, id));
    await tx.delete(leagueOccurrenceRelationshipRevisions).where(eq(leagueOccurrenceRelationshipRevisions.organizationId, id));
    await tx.delete(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.organizationId, id));
    await tx.delete(leagueOccurrenceRelationships).where(eq(leagueOccurrenceRelationships.organizationId, id));
    await tx.delete(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.organizationId, id));
    await tx.delete(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.organizationId, id));
    await tx.delete(leagueOccurrences).where(eq(leagueOccurrences.organizationId, id));
    await tx.delete(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.organizationId, id));
    await tx.delete(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, id));

    await tx.delete(leagues).where(eq(leagues.organizationId, id));
    await tx.delete(bowlers).where(eq(bowlers.organizationId, id));
    await tx.delete(users).where(eq(users.organizationId, id));
    await tx.delete(locations).where(eq(locations.organizationId, id));
    await tx.delete(organizations).where(eq(organizations.id, id));
  });
  for (const userId of affectedUserIds) {
    cacheInvalidate(`user:${userId}`);
  }
  cacheInvalidate('organizations');
  cacheInvalidate('leagues:');
  cacheInvalidate('bowlers:');
  cacheInvalidate('locations:');
}

export async function getUserOrganizations(userId: number): Promise<Organization[]> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));

  if (user && user.organizationId) {
    const [organization] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId));
    return organization ? [organization] : [];
  }

  if (user && user.role === 'system_admin') {
    return db.select().from(organizations).orderBy(organizations.name);
  }

  return [];
}

export async function setUserOrganization(
  userId: number,
  organizationId: number | null,
  executor: OrganizationDbExecutor = db,
): Promise<User> {
  if (organizationId === null) {
    const [existing] = await executor.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (existing && existing.role !== 'system_admin') {
      throw new NonAdminMissingOrgError();
    }
  }
  const [updatedUser] = await executor
    .update(users)
    .set({
      organizationId: organizationId,
    })
    .where(eq(users.id, userId))
    .returning();
  cacheInvalidate(`user:${userId}`);
  return updatedUser;
}

export async function getOrganizationUsers(organizationId: number): Promise<User[]> {
  log.info('Getting admin users for organization:', organizationId);

  // Task #672: this listing powers the "Organization Users" admin page,
  // which manages organization administrators only. Self-registered
  // bowler-users (role `user`) are triaged on the separate
  // "Unclaimed Self-Registered Users" surface, so we filter on role
  // here instead of the previous `bowlerId IS NULL` heuristic.
  return db
    .select()
    .from(users)
    .where(and(
      eq(users.organizationId, organizationId),
      inArray(users.role, ['org_admin', 'payment_manager', 'system_admin']),
    ))
    .orderBy(users.name);
}
