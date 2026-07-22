import { pathToFileURL } from 'node:url';
import pg from 'pg';

export interface OrganizationHostnameRow {
  organizationId: number;
  slug: string;
  subdomain: string | null;
}

export interface OrganizationHostnameCollision {
  hostname: string;
  organizations: Array<{
    organizationId: number;
    sources: Array<'slug' | 'subdomain'>;
  }>;
}

export interface OrganizationHostnameAudit {
  collisions: OrganizationHostnameCollision[];
  nonLowercase: Array<{
    organizationId: number;
    source: 'slug' | 'subdomain';
    normalizedHostname: string;
  }>;
}

export function analyzeOrganizationHostnameRows(
  rows: readonly OrganizationHostnameRow[],
): OrganizationHostnameAudit {
  const namespace = new Map<string, Map<number, Set<'slug' | 'subdomain'>>>();
  const nonLowercase: OrganizationHostnameAudit['nonLowercase'] = [];

  for (const row of rows) {
    const identifiers = [
      ['slug', row.slug] as const,
      ['subdomain', row.subdomain] as const,
    ];
    for (const [source, value] of identifiers) {
      if (value === null) continue;
      const normalizedHostname = value.toLowerCase();
      if (value !== normalizedHostname) {
        nonLowercase.push({ organizationId: row.organizationId, source, normalizedHostname });
      }
      const owners = namespace.get(normalizedHostname) ?? new Map();
      const sources = owners.get(row.organizationId) ?? new Set();
      sources.add(source);
      owners.set(row.organizationId, sources);
      namespace.set(normalizedHostname, owners);
    }
  }

  const collisions = [...namespace.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([hostname, owners]) => ({
      hostname,
      organizations: [...owners.entries()]
        .map(([organizationId, sources]) => ({
          organizationId,
          sources: [...sources].sort(),
        }))
        .sort((a, b) => a.organizationId - b.organizationId),
    }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  nonLowercase.sort((a, b) =>
    a.organizationId - b.organizationId || a.source.localeCompare(b.source));
  return { collisions, nonLowercase };
}

export async function auditOrganizationHostnames(
  connectionString: string,
): Promise<OrganizationHostnameAudit> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-organization-hostname-audit',
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await client.query<{
      organization_id: number;
      slug: string;
      subdomain: string | null;
    }>(`
      SELECT id AS organization_id, slug, subdomain
      FROM organizations
      ORDER BY id
    `);
    await client.query('COMMIT');
    return analyzeOrganizationHostnameRows(result.rows.map((row) => ({
      organizationId: row.organization_id,
      slug: row.slug,
      subdomain: row.subdomain,
    })));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the read-only organization hostname audit.');
  }
  const audit = await auditOrganizationHostnames(connectionString);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (audit.collisions.length > 0 || audit.nonLowercase.length > 0) {
    process.exitCode = 1;
    process.stderr.write(
      '[organization-hostname-audit] Refusing enforcement until every reported row is remediated.\n',
    );
  } else {
    process.stdout.write('[organization-hostname-audit] No collisions found.\n');
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch(() => {
    process.stderr.write('[organization-hostname-audit] Audit failed.\n');
    process.exitCode = 1;
  });
}
