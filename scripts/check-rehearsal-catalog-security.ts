import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg, { type QueryResultRow } from "pg";
import {
  assertExpectedConnectionUrlTarget,
  type ExpectedDatabaseTarget,
} from "./lib/db-schema-inventory";
import {
  assertShowDbTreeCatalogSecurityState,
  type ShowDbTreeCatalogSecurityState,
} from "./lib/production-show-db-tree-repair";

const EXPECTED_DATABASE = "neondb";
const EXPECTED_ROLE = "neondb_owner";
const EXPECTED_HOST_FINGERPRINT_ENV =
  "DB_REHEARSAL_CATALOG_EXPECTED_HOST_FINGERPRINT";

interface CatalogFunctionRow extends QueryResultRow {
  owner: string;
  explicitAclPresent: boolean;
  definition: string;
  acl: ShowDbTreeCatalogSecurityState["acl"];
}

interface CatalogDependentRow extends QueryResultRow {
  classId: string;
  objectId: string;
  objectSubId: string;
  dependencyType: string;
  description: string;
}

class CatalogPrecheckError extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

function expectedTargetFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ExpectedDatabaseTarget {
  const hostFingerprint =
    environment[EXPECTED_HOST_FINGERPRINT_ENV]?.trim() ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(hostFingerprint)) {
    throw new CatalogPrecheckError("child_endpoint_fingerprint");
  }
  return {
    hostFingerprint,
    database: EXPECTED_DATABASE,
    role: EXPECTED_ROLE,
  };
}

function assertDirectVerifiedTlsUrl(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new CatalogPrecheckError("database_url");
  }
  if (
    !/^postgres(ql)?:$/.test(parsed.protocol) ||
    parsed.hostname.toLowerCase().includes("-pooler") ||
    parsed.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new CatalogPrecheckError("direct_verified_tls_endpoint");
  }
}

function catalogGuardFailureField(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const field = message.match(
    /^The show_db_tree catalog guard failed: (raw definition hash|owner|explicit ACL|expanded ACL|dependency) mismatch\.$/,
  )?.[1];
  switch (field) {
    case "raw definition hash":
      return "raw_definition_sha256";
    case "owner":
      return "owner";
    case "explicit ACL":
      return "proacl_null";
    case "expanded ACL":
      return "expanded_acl";
    case "dependency":
      return "pg_depend_zero";
    default:
      return "catalog_guard";
  }
}

async function checkRehearsalCatalogSecurity(): Promise<void> {
  if (process.env.NEON_API_KEY !== undefined) {
    throw new CatalogPrecheckError("control_plane_key_present");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new CatalogPrecheckError("database_url_missing");
  }
  assertDirectVerifiedTlsUrl(connectionString);
  const expectedTarget = expectedTargetFromEnvironment(process.env);
  try {
    assertExpectedConnectionUrlTarget(connectionString, expectedTarget);
  } catch {
    throw new CatalogPrecheckError("child_endpoint_target");
  }

  const client = new pg.Client({
    connectionString,
    application_name: "leaguevault-rehearsal-catalog-security-check",
    connectionTimeoutMillis: 10_000,
  });
  let connected = false;
  let transactionOpen = false;

  try {
    await client.connect();
    connected = true;
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '10s'");

    const targetResult = await client.query<{
      databaseName: string;
      roleName: string;
      transactionReadOnly: string;
      transactionIsolation: string;
    }>(`
      SELECT
        current_database() AS "databaseName",
        current_user AS "roleName",
        current_setting('transaction_read_only') AS "transactionReadOnly",
        current_setting('transaction_isolation') AS "transactionIsolation"
    `);
    const target = targetResult.rows[0];
    if (
      targetResult.rows.length !== 1 ||
      target?.databaseName !== EXPECTED_DATABASE ||
      target.roleName !== EXPECTED_ROLE ||
      target.transactionReadOnly !== "on" ||
      target.transactionIsolation !== "repeatable read"
    ) {
      throw new CatalogPrecheckError("read_only_child_target");
    }

    const functionResult = await client.query<CatalogFunctionRow>(`
      WITH target_function AS (
        SELECT procedure.oid, procedure.proowner, procedure.proacl,
          pg_catalog.pg_get_functiondef(procedure.oid) AS definition
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'show_db_tree'
          AND procedure.prokind = 'f'
          AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
      )
      SELECT
        pg_catalog.pg_get_userbyid(target_function.proowner) AS owner,
        (target_function.proacl IS NOT NULL) AS "explicitAclPresent",
        target_function.definition,
        COALESCE(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'grantor', pg_catalog.pg_get_userbyid(expanded_acl.grantor),
              'grantee', CASE
                WHEN expanded_acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_catalog.pg_get_userbyid(expanded_acl.grantee)
              END,
              'privilegeType', expanded_acl.privilege_type,
              'isGrantable', expanded_acl.is_grantable
            )
            ORDER BY expanded_acl.grantor, expanded_acl.grantee,
              expanded_acl.privilege_type, expanded_acl.is_grantable
          ) FILTER (WHERE expanded_acl.grantee IS NOT NULL),
          '[]'::pg_catalog.jsonb
        ) AS acl
      FROM target_function
      LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          target_function.proacl,
          pg_catalog.acldefault('f'::"char", target_function.proowner)
        )
      ) AS expanded_acl ON true
      GROUP BY target_function.oid, target_function.proowner,
        (target_function.proacl IS NOT NULL), target_function.definition
    `);
    if (functionResult.rows.length !== 1 || !functionResult.rows[0]) {
      throw new CatalogPrecheckError("target_function_count");
    }

    const dependentResult = await client.query<CatalogDependentRow>(`
      SELECT
        dependency.classid::pg_catalog.regclass::text AS "classId",
        dependency.objid::text AS "objectId",
        dependency.objsubid::text AS "objectSubId",
        dependency.deptype AS "dependencyType",
        pg_catalog.pg_describe_object(
          dependency.classid,
          dependency.objid,
          dependency.objsubid
        ) AS description
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.refobjid = procedure.oid
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'show_db_tree'
        AND procedure.prokind = 'f'
        AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
      ORDER BY dependency.classid, dependency.objid,
        dependency.objsubid, dependency.deptype
    `);

    const row = functionResult.rows[0];
    const actual: ShowDbTreeCatalogSecurityState = {
      owner: row.owner,
      explicitAclPresent: row.explicitAclPresent,
      rawDefinitionSha256: createHash("sha256")
        .update(row.definition, "utf8")
        .digest("hex"),
      acl: row.acl,
      dependents: dependentResult.rows,
    };
    try {
      assertShowDbTreeCatalogSecurityState(actual);
    } catch (error) {
      throw new CatalogPrecheckError(catalogGuardFailureField(error));
    }

    await client.query("COMMIT");
    transactionOpen = false;
    process.stdout.write(
      "[catalog-precheck] pass fields=child_endpoint_target,read_only_repeatable_read,target_function_count,raw_definition_sha256,owner,proacl_null,expanded_acl,pg_depend_zero\n",
    );
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
    }
    if (error instanceof CatalogPrecheckError) throw error;
    throw new CatalogPrecheckError("database_read");
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  checkRehearsalCatalogSecurity().catch((error: unknown) => {
    const field =
      error instanceof CatalogPrecheckError ? error.field : "database_read";
    process.stderr.write(`[catalog-precheck] fail field=${field}\n`);
    process.exitCode = 1;
  });
}
