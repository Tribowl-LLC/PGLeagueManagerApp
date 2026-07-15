import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ACTIVE_MIGRATIONS_DIRECTORY = resolve('migrations');
export const BASELINE_TAG = '0000_normalized_baseline';
export const EXPECTED_BASELINE_TABLE_COUNT = 29;
export const EXPECTED_BASELINE_COLUMN_COUNT = 307;

interface JournalEntryJson {
  idx?: unknown;
  version?: unknown;
  when?: unknown;
  tag?: unknown;
  breakpoints?: unknown;
}

interface JournalJson {
  version?: unknown;
  dialect?: unknown;
  entries?: unknown;
}

interface SnapshotJson {
  id?: unknown;
  prevId?: unknown;
  version?: unknown;
  dialect?: unknown;
  tables?: unknown;
  enums?: unknown;
}

export interface ActiveMigration {
  idx: number;
  version: '7';
  createdAt: number;
  tag: string;
  breakpoints: boolean;
  sql: string;
  hash: string;
  path: string;
  snapshotPath: string;
}

interface MigrationChecksumManifest {
  formatVersion: 1;
  entries: Array<{
    idx: number;
    tag: string;
    createdAt: number;
    hash: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse migration metadata ${path}: ${reason}`);
  }
}

function validateTag(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}_[a-z0-9_]+$/.test(value)) {
    throw new Error('Active migration metadata contains an invalid tag.');
  }
  return value;
}

function loadSnapshot(path: string, migration: Pick<ActiveMigration, 'idx' | 'version'>): SnapshotJson {
  const parsed = parseJsonFile(path);
  if (!isRecord(parsed)) throw new Error(`Migration snapshot ${path} must be a JSON object.`);
  const snapshot = parsed as SnapshotJson;
  if (snapshot.version !== migration.version || snapshot.dialect !== 'postgresql') {
    throw new Error(`Migration snapshot ${path} does not match journal version/dialect.`);
  }
  if (typeof snapshot.id !== 'string' || typeof snapshot.prevId !== 'string') {
    throw new Error(`Migration snapshot ${path} is missing id/prevId metadata.`);
  }
  if (!isRecord(snapshot.tables) || !isRecord(snapshot.enums)) {
    throw new Error(`Migration snapshot ${path} is missing tables or enums metadata.`);
  }
  if (migration.idx === 0) {
    if (Object.keys(snapshot.tables).length !== EXPECTED_BASELINE_TABLE_COUNT) {
      throw new Error(`The baseline snapshot must declare exactly ${EXPECTED_BASELINE_TABLE_COUNT} tables.`);
    }
    const columnCount = Object.values(snapshot.tables).reduce<number>((total, table) => {
      if (!isRecord(table) || !isRecord(table.columns)) {
        throw new Error(`The baseline snapshot contains incomplete table metadata in ${path}.`);
      }
      return total + Object.keys(table.columns).length;
    }, 0);
    if (columnCount !== EXPECTED_BASELINE_COLUMN_COUNT) {
      throw new Error(`The baseline snapshot must declare exactly ${EXPECTED_BASELINE_COLUMN_COUNT} columns.`);
    }
    const roleEnum = snapshot.enums['public.user_role'];
    if (
      !isRecord(roleEnum) ||
      JSON.stringify(roleEnum.values) !== JSON.stringify(['system_admin', 'org_admin', 'user'])
    ) {
      throw new Error('The baseline snapshot does not contain the approved public.user_role enum.');
    }
    const leagues = snapshot.tables['public.leagues'];
    const organizationId = isRecord(leagues) && isRecord(leagues.columns)
      ? leagues.columns.organization_id
      : null;
    if (!isRecord(organizationId) || organizationId.notNull !== false) {
      throw new Error('The baseline must preserve nullable leagues.organization_id.');
    }
  }
  return snapshot;
}

function assertBaselineSql(sql: string): void {
  const tableCount = (sql.match(/\bCREATE TABLE\b/g) ?? []).length;
  if (tableCount !== EXPECTED_BASELINE_TABLE_COUNT) {
    throw new Error(`The baseline SQL must create exactly ${EXPECTED_BASELINE_TABLE_COUNT} tables.`);
  }
  const bannedPatterns: Array<[RegExp, string]> = [
    [/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, 'RLS enablement'],
    [/\bCREATE\s+POLICY\b/i, 'RLS policies'],
    [/\b(?:auth|neon_auth)\s*\./i, 'Neon-managed schemas'],
    [/\bpg_session_jwt\b/i, 'provider-managed pg_session_jwt objects'],
    [/\bcardpointe\b/i, 'retired CardPointe state'],
    [/\buser_avatars\b/i, 'the retired user_avatars table'],
  ];
  for (const [pattern, label] of bannedPatterns) {
    if (pattern.test(sql)) throw new Error(`The active baseline unexpectedly contains ${label}.`);
  }
  const requiredPatterns: Array<[RegExp, string]> = [
    [/CREATE TYPE "public"\."user_role" AS ENUM\('system_admin', 'org_admin', 'user'\)/, 'public.user_role'],
    [/CREATE TABLE "rate_limit_buckets"/, 'rate_limit_buckets'],
    [/CREATE UNIQUE INDEX "organization_subdomain_idx"[\s\S]*WHERE "organizations"\."subdomain" IS NOT NULL/, 'organization_subdomain_idx partial predicate'],
    [/CREATE OR REPLACE FUNCTION users_role_org_required_fn\(\)/, 'users_role_org_required_fn()'],
    [/CREATE OR REPLACE FUNCTION league_secretary_org_match_fn\(\)/, 'league_secretary_org_match_fn()'],
    [/CREATE OR REPLACE FUNCTION users_org_change_revoke_secretaries_fn\(\)/, 'users_org_change_revoke_secretaries_fn()'],
    [/CREATE TRIGGER users_role_org_required\b/, 'users.users_role_org_required'],
    [/CREATE TRIGGER league_secretaries_org_match\b/, 'league_secretaries.league_secretaries_org_match'],
    [/CREATE TRIGGER users_org_change_revoke_secretaries\b/, 'users.users_org_change_revoke_secretaries'],
  ];
  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(sql)) throw new Error(`The active baseline is missing ${label}.`);
  }
}

export function loadActiveMigrations(
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
  options: { verifyChecksums?: boolean } = {},
): ActiveMigration[] {
  const journalPath = join(migrationsDirectory, 'meta', '_journal.json');
  const parsed = parseJsonFile(journalPath);
  if (!isRecord(parsed)) throw new Error('Active migration journal must be a JSON object.');
  const journal = parsed as JournalJson;
  if (journal.version !== '7' || journal.dialect !== 'postgresql' || !Array.isArray(journal.entries)) {
    throw new Error('Active migration journal must use Drizzle PostgreSQL metadata version 7.');
  }
  if (journal.entries.length === 0) throw new Error('Active migration journal is empty.');

  let previousCreatedAt = -1;
  let previousSnapshotId = '00000000-0000-0000-0000-000000000000';
  const migrations = journal.entries.map((rawEntry, position): ActiveMigration => {
    if (!isRecord(rawEntry)) throw new Error('Active migration journal contains a non-object entry.');
    const entry = rawEntry as JournalEntryJson;
    if (entry.idx !== position || entry.version !== '7' || entry.breakpoints !== true) {
      throw new Error(`Active migration journal entry ${position} has inconsistent metadata.`);
    }
    if (!Number.isSafeInteger(entry.when) || (entry.when as number) <= previousCreatedAt) {
      throw new Error('Active migration timestamps must be positive, safe, and strictly increasing.');
    }
    const tag = validateTag(entry.tag);
    const sqlPath = join(migrationsDirectory, `${tag}.sql`);
    const snapshotPath = join(migrationsDirectory, 'meta', `${String(position).padStart(4, '0')}_snapshot.json`);
    if (!existsSync(sqlPath)) throw new Error(`Active migration SQL is missing for ${tag}.`);
    if (!existsSync(snapshotPath)) throw new Error(`Active migration snapshot is missing for ${tag}.`);
    const sql = readFileSync(sqlPath, 'utf8');
    if (!sql.trim()) throw new Error(`Active migration ${tag} is empty.`);
    const migration: ActiveMigration = {
      idx: position,
      version: '7',
      createdAt: entry.when as number,
      tag,
      breakpoints: true,
      sql,
      hash: createHash('sha256').update(sql).digest('hex'),
      path: sqlPath,
      snapshotPath,
    };
    const snapshot = loadSnapshot(snapshotPath, migration);
    if (snapshot.prevId !== previousSnapshotId) {
      throw new Error(`Migration snapshot chain is inconsistent at ${tag}.`);
    }
    previousSnapshotId = snapshot.id as string;
    previousCreatedAt = migration.createdAt;
    return migration;
  });

  if (migrations[0]?.tag !== BASELINE_TAG) {
    throw new Error(`The first active migration must be ${BASELINE_TAG}.`);
  }
  assertBaselineSql(migrations[0].sql);

  const trackedSql = new Set(migrations.map((migration) => `${migration.tag}.sql`));
  const untrackedSql = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && !trackedSql.has(name));
  if (untrackedSql.length > 0) {
    throw new Error(`Active migration directory contains untracked SQL: ${untrackedSql.join(', ')}.`);
  }
  if (options.verifyChecksums !== false) {
    const checksumPath = join(migrationsDirectory, 'migration-checksums.json');
    const checksumJson = parseJsonFile(checksumPath);
    if (!isRecord(checksumJson) || checksumJson.formatVersion !== 1 || !Array.isArray(checksumJson.entries)) {
      throw new Error('Active migration checksum manifest is invalid.');
    }
    const expectedEntries = migrations.map(({ idx, tag, createdAt, hash }) => ({ idx, tag, createdAt, hash }));
    if (JSON.stringify(checksumJson.entries) !== JSON.stringify(expectedEntries)) {
      throw new Error('Active migration SQL or journal metadata does not match migration-checksums.json.');
    }
  }
  return migrations;
}

export function writeMigrationChecksumManifest(
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
): void {
  const migrations = loadActiveMigrations(migrationsDirectory, { verifyChecksums: false });
  const manifest: MigrationChecksumManifest = {
    formatVersion: 1,
    entries: migrations.map(({ idx, tag, createdAt, hash }) => ({ idx, tag, createdAt, hash })),
  };
  writeFileSync(
    join(migrationsDirectory, 'migration-checksums.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export function baselineMigration(
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
): ActiveMigration {
  const baseline = loadActiveMigrations(migrationsDirectory)[0];
  if (!baseline) throw new Error('The active migration baseline is missing.');
  return baseline;
}
