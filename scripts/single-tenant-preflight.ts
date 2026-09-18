import { sql } from 'drizzle-orm';
import { db } from '../server/db';
import { storage } from '../server/storage';
import { env } from '../server/config';

const dependentTables = [
  'users',
  'locations',
  'leagues',
  'bowlers',
  'payment_operations',
  'account_action_requests',
  'account_action_delivery_jobs',
  'apple_pay_jobs',
] as const;

async function countByOrganization(table: string, organizationId: number): Promise<number | null> {
  try {
    const identifier = sql.raw(`"${table}"`);
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM ${identifier} WHERE organization_id = ${organizationId}`);
    return Number((result.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
  } catch {
    // Some historical installations may not yet contain an optional job
    // table. Report it as unavailable rather than mutating or guessing.
    return null;
  }
}

async function main(): Promise<void> {
  const organizations = await storage.getOrganizations();
  const activeOrganizations = organizations.filter((organization) => organization.active);
  const configuredId = env.APP_ORGANIZATION_ID ?? null;
  const configured = configuredId === null
    ? undefined
    : organizations.find((organization) => organization.id === configuredId);

  const dependentRecordCounts: Record<string, number | null> = {};
  if (configuredId !== null) {
    for (const table of dependentTables) {
      dependentRecordCounts[table] = await countByOrganization(table, configuredId);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    configuredOrganizationId: configuredId,
    configuredOrganization: configured
      ? {
          id: configured.id,
          active: configured.active,
          name: configured.name,
          slug: configured.slug,
          subdomain: configured.subdomain,
        }
      : null,
    activeOrganizations: activeOrganizations.map((organization) => ({
      id: organization.id,
      active: organization.active,
      name: organization.name,
      slug: organization.slug,
      subdomain: organization.subdomain,
    })),
    organizationCount: organizations.length,
    dependentRecordCounts,
    cutoverReady: configuredId !== null
      && configured !== undefined
      && configured.active
      && activeOrganizations.length === 1
      && activeOrganizations[0]?.id === configuredId,
    blockers: [
      ...(configuredId === null ? ['APP_ORGANIZATION_ID is not configured'] : []),
      ...(configured === undefined && configuredId !== null ? ['configured organization does not exist'] : []),
      ...(configured && !configured.active ? ['configured organization is inactive'] : []),
      ...(activeOrganizations.length !== 1 ? ['there must be exactly one active organization'] : []),
      ...(activeOrganizations.length === 1 && activeOrganizations[0]?.id !== configuredId
        ? ['the configured organization is not the only active organization']
        : []),
    ],
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.cutoverReady) process.exitCode = 2;
}

main().catch((error) => {
  console.error('Singleton organization preflight failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
