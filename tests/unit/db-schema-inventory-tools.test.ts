import { describe, expect, it } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { organizations } from '../../shared/schema/organizations';
import {
  DEFAULT_MIGRATION_JOURNAL_RELATION,
  assertExpectedConnectionUrlTarget,
  assertExpectedDatabaseTarget,
  assertInventoryTransactionMode,
  detectPolicyReferenceSignals,
  deriveDatabaseTargetFromConnectionString,
  determineConnectedRoleRlsMode,
  fingerprintDatabaseHost,
  parseMigrationJournalRelation,
  parseRequiredExpectedTargetEnvironment,
  redactConnectionDetails,
  resolveApprovedMigrationJournal,
  type DatabaseInventory,
  type TableInfo,
} from '../../scripts/lib/db-schema-inventory';
import {
  assertDatabaseInventory,
  compareDatabaseInventories,
} from '../../scripts/lib/db-schema-compare';
import {
  loadTrackedJournalReplayPlan,
  preflightJournalSql,
} from '../../scripts/lib/db-journal-preflight';
import {
  cleanupOwnedContainer,
  createInventoryRunId,
  inventoryArtifactDirectory,
  type DockerCommandResult,
  type DockerRunner,
  type OwnedInventoryContainer,
} from '../../scripts/lib/db-inventory-container';
import { normalizeSqlDefinition } from '../../scripts/lib/sql-definition-normalization';

function emptyInventory(database: string): DatabaseInventory {
  return {
    formatVersion: 5,
    target: {
      hostFingerprint: 'sha256:test',
      database,
      role: 'inventory_reader',
      serverVersion: '17.0',
      serverVersionNumber: '170000',
      transactionIsolation: 'repeatable read',
      transactionReadOnly: true,
      roleSuperuser: false,
      roleBypassRls: false,
    },
    schemas: [],
    tables: [],
    nonTableRelations: [],
    tablePrivileges: [],
    policies: [],
    columns: [],
    sequences: [],
    constraints: [],
    indexes: [],
    types: [],
    functions: [],
    triggers: [],
    extensions: [],
    migrationJournalDiscovery: [],
    migrationJournalInspection: {
      approvedRelation: DEFAULT_MIGRATION_JOURNAL_RELATION,
      selection: 'default',
      relationDiscovered: false,
      columnsInspected: false,
      rowsCollected: false,
    },
    migrationJournalExists: false,
    migrationJournals: [],
  };
}

function testTable(name: string, rowSecurity = false): TableInfo {
  return {
    schema: 'public',
    name,
    kind: 'table',
    persistence: 'permanent',
    rowSecurity,
    forceRowSecurity: false,
    owner: 'inventory_reader',
    connectedRoleOwnsTable: true,
    connectedRolePrivileges: ['delete', 'insert', 'maintain', 'references', 'select', 'trigger', 'truncate', 'update'],
    connectedRoleRlsMode: rowSecurity ? 'bypass-owner' : 'not-enabled',
  };
}

function indexColumnName(column: object): string | undefined {
  return 'name' in column && typeof column.name === 'string' ? column.name : undefined;
}

describe('database schema inventory tools', () => {
  it('declares the approved partial unique organizations subdomain index', () => {
    const subdomainIndexes = getTableConfig(organizations).indexes.filter(({ config }) =>
      config.columns.some((column) => indexColumnName(column) === organizations.subdomain.name),
    );

    expect(organizations.subdomain.notNull).toBe(false);
    expect(subdomainIndexes).toHaveLength(1);

    const index = subdomainIndexes[0];
    if (!index) throw new Error('organization subdomain index is missing');

    expect(index.config.name).toBe('organization_subdomain_idx');
    expect(index.config.unique).toBe(true);
    expect(index.config.columns.map(indexColumnName)).toEqual(['subdomain']);

    const predicate = index.config.where;
    if (!predicate) throw new Error('organization subdomain index predicate is missing');
    expect(new PgDialect().sqlToQuery(predicate).sql)
      .toBe('"organizations"."subdomain" IS NOT NULL');
  });

  it('ignores top-level object ordering and normalized migration journal ordering', () => {
    const left = emptyInventory('left');
    left.schemas = [{ name: 'zeta' }, { name: 'public' }];
    left.tables = [
      testTable('users'),
      testTable('organizations'),
    ];
    left.migrationJournals = [{
      schema: 'drizzle',
      table: '__drizzle_migrations',
      columns: ['hash', 'id', 'created_at'],
      entries: [
        { id: '2', hash: 'second', createdAt: '200' },
        { id: '1', hash: 'first', createdAt: '100' },
      ],
    }];
    left.migrationJournalDiscovery = [{ schema: 'drizzle', table: '__drizzle_migrations' }];
    left.migrationJournalInspection = {
      ...left.migrationJournalInspection,
      relationDiscovered: true,
      columnsInspected: true,
      rowsCollected: true,
    };
    left.migrationJournalExists = true;

    const right = emptyInventory('right');
    right.schemas = [...left.schemas].reverse();
    right.tables = [...left.tables].reverse();
    right.migrationJournals = [{
      ...left.migrationJournals[0],
      columns: [...left.migrationJournals[0].columns].reverse(),
      entries: [...left.migrationJournals[0].entries].reverse(),
    }];
    right.migrationJournalDiscovery = [...left.migrationJournalDiscovery].reverse();
    right.migrationJournalInspection = { ...left.migrationJournalInspection };
    right.migrationJournalExists = true;

    expect(compareDatabaseInventories(left, right).hasDifferences).toBe(false);
  });

  it('categorizes missing, extra, and changed objects independently', () => {
    const left = emptyInventory('db_push');
    left.tables = [
      testTable('only_left'),
      testTable('shared'),
    ];
    left.columns = [{
      schema: 'public', table: 'shared', name: 'id', ordinal: 1,
      dataType: 'integer', typeSchema: 'pg_catalog', typeName: 'int4', nullable: false,
      default: null, identity: null, generated: null, collation: null,
    }];
    left.nonTableRelations = [{
      schema: 'public', name: 'unexpected_view', kind: 'view', persistence: 'permanent',
      definition: 'SELECT 1 AS value;', foreignServer: null, foreignOptions: [],
    }];

    const right = emptyInventory('journal');
    right.tables = [
      testTable('only_right'),
      testTable('shared', true),
    ];
    right.columns = [{
      ...left.columns[0],
      nullable: true,
    }];

    const comparison = compareDatabaseInventories(left, right);
    expect(comparison.categories.tables.missingFromRight).toEqual(['public.only_left']);
    expect(comparison.categories.tables.extraInRight).toEqual(['public.only_right']);
    expect(comparison.categories.tables.changed).toEqual([
      { key: 'public.shared', fields: ['connectedRoleRlsMode', 'rowSecurity'] },
    ]);
    expect(comparison.categories.columns.changed).toEqual([
      { key: 'public.shared.id', fields: ['nullable'] },
    ]);
    expect(comparison.categories.nonTableRelations.missingFromRight).toEqual([
      'public.unexpected_view',
    ]);
    expect(comparison.hasDifferences).toBe(true);
  });

  it('validates the inventory format before comparison', () => {
    expect(() => assertDatabaseInventory({ formatVersion: 5 }, 'partial.json')).toThrow(
      'partial.json is missing target metadata',
    );
    expect(() => assertDatabaseInventory({ formatVersion: 4 }, 'legacy.json')).toThrow(
      'unsupported inventory format 4',
    );
    expect(() => assertDatabaseInventory({ formatVersion: 99 }, 'future.json')).toThrow(
      'unsupported inventory format 99',
    );
  });

  it('reports enum, function, trigger, and migration journal state by category', () => {
    const left = emptyInventory('left');
    left.types = [{
      schema: 'public', name: 'payment_state', kind: 'enum', enumLabels: ['open', 'paid'],
      baseType: null, rangeSubtype: null, default: null, notNull: false,
      constraints: [], attributes: [],
    }];
    left.functions = [{
      schema: 'public', name: 'enforce_tenant', identityArguments: '', resultType: 'trigger',
      language: 'plpgsql', kind: 'function', volatility: 'volatile', parallel: 'unsafe',
      securityDefiner: false, strict: false, leakproof: false,
      definition: 'CREATE FUNCTION public.enforce_tenant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
    }];
    left.triggers = [{
      schema: 'public', table: 'users', name: 'users_tenant', enabled: 'origin',
      definition: 'CREATE TRIGGER users_tenant BEFORE INSERT ON users EXECUTE FUNCTION enforce_tenant()',
      functionSchema: 'public', functionName: 'enforce_tenant', functionIdentityArguments: '',
    }];
    left.migrationJournals = [{
      schema: 'drizzle', table: '__drizzle_migrations', columns: ['id', 'hash', 'created_at'],
      entries: [{ id: '1', hash: 'abc', createdAt: '100' }],
    }];
    left.migrationJournalDiscovery = [{ schema: 'drizzle', table: '__drizzle_migrations' }];
    left.migrationJournalInspection = {
      ...left.migrationJournalInspection,
      relationDiscovered: true,
      columnsInspected: true,
      rowsCollected: true,
    };
    left.migrationJournalExists = true;

    const comparison = compareDatabaseInventories(left, emptyInventory('right'));
    expect(comparison.categories.types.missingFromRight).toEqual(['public.payment_state']);
    expect(comparison.categories.functions.missingFromRight).toEqual(['public.enforce_tenant()']);
    expect(comparison.categories.triggers.missingFromRight).toEqual(['public.users.users_tenant']);
    expect(comparison.categories.migrationJournals.missingFromRight).toEqual([
      'discovery:drizzle.__drizzle_migrations',
      'drizzle.__drizzle_migrations',
    ]);
    expect(comparison.categories.migrationJournals.changed).toEqual([
      { key: 'inspection', fields: ['columnsInspected', 'relationDiscovered', 'rowsCollected'] },
      { key: 'state', fields: ['exists'] },
    ]);
  });

  it('fingerprints hosts without incorporating credentials and redacts URLs', () => {
    const first = 'postgresql://reader:first-secret@example.test:5432/app';
    const second = 'postgresql://other:second-secret@example.test:5432/other';
    expect(fingerprintDatabaseHost(first)).toBe(fingerprintDatabaseHost(second));

    const redacted = redactConnectionDetails(`connection failed for ${first}`, first);
    expect(redacted).not.toContain('first-secret');
    expect(redacted).not.toContain('example.test');
    expect(redacted).not.toContain(first);
    expect(redacted).toContain('[DATABASE_URL redacted]');
    expect(redactConnectionDetails('getaddrinfo example.test', first)).not.toContain('example.test');
    const targetMetadata = redactConnectionDetails('role=reader database=app', first);
    expect(targetMetadata).not.toContain('reader');
    expect(targetMetadata).not.toContain('database=app');

    const encodedDatabase = 'postgresql://reader:secret@example.test:5432/approved%2Fdatabase';
    expect(redactConnectionDetails(
      'database approved%2Fdatabase does not exist',
      encodedDatabase,
    )).not.toContain('approved%2Fdatabase');
  });

  it('derives and validates URL target metadata before a connection is opened', () => {
    const connectionString = 'postgresql://approved%5Frole:secret@branch.example.test/approved%5Fdatabase';
    const expectedTarget = {
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: 'approved_database',
      role: 'approved_role',
    };

    expect(deriveDatabaseTargetFromConnectionString(connectionString)).toEqual(expectedTarget);
    expect(() => assertExpectedConnectionUrlTarget(connectionString, expectedTarget)).not.toThrow();

    for (const [field, value, expectedMessage] of [
      ['hostFingerprint', `sha256:${'a'.repeat(64)}`, 'endpoint fingerprint'],
      ['database', 'different_database', 'DATABASE_URL database'],
      ['role', 'different_role', 'DATABASE_URL role'],
    ] as const) {
      expect(() => assertExpectedConnectionUrlTarget(connectionString, {
        ...expectedTarget,
        [field]: value,
      })).toThrow(expectedMessage);
    }

    expect(() => deriveDatabaseTargetFromConnectionString('postgresql://role:secret@branch.example.test'))
      .toThrow('explicitly name a database');
    expect(() => deriveDatabaseTargetFromConnectionString('postgresql://branch.example.test/database'))
      .toThrow('explicitly name a role');
    expect(deriveDatabaseTargetFromConnectionString(
      'postgresql://approved_role:secret@branch.example.test/approved%2Fdatabase',
    ).database).toBe('approved%2Fdatabase');
    expect(() => deriveDatabaseTargetFromConnectionString(
      'postgresql://approved_role:secret@%65xample.test/approved_database',
    )).toThrow('percent-encoded hostnames');
  });

  it('rejects connection target query overrides before a connection can be opened', () => {
    const base = 'postgresql://approved_role:secret@branch.example.test/approved_database';

    for (const parameter of [
      'host=override.example.test',
      'hostaddr=192.0.2.1',
      'port=6543',
      'user=override_role',
      'database=override_database',
      'db=override_database',
      'dbname=override_database',
      'service=override_service',
      'servicefile=override_service_file',
      'options=-c%20role%3Doverride_role',
      'role=override_role',
    ]) {
      expect(() => deriveDatabaseTargetFromConnectionString(`${base}?${parameter}`))
        .toThrow('target override query parameters');
    }

    const combinedOverride = `${base}?host=override.example.test&port=6543&user=override_role`;
    try {
      deriveDatabaseTargetFromConnectionString(combinedOverride);
      throw new Error('Expected connection target override rejection.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('target override query parameters');
      expect(message).not.toContain('override.example.test');
      expect(message).not.toContain('6543');
      expect(message).not.toContain('override_role');
    }

    expect(deriveDatabaseTargetFromConnectionString(`${base}?sslmode=require`)).toEqual({
      hostFingerprint: fingerprintDatabaseHost(base),
      database: 'approved_database',
      role: 'approved_role',
    });
  });

  it('rejects an ambient PGPORT target override unless the URL names its port', () => {
    const previousPgPort = process.env.PGPORT;
    process.env.PGPORT = '6543';
    try {
      expect(() => deriveDatabaseTargetFromConnectionString(
        'postgresql://approved_role:secret@branch.example.test/approved_database',
      )).toThrow('ambient connection target overrides');

      expect(deriveDatabaseTargetFromConnectionString(
        'postgresql://approved_role:secret@branch.example.test:5432/approved_database',
      )).toEqual({
        hostFingerprint: fingerprintDatabaseHost(
          'postgresql://approved_role:secret@branch.example.test:5432/approved_database',
        ),
        database: 'approved_database',
        role: 'approved_role',
      });
    } finally {
      if (previousPgPort === undefined) delete process.env.PGPORT;
      else process.env.PGPORT = previousPgPort;
    }
  });

  it('rejects ambient PostgreSQL startup options before a connection can be opened', () => {
    const previousPgOptions = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c role=override_role';
    try {
      expect(() => deriveDatabaseTargetFromConnectionString(
        'postgresql://approved_role:secret@branch.example.test:5432/approved_database',
      )).toThrow('ambient connection role overrides');
    } finally {
      if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previousPgOptions;
    }
  });

  it('validates explicit migration journal identifiers conservatively', () => {
    expect(parseMigrationJournalRelation('audit.__drizzle_migrations')).toEqual({
      schema: 'audit',
      table: '__drizzle_migrations',
    });
    for (const value of [
      '__drizzle_migrations',
      'public.journal.extra',
      'public."__drizzle_migrations"',
      'public.journal;drop_table',
      'public.journal-name',
    ]) {
      expect(() => parseMigrationJournalRelation(value)).toThrow('--journal-relation');
    }
  });

  it('defaults to the installed Drizzle journal and refuses ambiguous discovery', () => {
    expect(resolveApprovedMigrationJournal([])).toEqual({
      approvedRelation: DEFAULT_MIGRATION_JOURNAL_RELATION,
      selection: 'default',
      relationDiscovered: false,
    });
    const discovery = [
      { schema: 'drizzle', table: '__drizzle_migrations' },
      { schema: 'legacy', table: '__drizzle_migrations' },
    ];
    expect(() => resolveApprovedMigrationJournal(discovery)).toThrow('Multiple Drizzle migration journals');
    expect(resolveApprovedMigrationJournal(discovery, discovery[1])).toEqual({
      approvedRelation: discovery[1],
      selection: 'explicit',
      relationDiscovered: true,
    });
  });

  it('requires both read-only and repeatable-read transaction settings', () => {
    expect(() => assertInventoryTransactionMode('on', 'repeatable read')).not.toThrow();
    expect(() => assertInventoryTransactionMode('off', 'repeatable read')).toThrow('read-only');
    expect(() => assertInventoryTransactionMode('on', 'read committed')).toThrow('repeatable-read');
  });

  it('requires independently supplied Neon target metadata and distinct branch identifiers', () => {
    expect(() => parseRequiredExpectedTargetEnvironment({})).toThrow(
      'Required expected-target environment variable(s) are absent',
    );
    const environment: NodeJS.ProcessEnv = {
      DB_INVENTORY_EXPECTED_DATABASE: 'approved_database',
      DB_INVENTORY_EXPECTED_ROLE: 'approved_role',
      DB_INVENTORY_EXPECTED_HOST_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
      DB_INVENTORY_EXPECTED_NEON_BRANCH_ID: 'disposable-branch',
      DB_INVENTORY_EXPECTED_NEON_SOURCE_BRANCH_ID: 'production-branch',
    };
    expect(parseRequiredExpectedTargetEnvironment(environment)).toEqual({
      expectedTarget: {
        hostFingerprint: `sha256:${'a'.repeat(64)}`,
        database: 'approved_database',
        role: 'approved_role',
      },
      disposableBranchId: 'disposable-branch',
      productionSourceBranchId: 'production-branch',
    });
    expect(() => parseRequiredExpectedTargetEnvironment({
      ...environment,
      DB_INVENTORY_EXPECTED_NEON_BRANCH_ID: 'same-branch',
      DB_INVENTORY_EXPECTED_NEON_SOURCE_BRANCH_ID: 'same-branch',
    })).toThrow('branch identifiers match');

    const mismatch = () => assertExpectedDatabaseTarget({
      hostFingerprint: `sha256:${'b'.repeat(64)}`,
      database: 'actual_database',
      role: 'actual_role',
    }, {
      hostFingerprint: `sha256:${'a'.repeat(64)}`,
      database: 'approved_database',
      role: 'approved_role',
    });
    expect(mismatch).toThrow('endpoint fingerprint does not match');
    try {
      mismatch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('actual_database');
      expect(message).not.toContain('approved_database');
      expect(message).not.toContain('actual_role');
      expect(message).not.toContain('approved_role');
      expect(message).not.toContain('aaaa');
      expect(message).not.toContain('bbbb');
    }
  });

  it('classifies connected-role RLS enforcement using PostgreSQL bypass precedence', () => {
    const base = {
      rowSecurity: true,
      forceRowSecurity: false,
      connectedRoleOwnsTable: false,
      roleSuperuser: false,
      roleBypassRls: false,
    };
    expect(determineConnectedRoleRlsMode({ ...base, rowSecurity: false })).toBe('not-enabled');
    expect(determineConnectedRoleRlsMode({ ...base, roleSuperuser: true })).toBe('bypass-superuser');
    expect(determineConnectedRoleRlsMode({ ...base, roleBypassRls: true })).toBe('bypass-bypassrls');
    expect(determineConnectedRoleRlsMode({ ...base, connectedRoleOwnsTable: true })).toBe('bypass-owner');
    expect(determineConnectedRoleRlsMode({
      ...base,
      connectedRoleOwnsTable: true,
      forceRowSecurity: true,
    })).toBe('governed');
    expect(determineConnectedRoleRlsMode(base)).toBe('governed');
  });

  it('captures policy and privilege differences and identifies documented Neon auth dependencies', () => {
    const left = emptyInventory('left');
    left.tablePrivileges = [{
      schema: 'public', table: 'notes', grantor: 'owner', grantee: 'authenticated',
      privilege: 'select', grantable: false,
    }];
    const dependencies = [{
      kind: 'function' as const,
      schema: 'auth',
      name: 'user_id',
      identityArguments: '',
    }];
    left.policies = [{
      schema: 'public',
      table: 'notes',
      name: 'owner_access',
      command: 'all',
      mode: 'permissive',
      roles: ['authenticated'],
      appliesToConnectedRole: false,
      using: '(auth.user_id() = owner_id)',
      withCheck: '(auth.user_id() = owner_id)',
      dependencies,
      referenceSignals: detectPolicyReferenceSignals(
        ['authenticated'],
        '(auth.user_id() = owner_id)',
        '(auth.user_id() = owner_id)',
        dependencies,
      ),
    }];

    expect(left.policies[0].referenceSignals).toEqual({
      neonManagedFunctions: ['auth.user_id()'],
      neonManagedRoles: ['authenticated'],
      neonManagedSchemas: ['auth'],
      referencesJwtClaims: true,
      authObjects: ['auth.user_id', 'auth.user_id()'],
    });
    const comparison = compareDatabaseInventories(left, emptyInventory('right'));
    expect(comparison.categories.tablePrivileges.missingFromRight).toEqual([
      'public.notes.authenticated.select.owner',
    ]);
    expect(comparison.categories.policies.missingFromRight).toEqual(['public.notes.owner_access']);
  });

  it('preflights all nine currently tracked migrations with the narrow allowlist', () => {
    const plan = loadTrackedJournalReplayPlan();
    expect(plan).toHaveLength(8);
    expect(new Set(plan.flatMap((migration) => migration.statements.map((statement) => statement.category))))
      .toEqual(new Set([
        'create-enum-type',
        'create-table',
        'create-index',
        'alter-table-add-column',
        'alter-table-add-foreign-key',
        'alter-table-set-not-null',
      ]));
  });

  it.each([
    ['DROP TABLE', 'DROP TABLE public.users', 'destructive DROP TABLE'],
    ['DROP COLUMN', 'ALTER TABLE public.users DROP COLUMN email', 'destructive DROP COLUMN'],
    ['DROP FUNCTION', 'DROP FUNCTION public.enforce_tenant()', 'destructive DROP FUNCTION'],
    ['DROP PROCEDURE', 'DROP PROCEDURE public.rotate_keys()', 'destructive DROP PROCEDURE'],
    ['DROP VIEW', 'DROP VIEW public.user_report', 'destructive DROP VIEW'],
    ['DROP MATERIALIZED VIEW', 'DROP MATERIALIZED VIEW public.user_report', 'destructive DROP MATERIALIZED VIEW'],
    ['DROP TYPE', 'DROP TYPE public.user_role', 'destructive DROP TYPE'],
    ['DROP EXTENSION', 'DROP EXTENSION pgcrypto', 'destructive DROP EXTENSION'],
    ['TRUNCATE', 'TRUNCATE public.users', 'destructive TRUNCATE'],
    ['DELETE', 'DELETE FROM public.users', 'data statement DELETE'],
    ['UPDATE', 'UPDATE public.users SET email = NULL', 'data statement UPDATE'],
    ['INSERT', "INSERT INTO public.users(email) VALUES ('x@example.test')", 'data statement INSERT'],
    ['privilege', 'GRANT SELECT ON public.users TO app_reader', 'privilege operation GRANT'],
    ['ownership', 'ALTER TABLE public.users OWNER TO app_owner', 'ownership operation'],
    ['role', 'CREATE ROLE unexpected', 'role operation CREATE ROLE'],
    ['schema', 'CREATE SCHEMA unexpected', 'schema operation CREATE SCHEMA'],
    ['database', 'CREATE DATABASE unexpected', 'database operation CREATE DATABASE'],
  ])('rejects unsafe tracked SQL before replay: %s', (_label, sql, expectedCategory) => {
    expect(() => preflightJournalSql('unsafe_case', `${sql};`)).toThrow(expectedCategory);
  });

  it('cannot bypass SQL classification with comments, casing, or spacing', () => {
    expect(preflightJournalSql(
      'safe_case',
      '/* reviewed */ CrEaTe\n\tTaBlE "safe_table" ("id" integer);',
    )[0].category).toBe('create-table');
    expect(() => preflightJournalSql(
      'unsafe_case',
      'DrOp/**/\n FuNcTiOn public.dangerous();',
    )).toThrow(/destructive DROP FUNCTION/);
    expect(() => preflightJournalSql(
      'unsafe_case',
      'CREATE TABLE "safe" ("id" integer); DROP TABLE "safe";',
    )).toThrow(/multiple SQL statements/);
  });

  it('treats statement breakpoints only as exact unquoted Drizzle marker comments', () => {
    const quotedMarkers = preflightJournalSql(
      'quoted_markers',
      [
        'CREATE TABLE "safe" (',
        "  \"single_value\" text DEFAULT '--> statement-breakpoint; still literal',",
        '  "dollar_value" text DEFAULT $$--> statement-breakpoint; still body$$',
        '  /* --> statement-breakpoint */',
        '  "id" integer',
        ');',
      ].join('\n'),
    );
    expect(quotedMarkers).toHaveLength(1);
    expect(quotedMarkers[0].category).toBe('create-table');

    const separateSegments = preflightJournalSql(
      'real_breakpoint',
      'CREATE TABLE "first" ("id" integer);--> statement-breakpoint\nCREATE TABLE "second" ("id" integer);',
    );
    expect(separateSegments).toHaveLength(2);
  });

  it.each([
    ['dynamic DO', 'DO $$ BEGIN EXECUTE \'SELECT 1\'; END $$'],
    ['dynamic CALL', 'CALL public.rotate_keys()'],
    ['function definition', 'CREATE FUNCTION public.dangerous() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql'],
    ['view definition', 'CREATE VIEW public.dangerous AS SELECT 1'],
    ['extension installation', 'CREATE EXTENSION dblink'],
    ['multi-action add column', 'ALTER TABLE public.users ADD COLUMN safe integer, DROP COLUMN email'],
    ['multi-action foreign key', 'ALTER TABLE public.users ADD CONSTRAINT safe_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id), DROP COLUMN email'],
  ])('rejects unreviewed or dynamically executable SQL categories: %s', (_label, sql) => {
    expect(() => preflightJournalSql('unsupported_case', `${sql};`)).toThrow(/Refusing tracked migration/);
  });

  it('does not hide a second statement after quoted or dollar-quoted content', () => {
    expect(() => preflightJournalSql(
      'hidden_second',
      "CREATE TABLE safe (value text DEFAULT 'literal; value'); DROP TABLE safe;",
    )).toThrow(/multiple SQL statements/);
    expect(() => preflightJournalSql(
      'hidden_second',
      'CREATE TABLE safe (value text DEFAULT $$literal; value$$); DO $$ BEGIN NULL; END $$;',
    )).toThrow(/multiple SQL statements/);
  });

  it('normalizes harmless SQL whitespace without changing quoted content', () => {
    expect(normalizeSqlDefinition(
      'CREATE  INDEX idx  ON public.users USING btree (email)',
    )).toBe(normalizeSqlDefinition(
      'CREATE INDEX idx ON public.users USING btree (email)',
    ));
    expect(normalizeSqlDefinition("CHECK (value = 'two  spaces')"))
      .toContain("'two  spaces'");
    expect(normalizeSqlDefinition('CHECK ("two  spaces" IS NOT NULL)'))
      .toContain('"two  spaces"');
    const functionDefinition = 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  PERFORM  1;\nEND\n$$ LANGUAGE plpgsql';
    expect(normalizeSqlDefinition(functionDefinition)).toContain('$$\nBEGIN\n  PERFORM  1;\nEND\n$$');
  });

  it('preserves quoted and dollar-quoted content byte-for-byte', () => {
    const quoted = "CHECK (value = 'first line  \r\nsecond  line ')";
    const dollarQuoted = 'CREATE FUNCTION f() RETURNS text AS $body$\r\nfirst line  \r\nsecond  line\r\n$body$ LANGUAGE sql';
    const quotedIdentifier = 'CHECK ("first  line\r\nsecond " IS NOT NULL)';
    expect(normalizeSqlDefinition(quoted)).toContain("'first line  \r\nsecond  line '");
    expect(normalizeSqlDefinition(dollarQuoted)).toContain('$body$\r\nfirst line  \r\nsecond  line\r\n$body$');
    expect(normalizeSqlDefinition(quotedIdentifier)).toContain('"first  line\r\nsecond "');
    expect(normalizeSqlDefinition("CHECK ('unterminated  \r\n")).toBe("CHECK ('unterminated  \r\n");
  });

  it('ignores safe definition formatting but detects material definition changes', () => {
    const left = emptyInventory('left');
    left.indexes = [{
      schema: 'public', table: 'users', name: 'users_email_idx', accessMethod: 'btree',
      definition: 'CREATE INDEX users_email_idx  ON public.users USING btree (email)',
      predicate: null, unique: false, primary: false, exclusion: false, valid: true,
      ready: true, clustered: false, replicaIdentity: false,
    }];
    const cosmetic = structuredClone(left);
    cosmetic.indexes[0].definition = 'CREATE INDEX users_email_idx ON public.users USING btree (email)';
    expect(compareDatabaseInventories(left, cosmetic).hasDifferences).toBe(false);

    const material = structuredClone(left);
    material.indexes[0].unique = true;
    material.indexes[0].definition = 'CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)';
    expect(compareDatabaseInventories(left, material).categories.indexes.changed).toEqual([
      { key: 'public.users.users_email_idx', fields: ['definition', 'unique'] },
    ]);
  });

  it('uses invocation-specific artifact paths for concurrent validators', () => {
    const first = createInventoryRunId(new Date('2026-07-14T00:00:00Z'), 'aaaaaaaaaaaa');
    const second = createInventoryRunId(new Date('2026-07-14T00:00:00Z'), 'bbbbbbbbbbbb');
    expect(first).not.toBe(second);
    expect(inventoryArtifactDirectory(first)).not.toBe(inventoryArtifactDirectory(second));
  });

  it('refuses cleanup on ownership mismatch without issuing stop or remove', () => {
    const container: OwnedInventoryContainer = {
      id: 'a'.repeat(64),
      name: 'owned-container',
      runId: 'expected-run',
    };
    const calls: string[][] = [];
    const runner: DockerRunner = (args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: `${container.id}|different-run\n`,
        stderr: '',
      };
    };
    expect(() => cleanupOwnedContainer(container, runner)).toThrow('ownership label mismatch');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('inspect');
  });

  it('reports cleanup failure after a verified stop and fallback removal failure', () => {
    const container: OwnedInventoryContainer = {
      id: 'b'.repeat(64),
      name: 'owned-container',
      runId: 'expected-run',
    };
    const results: DockerCommandResult[] = [
      { status: 0, stdout: `${container.id}|${container.runId}\n`, stderr: '' },
      { status: 1, stdout: '', stderr: 'stop failed' },
      { status: 0, stdout: `${container.id}|${container.runId}\n`, stderr: '' },
      { status: 1, stdout: '', stderr: 'remove failed' },
    ];
    const calls: string[][] = [];
    const runner: DockerRunner = (args) => {
      calls.push(args);
      const result = results.shift();
      if (!result) throw new Error('Unexpected Docker call.');
      return result;
    };
    expect(() => cleanupOwnedContainer(container, runner)).toThrow(
      'Cleanup failed for the verified inventory container',
    );
    expect(calls.map((args) => args[0])).toEqual(['inspect', 'stop', 'inspect', 'rm']);
    expect(calls[1]).toContain(container.id);
    expect(calls[3]).toContain(container.id);
  });
});
