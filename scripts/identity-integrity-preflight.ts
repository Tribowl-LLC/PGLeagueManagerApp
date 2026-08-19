import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { redactConnectionDetails } from './lib/db-schema-inventory';

export interface IdentityIntegrityPreflight {
  blockers: {
    normalizedEmailDuplicates: Array<{ normalizedEmailHash: string; userIds: number[] }>;
    duplicateBowlerClaims: Array<{ bowlerId: number; userIds: number[] }>;
    crossOrganizationBowlerLinks: Array<{ userId: number; bowlerId: number }>;
    crossOrganizationLocationAssignments: Array<{ userId: number; locationId: number }>;
    elevatedRoleBowlerLinks: Array<{ userId: number; bowlerId: number; role: string }>;
    invalidPaymentManagerScopes: Array<{ userId: number }>;
  };
  informational: {
    emailsToNormalize: number;
    legacyPlaintextActionsToReissue: number;
  };
}

export async function inspectIdentityIntegrity(
  connectionString: string,
): Promise<IdentityIntegrityPreflight> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-identity-integrity-preflight',
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    // A pg.Client serializes queries on one connection. Keep these reads
    // sequential rather than Promise.all-ing them, which triggers pg's
    // "client already executing a query" deprecation warning and obscures
    // failures during a migration preflight.
    const emailDuplicates = await client.query<{ normalized_email: string; user_ids: number[] }>(`
        SELECT lower(btrim(email)) AS normalized_email,
               array_agg(id ORDER BY id)::integer[] AS user_ids
        FROM users
        GROUP BY lower(btrim(email))
        HAVING count(*) > 1
        ORDER BY lower(btrim(email))
      `);
    const bowlerDuplicates = await client.query<{ bowler_id: number; user_ids: number[] }>(`
        SELECT bowler_id, array_agg(id ORDER BY id)::integer[] AS user_ids
        FROM users
        WHERE bowler_id IS NOT NULL
        GROUP BY bowler_id
        HAVING count(*) > 1
        ORDER BY bowler_id
      `);
    const crossOrgBowlers = await client.query<{ user_id: number; bowler_id: number }>(`
        SELECT u.id AS user_id, u.bowler_id
        FROM users u
        JOIN bowlers b ON b.id = u.bowler_id
        WHERE u.bowler_id IS NOT NULL
          AND u.organization_id IS DISTINCT FROM b.organization_id
        ORDER BY u.id
      `);
    const crossOrgLocations = await client.query<{ user_id: number; location_id: number }>(`
        SELECT u.id AS user_id, u.location_id
        FROM users u
        JOIN locations l ON l.id = u.location_id
        WHERE u.location_id IS NOT NULL
          AND u.organization_id IS DISTINCT FROM l.organization_id
        ORDER BY u.id
      `);
    const elevatedBowlers = await client.query<{ user_id: number; bowler_id: number; role: string }>(`
        SELECT id AS user_id, bowler_id, role::text AS role
        FROM users
        WHERE bowler_id IS NOT NULL
          AND role::text IN ('system_admin', 'org_admin', 'payment_manager')
        ORDER BY id
      `);
    const paymentManagerScopes = await client.query<{ user_id: number }>(`
        SELECT id AS user_id
        FROM users
        WHERE role::text = 'payment_manager'
          AND (organization_id IS NULL OR location_id IS NULL)
        ORDER BY id
      `);
    const normalizationCount = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM users
        WHERE email <> lower(btrim(email))
      `);
    const legacyTokenCount = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM users
        WHERE invite_token IS NOT NULL OR invite_token_expiry IS NOT NULL
      `);
    await client.query('COMMIT');

    return {
      blockers: {
        normalizedEmailDuplicates: emailDuplicates.rows.map((row) => ({
          // IDs are sufficient for remediation; hash the identity key so a
          // production preflight artifact does not become an email export.
          normalizedEmailHash: createHash('sha256').update(row.normalized_email).digest('hex'),
          userIds: row.user_ids,
        })),
        duplicateBowlerClaims: bowlerDuplicates.rows.map((row) => ({
          bowlerId: row.bowler_id,
          userIds: row.user_ids,
        })),
        crossOrganizationBowlerLinks: crossOrgBowlers.rows.map((row) => ({
          userId: row.user_id,
          bowlerId: row.bowler_id,
        })),
        crossOrganizationLocationAssignments: crossOrgLocations.rows.map((row) => ({
          userId: row.user_id,
          locationId: row.location_id,
        })),
        elevatedRoleBowlerLinks: elevatedBowlers.rows.map((row) => ({
          userId: row.user_id,
          bowlerId: row.bowler_id,
          role: row.role,
        })),
        invalidPaymentManagerScopes: paymentManagerScopes.rows.map((row) => ({
          userId: row.user_id,
        })),
      },
      informational: {
        emailsToNormalize: Number(normalizationCount.rows[0]?.count ?? 0),
        legacyPlaintextActionsToReissue: Number(legacyTokenCount.rows[0]?.count ?? 0),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function blockerCount(report: IdentityIntegrityPreflight): number {
  return Object.values(report.blockers).reduce((total, rows) => total + rows.length, 0);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the read-only identity-integrity preflight.');
  }
  const report = await inspectIdentityIntegrity(connectionString);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const count = blockerCount(report);
  if (count > 0) {
    process.stderr.write(`[identity-integrity-preflight] Refusing migration: ${count} blocking data issue(s) require explicit remediation.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('[identity-integrity-preflight] No blocking identity conflicts found.\n');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[identity-integrity-preflight] Audit failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  });
}
