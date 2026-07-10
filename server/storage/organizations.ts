import { eq, and, sql, inArray, or } from "drizzle-orm";
import { db } from "../db.js";
import {
  adminEmailChangeAudits,
  adminPasswordResetAudits,
  adminProfileEditAudits,
  adminRoleChangeAudits,
  applePayJobItems,
  applePayJobs,
  bowlerGuardians,
  bowlerPaymentLinks,
  bowlers,
  deletionRequests,
  leagueRegistrations,
  leagueSecretaries,
  leagueSecretaryAudits,
  leagues,
  locations,
  orgIntegrationsSchema,
  organizations,
  orphanCleanupAudits,
  users,
  type Organization, type InsertOrganization, type UpdateOrganization,
  type User,
  type OrgIntegrations,
} from "@shared/schema";
import { createLogger } from '../logger';
import { cacheInvalidate } from '../utils/cache';
import { NonAdminMissingOrgError } from './users';

const log = createLogger("StorageOrgs");

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

export async function createOrganization(organization: InsertOrganization): Promise<Organization> {
  const [result] = await db.insert(organizations).values(organization).returning();
  return result;
}

export async function updateOrganization(id: number, organization: UpdateOrganization): Promise<Organization> {
  const [result] = await db.update(organizations).set(organization).where(eq(organizations.id, id)).returning();
  return result;
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
    await tx.execute(sql`SELECT id FROM ${organizations} WHERE id = ${id} FOR UPDATE`);

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
    const orgLocations = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.organizationId, id));
    const locationIds = orgLocations.map((location) => location.id);

    await tx.delete(leagueSecretaryAudits).where(eq(leagueSecretaryAudits.organizationId, id));
    await tx.delete(leagueSecretaries).where(eq(leagueSecretaries.organizationId, id));
    await tx.delete(leagueRegistrations).where(eq(leagueRegistrations.organizationId, id));
    await tx.delete(bowlerGuardians).where(eq(bowlerGuardians.organizationId, id));
    await tx.delete(bowlerPaymentLinks).where(eq(bowlerPaymentLinks.organizationId, id));
    await tx.delete(applePayJobItems).where(eq(applePayJobItems.organizationId, id));
    await tx.delete(adminRoleChangeAudits).where(eq(adminRoleChangeAudits.organizationId, id));
    await tx.delete(adminPasswordResetAudits).where(eq(adminPasswordResetAudits.organizationId, id));
    await tx
      .delete(orphanCleanupAudits)
      .where(or(
        eq(orphanCleanupAudits.organizationId, id),
        eq(orphanCleanupAudits.previousOrganizationId, id),
      ));

    if (userIds.length > 0) {
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
      await tx.delete(leagueSecretaryAudits).where(or(
        inArray(leagueSecretaryAudits.actorUserId, userIds),
        inArray(leagueSecretaryAudits.targetUserId, userIds),
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

export async function setUserOrganization(userId: number, organizationId: number | null): Promise<User> {
  if (organizationId === null) {
    const [existing] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (existing && existing.role !== 'system_admin') {
      throw new NonAdminMissingOrgError();
    }
  }
  const [updatedUser] = await db
    .update(users)
    .set({
      organizationId: organizationId,
    })
    .where(eq(users.id, userId))
    .returning();
  cacheInvalidate(`user:${userId}`);
  return updatedUser;
}

export async function getOrgIntegrations(orgId: number): Promise<OrgIntegrations | null> {
  const [org] = await db
    .select({ integrations: organizations.integrations })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  if (!org?.integrations) return null;

  const parsed = orgIntegrationsSchema.safeParse(org.integrations);
  if (!parsed.success) {
    log.warn(`Malformed integrations JSONB for org ${orgId}:`, parsed.error.format());
    return null;
  }
  return parsed.data ?? null;
}

export async function updateOrgIntegrations(orgId: number, integrations: OrgIntegrations): Promise<Organization> {
  const [result] = await db
    .update(organizations)
    .set({ integrations })
    .where(eq(organizations.id, orgId))
    .returning();
  if (!result) throw new Error(`Organization with ID ${orgId} not found`);
  return result;
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
      inArray(users.role, ['org_admin', 'system_admin']),
    ))
    .orderBy(users.name);
}
