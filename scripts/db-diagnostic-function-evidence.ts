import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg, { type QueryResultRow } from 'pg';
import {
  assertExpectedConnectionUrlTarget,
  assertExpectedDatabaseTarget,
  deriveDatabaseTargetFromConnectionString,
  parseRequiredExpectedTargetEnvironment,
  redactConnectionDetails,
} from './lib/db-schema-inventory';

interface FunctionRow extends QueryResultRow {
  function_oid: string;
  schema_name: string;
  function_name: string;
  identity_arguments: string;
  result_type: string;
  language_name: string;
  function_kind: 'function' | 'procedure' | 'aggregate' | 'window';
  volatility: 'immutable' | 'stable' | 'volatile';
  parallel_safety: 'safe' | 'restricted' | 'unsafe';
  security_definer: boolean;
  strict: boolean;
  leakproof: boolean;
  owner_name: string;
  explicit_acl_present: boolean;
  definition: string;
}

interface DirectAclRow extends QueryResultRow {
  grantee: string;
  grantor: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface EffectiveExecuteRow extends QueryResultRow {
  role_name: string;
  can_execute: boolean;
}

interface DependentRow extends QueryResultRow {
  dependency_type: string;
  dependent_catalog: string;
  dependent_object_oid: string;
  dependent_object_sub_id: number;
  dependent_identity: string;
}

interface TargetRow extends QueryResultRow {
  database_name: string;
  role_name: string;
  server_version: string;
}

export const FUNCTION_METADATA_SQL = `
  SELECT
    p.oid::text AS function_oid,
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    pg_catalog.pg_get_function_result(p.oid) AS result_type,
    language.lanname AS language_name,
    CASE p.prokind
      WHEN 'f' THEN 'function'
      WHEN 'p' THEN 'procedure'
      WHEN 'a' THEN 'aggregate'
      WHEN 'w' THEN 'window'
    END AS function_kind,
    CASE p.provolatile
      WHEN 'i' THEN 'immutable'
      WHEN 's' THEN 'stable'
      ELSE 'volatile'
    END AS volatility,
    CASE p.proparallel
      WHEN 's' THEN 'safe'
      WHEN 'r' THEN 'restricted'
      ELSE 'unsafe'
    END AS parallel_safety,
    p.prosecdef AS security_definer,
    p.proisstrict AS strict,
    p.proleakproof AS leakproof,
    owner.rolname AS owner_name,
    p.proacl IS NOT NULL AS explicit_acl_present,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language language ON language.oid = p.prolang
  JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
  WHERE n.nspname = $1
    AND p.proname = $2
    AND p.pronargs = 0
    AND p.prokind = 'f'
  ORDER BY p.oid
`;

export const FUNCTION_ACL_SQL = `
  SELECT
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
    grantor.rolname AS grantor,
    acl.privilege_type,
    acl.is_grantable
  FROM pg_catalog.pg_proc p
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
  ) AS acl
  LEFT JOIN pg_catalog.pg_roles grantee
    ON grantee.oid = acl.grantee AND acl.grantee <> 0
  LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid = acl.grantor
  WHERE p.oid = $1::oid
  ORDER BY grantee, grantor, acl.privilege_type, acl.is_grantable
`;

export const EFFECTIVE_FUNCTION_EXECUTE_SQL = `
  SELECT
    role.rolname AS role_name,
    pg_catalog.has_function_privilege(role.oid, p.oid, 'EXECUTE') AS can_execute
  FROM pg_catalog.pg_proc p
  CROSS JOIN pg_catalog.pg_roles role
  WHERE p.oid = $1::oid
  ORDER BY role.rolname
`;

export const FUNCTION_DEPENDENTS_SQL = `
  SELECT
    d.deptype AS dependency_type,
    d.classid::pg_catalog.regclass::text AS dependent_catalog,
    d.objid::text AS dependent_object_oid,
    d.objsubid AS dependent_object_sub_id,
    pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent_identity
  FROM pg_catalog.pg_depend d
  WHERE d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    AND d.refobjid = $1::oid
  ORDER BY d.classid, d.objid, d.objsubid, d.deptype
`;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is absent.`);
  return value;
}

export async function collectDiagnosticFunctionEvidence(): Promise<void> {
  if (process.env.NEON_API_KEY) {
    throw new Error('Refusing PostgreSQL evidence collection while the Neon API credential is present.');
  }

  const connectionString = requiredEnvironment('DATABASE_URL');
  const evidencePath = resolve(requiredEnvironment('FUNCTION_EVIDENCE_PATH'));
  const target = parseRequiredExpectedTargetEnvironment(process.env);
  const connectionTarget = deriveDatabaseTargetFromConnectionString(connectionString);
  const parsedUrl = new URL(connectionString);
  if (parsedUrl.hostname.includes('-pooler')) {
    throw new Error('Function evidence requires the independently verified direct Neon endpoint.');
  }
  if (parsedUrl.port && parsedUrl.port !== '5432') {
    throw new Error('Function evidence received an unexpected PostgreSQL port.');
  }
  assertExpectedConnectionUrlTarget(connectionString, target.expectedTarget);

  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-schema-function-evidence',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const readOnlyResult = await client.query('SHOW transaction_read_only');
    const isolationResult = await client.query('SHOW transaction_isolation');
    const transactionReadOnly = readOnlyResult.rows[0]?.transaction_read_only;
    const transactionIsolation = isolationResult.rows[0]?.transaction_isolation;
    if (transactionReadOnly !== 'on' || transactionIsolation !== 'repeatable read') {
      throw new Error('Function evidence transaction is not repeatable-read and read-only.');
    }

    const targetResult = await client.query<TargetRow>(`
      SELECT
        current_database() AS database_name,
        current_user AS role_name,
        current_setting('server_version') AS server_version
    `);
    const actualTarget = targetResult.rows[0];
    if (!actualTarget) throw new Error('PostgreSQL did not return diagnostic target metadata.');
    assertExpectedDatabaseTarget({
      hostFingerprint: connectionTarget.hostFingerprint,
      database: actualTarget.database_name,
      role: actualTarget.role_name,
    }, target.expectedTarget);

    const functionResult = await client.query<FunctionRow>(FUNCTION_METADATA_SQL, [
      'public',
      'show_db_tree',
    ]);

    if (functionResult.rows.length !== 1) {
      throw new Error('Expected exactly one public.show_db_tree() function on the verified snapshot child.');
    }
    const fn = functionResult.rows[0];
    const directAclResult = await client.query<DirectAclRow>(FUNCTION_ACL_SQL, [fn.function_oid]);

    const effectiveExecuteResult = await client.query<EffectiveExecuteRow>(
      EFFECTIVE_FUNCTION_EXECUTE_SQL,
      [fn.function_oid],
    );

    const dependentResult = await client.query<DependentRow>(FUNCTION_DEPENDENTS_SQL, [fn.function_oid]);

    const evidence = {
      formatVersion: 1,
      incident: {
        migrationFailureRunId: requiredEnvironment('INCIDENT_RUN_ID'),
        migrationFailureSha: requiredEnvironment('INCIDENT_SHA'),
        diagnosticRunId: requiredEnvironment('GITHUB_RUN_ID'),
        diagnosticRunAttempt: requiredEnvironment('GITHUB_RUN_ATTEMPT'),
        mainSha: requiredEnvironment('EXPECTED_SHA'),
      },
      lineage: {
        productionSourceBranchId: target.productionSourceBranchId,
        disposableBranchId: target.disposableBranchId,
        endpointHostFingerprint: target.expectedTarget.hostFingerprint,
      },
      target: {
        database: actualTarget.database_name,
        role: actualTarget.role_name,
        serverVersion: actualTarget.server_version,
        transactionReadOnly,
        transactionIsolation,
      },
      function: {
        schema: fn.schema_name,
        name: fn.function_name,
        identityArguments: fn.identity_arguments,
        resultType: fn.result_type,
        kind: fn.function_kind,
        language: fn.language_name,
        volatility: fn.volatility,
        parallel: fn.parallel_safety,
        securityDefiner: fn.security_definer,
        strict: fn.strict,
        leakproof: fn.leakproof,
        owner: fn.owner_name,
        explicitAclPresent: fn.explicit_acl_present,
        definitionSha256: createHash('sha256').update(fn.definition, 'utf8').digest('hex'),
        definitionSha256Input: 'UTF-8 text returned by pg_catalog.pg_get_functiondef',
        definition: fn.definition,
      },
      acl: {
        entriesSource: fn.explicit_acl_present ? 'pg_proc.proacl' : "acldefault('f', proowner)",
        directEntries: directAclResult.rows.map((row) => ({
          grantee: row.grantee,
          grantor: row.grantor,
          privilege: row.privilege_type,
          grantable: row.is_grantable,
        })),
        effectiveExecuteByRole: effectiveExecuteResult.rows.map((row) => ({
          role: row.role_name,
          canExecute: row.can_execute,
        })),
      },
      pgDependDependents: dependentResult.rows.map((row) => ({
        dependencyType: row.dependency_type,
        dependentCatalog: row.dependent_catalog,
        dependentObjectOid: row.dependent_object_oid,
        dependentObjectSubId: row.dependent_object_sub_id,
        identity: row.dependent_identity,
      })),
      dependencyCoverage: 'pg_depend edges only; application/runtime callers are not catalog dependencies.',
    };

    await client.query('COMMIT');
    transactionStarted = false;

    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodSync(evidencePath, 0o600);

    const effectiveExecuteCount = evidence.acl.effectiveExecuteByRole
      .filter((entry) => entry.canExecute).length;
    process.stdout.write(
      `[schema-diagnostic] public.show_db_tree() ` +
      `definition_sha256=sha256:${evidence.function.definitionSha256} ` +
      `direct_acl_entries=${evidence.acl.directEntries.length} ` +
      `roles_with_execute=${effectiveExecuteCount} ` +
      `pg_depend_dependents=${evidence.pgDependDependents.length}\n`,
    );
    process.stdout.write(`[schema-diagnostic] function evidence prepared for encryption at ${evidencePath}\n`);
    const githubOutput = requiredEnvironment('GITHUB_OUTPUT');
    appendFileSync(githubOutput, [
      `function_definition_sha256=sha256:${evidence.function.definitionSha256}`,
      `function_direct_acl_entry_count=${evidence.acl.directEntries.length}`,
      `function_effective_execute_role_count=${effectiveExecuteCount}`,
      `function_pg_depend_dependent_count=${evidence.pgDependDependents.length}`,
    ].join('\n') + '\n');
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  collectDiagnosticFunctionEvidence().catch((error: unknown) => {
    const connectionString = process.env.DATABASE_URL;
    const message = error instanceof Error ? error.message : String(error);
    let redacted = redactConnectionDetails(message, connectionString);
    for (const key of [
      'DB_INVENTORY_EXPECTED_DATABASE',
      'DB_INVENTORY_EXPECTED_ROLE',
      'DB_INVENTORY_EXPECTED_HOST_FINGERPRINT',
      'DB_INVENTORY_EXPECTED_NEON_BRANCH_ID',
      'DB_INVENTORY_EXPECTED_NEON_SOURCE_BRANCH_ID',
    ]) {
      const value = process.env[key]?.trim();
      if (value) redacted = redacted.replaceAll(value, '[target metadata redacted]');
    }
    process.stderr.write(`[schema-function-evidence] failed: ${redacted}\n`);
    process.exitCode = 1;
  });
}
