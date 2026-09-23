import pg from "pg";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadActiveMigrations } from "./lib/db-migration-assets";
import {
  assertJournalPrefix,
  inspectApprovedJournal,
  type JournalEntryRow,
} from "./lib/db-migration-journal";
import {
  assertExpectedConnectionUrlTarget,
  collectDatabaseInventoryOnClient,
  redactConnectionDetails,
  type ExpectedDatabaseTarget,
} from "./lib/db-schema-inventory";
import {
  createSchemaStateFingerprint,
  verifyApprovedSchemaStateOnClient,
} from "./lib/db-schema-state-fingerprint";
import { DATABASE_SCHEMA_WRITER_LOCK_KEY } from "../shared/database-advisory-locks";
import {
  assertExactShowDbTreeInventory,
  assertShowDbTreeCatalogSecurityState,
  assertShowDbTreeRepairConfirmation,
  assertShowDbTreeRepairJournalBoundary,
  assertShowDbTreeRepairPreFingerprint,
  SHOW_DB_TREE_REPAIR_0049_TAG,
  SHOW_DB_TREE_REPAIR_0050_TAG,
  SHOW_DB_TREE_REPAIR_POST_DIGEST,
  SHOW_DB_TREE_REPAIR_ENVIRONMENT_KEY,
  type ShowDbTreeCatalogSecurityState,
} from "./lib/production-show-db-tree-repair";

const EXPECTED_DATABASE = "neondb";
const EXPECTED_ROLE = "neondb_owner";
const EXPECTED_HOST_FINGERPRINT_ENV =
  "DB_PRODUCTION_SCHEMA_REPAIR_EXPECTED_HOST_FINGERPRINT";

interface ShowDbTreeSecurityRow {
  owner: string;
  explicitAclPresent: boolean;
  definition: string;
  acl: ShowDbTreeCatalogSecurityState["acl"];
}

interface ShowDbTreeDependentRow {
  classId: string;
  objectId: string;
  objectSubId: string;
  dependencyType: string;
  description: string;
}

function expectedTargetFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ExpectedDatabaseTarget {
  const hostFingerprint =
    environment[EXPECTED_HOST_FINGERPRINT_ENV]?.trim() ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(hostFingerprint)) {
    throw new Error(
      `${EXPECTED_HOST_FINGERPRINT_ENV} must contain a lowercase SHA-256 endpoint fingerprint.`,
    );
  }
  return { hostFingerprint, database: EXPECTED_DATABASE, role: EXPECTED_ROLE };
}

function assertDirectVerifiedTlsUrl(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (parsed.hostname.toLowerCase().includes("-pooler")) {
    throw new Error(
      "Production schema repair requires a direct Neon endpoint.",
    );
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Production schema repair requires sslmode=verify-full.");
  }
}

async function inspectShowDbTreeCatalogSecurityState(
  client: pg.Client,
): Promise<ShowDbTreeCatalogSecurityState> {
  const functionResult = await client.query<ShowDbTreeSecurityRow>(`
    WITH target_function AS (
      SELECT procedure.oid, procedure.proowner, procedure.proacl,
        pg_catalog.pg_get_functiondef(procedure.oid) AS definition
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
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
      COALESCE(target_function.proacl, pg_catalog.acldefault('f'::"char", target_function.proowner))
    ) AS expanded_acl ON true
    GROUP BY target_function.oid, target_function.proowner,
      (target_function.proacl IS NOT NULL), target_function.definition
  `);
  if (functionResult.rows.length !== 1 || !functionResult.rows[0]) {
    throw new Error(
      "Production repair could not read exactly one show_db_tree owner and ACL.",
    );
  }

  const dependentResult = await client.query<ShowDbTreeDependentRow>(`
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
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.refobjid = procedure.oid
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'show_db_tree'
      AND procedure.prokind = 'f'
      AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
    ORDER BY dependency.classid, dependency.objid, dependency.objsubid, dependency.deptype
  `);

  return {
    owner: functionResult.rows[0].owner,
    explicitAclPresent: functionResult.rows[0].explicitAclPresent,
    rawDefinitionSha256: createHash("sha256")
      .update(functionResult.rows[0].definition)
      .digest("hex"),
    acl: functionResult.rows[0].acl,
    dependents: dependentResult.rows,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function lockPublicRelations(client: pg.Client): Promise<void> {
  const relations = await client.query<{
    schemaName: string;
    relationName: string;
  }>(`
    SELECT
      namespace.nspname AS "schemaName",
      relation.relname AS "relationName"
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY namespace.nspname, relation.relname
  `);
  for (const relation of relations.rows) {
    await client.query(
      `LOCK TABLE ${quoteIdentifier(relation.schemaName)}.${quoteIdentifier(relation.relationName)} ` +
        "IN ACCESS SHARE MODE",
    );
  }
}

function assertJournalUnchanged(
  beforeEntries: readonly JournalEntryRow[],
  beforeSequence: { lastValue: string; isCalled: boolean } | null,
  afterEntries: readonly JournalEntryRow[],
  afterSequence: { lastValue: string; isCalled: boolean } | null,
): void {
  if (
    JSON.stringify(beforeEntries) !== JSON.stringify(afterEntries) ||
    JSON.stringify(beforeSequence) !== JSON.stringify(afterSequence)
  ) {
    throw new Error(
      "Production repair unexpectedly changed the migration journal or its sequence.",
    );
  }
}

export async function repairProductionShowDbTree(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertShowDbTreeRepairConfirmation(
    environment[SHOW_DB_TREE_REPAIR_ENVIRONMENT_KEY],
  );
  if (environment.NEON_API_KEY?.trim()) {
    throw new Error(
      "NEON_API_KEY must not be present in the database repair process.",
    );
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required for this production repair.");
  const expectedTarget = expectedTargetFromEnvironment(environment);
  assertDirectVerifiedTlsUrl(connectionString);
  assertExpectedConnectionUrlTarget(connectionString, expectedTarget);

  const migrations = loadActiveMigrations();
  const currentMigrationForExpectedHistory = migrations[49];
  if (
    currentMigrationForExpectedHistory?.tag !== SHOW_DB_TREE_REPAIR_0049_TAG
  ) {
    throw new Error(
      "Checked-in migration history does not contain the expected 0049 boundary.",
    );
  }
  const client = new pg.Client({
    connectionString,
    application_name: "leaguevault-production-show-db-tree-repair-35824851019",
  });
  let connected = false;
  let sessionLockHeld = false;
  let transactionOpen = false;

  try {
    await client.connect();
    connected = true;
    await client.query("SET statement_timeout = '30s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SELECT pg_catalog.pg_advisory_lock($1)", [
      DATABASE_SCHEMA_WRITER_LOCK_KEY,
    ]);
    sessionLockHeld = true;

    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await lockPublicRelations(client);

    const journal = await inspectApprovedJournal(client, { lock: true });
    if (!journal.exists || !journal.sequenceState) {
      throw new Error(
        "Production repair requires the existing approved migration journal.",
      );
    }
    assertJournalPrefix(journal.entries, migrations);
    const currentMigration = assertShowDbTreeRepairJournalBoundary(
      journal.entries,
      migrations,
    );
    if (currentMigration !== currentMigrationForExpectedHistory) {
      throw new Error(
        "Production repair journal boundary did not resolve to the pinned 0049 migration.",
      );
    }
    const pending = migrations
      .slice(journal.entries.length)
      .map((migration) => migration.tag);
    if (pending.length !== 1 || pending[0] !== SHOW_DB_TREE_REPAIR_0050_TAG) {
      throw new Error(
        "Production repair requires exactly 0050_rotating_team_payments to remain pending.",
      );
    }

    const inventory = await collectDatabaseInventoryOnClient(
      client,
      connectionString,
      { expectedTarget },
    );
    if (
      inventory.target.transactionIsolation !== "serializable" ||
      inventory.target.transactionReadOnly ||
      inventory.target.hostFingerprint !== expectedTarget.hostFingerprint ||
      inventory.target.database !== expectedTarget.database ||
      inventory.target.role !== expectedTarget.role
    ) {
      throw new Error(
        "Connected production target or transaction mode does not match the approved repair target.",
      );
    }
    const observedFingerprint = createSchemaStateFingerprint(
      inventory,
      currentMigration,
    );
    assertShowDbTreeRepairPreFingerprint(observedFingerprint, currentMigration);
    assertExactShowDbTreeInventory(inventory);

    const catalogSecurityState =
      await inspectShowDbTreeCatalogSecurityState(client);
    assertShowDbTreeCatalogSecurityState(catalogSecurityState);

    await client.query("DROP FUNCTION public.show_db_tree() RESTRICT");

    const repairedFingerprint = await verifyApprovedSchemaStateOnClient(
      client,
      connectionString,
      currentMigration,
      undefined,
      expectedTarget,
    );
    if (repairedFingerprint.digest !== SHOW_DB_TREE_REPAIR_POST_DIGEST) {
      throw new Error(
        "Production repair did not restore the canonical approved 0049 fingerprint.",
      );
    }

    const journalAfterRepair = await inspectApprovedJournal(client, {
      lock: true,
    });
    if (!journalAfterRepair.exists) {
      throw new Error(
        "The approved migration journal disappeared during production repair.",
      );
    }
    assertJournalPrefix(journalAfterRepair.entries, migrations);
    assertJournalUnchanged(
      journal.entries,
      journal.sequenceState,
      journalAfterRepair.entries,
      journalAfterRepair.sequenceState,
    );

    await client.query("COMMIT");
    transactionOpen = false;
    process.stdout.write(
      `[schema-repair] before=sha256:${observedFingerprint.digest}\n`,
    );
    process.stdout.write(
      `[schema-repair] after=sha256:${repairedFingerprint.digest}\n`,
    );
    process.stdout.write(
      "[schema-repair] migration journal unchanged at 0049; 0050 remains pending\n",
    );
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactConnectionDetails(message, connectionString));
  } finally {
    if (connected && sessionLockHeld) {
      await client
        .query("SELECT pg_catalog.pg_advisory_unlock($1)", [
          DATABASE_SCHEMA_WRITER_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
    if (connected) await client.end().catch(() => undefined);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  repairProductionShowDbTree().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[schema-repair] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  });
}
