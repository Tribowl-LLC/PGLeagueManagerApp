# Database

PostgreSQL is the production database, hosted by Neon. The production
application runs on Render, and its database connection is supplied through
`DATABASE_URL`. This document defines the normalized forward-only migration,
fingerprint, and guarded-adoption workflow.

## Schema source

The Drizzle schema entrypoint is [`shared/schema.ts`](../shared/schema.ts).
It is a re-export shim for [`shared/schema/index.ts`](../shared/schema/index.ts),
which re-exports the table definitions, relations, enums, and validation
schemas from the individual files under [`shared/schema/`](../shared/schema/).

[`drizzle.config.ts`](../drizzle.config.ts) defines:

- PostgreSQL as the dialect;
- `./shared/schema.ts` as the schema input;
- `./migrations` as Drizzle's output directory; and
- `DATABASE_URL` as an optional connection source for commands that actually
  connect. Generation does not require it.

The runtime Drizzle client is created in [`server/db.ts`](../server/db.ts).
Database invariants that are not represented solely by table declarations are
installed idempotently at application startup by
[`server/db-invariants.ts`](../server/db-invariants.ts). This currently
includes the non-system-admin user organization trigger, league-secretary
organization-matching and grant-revocation triggers, and the rate-limit bucket
table/index. This startup installation remains temporarily idempotent during
baseline rollout; the checked-in baseline owns the same definitions, and
`db:check` verifies them exactly. A follow-up converts startup installation to
verification-only behavior after every environment is verified.

The routines under [`server/migrations/`](../server/migrations/) are narrow
startup or data-backfill routines. They are not a replacement for the schema
release process.

## Active and legacy migration histories

[`migrations/`](../migrations/) is the only active history. It begins with
`0000_normalized_baseline.sql`, which initializes an empty database to the
approved 29-table, 307-column application schema and installs the three
approved invariant functions and triggers. Its journal uses the installed
Drizzle format at `drizzle.__drizzle_migrations`.

[`migrations-legacy-do-not-replay/`](../migrations-legacy-do-not-replay/) keeps
the old mixed SQL and metadata as evidence only. Its journal selected eight
files, replayed 17 tables, and did not reconstruct the 29-table intended
schema. No package command or Drizzle configuration points at it. Never replay,
generate into, or adopt from that directory.

## Migration commands

```bash
# Generate reviewed SQL and metadata; does not connect to PostgreSQL.
npm run db:generate -- --name <description>

# Apply checked-in migrations in deterministic journal order.
npm run db:migrate

# Produce or verify the exact versioned application fingerprint.
npm run db:fingerprint -- --verify

# Replay/adopt/check disposable PostgreSQL 16 and 17 databases.
npm run db:check
```

`db:migrate` validates the journal relation, exact column/primary-key format,
every stored hash/timestamp against the checked-in prefix, the checked-in
`migration-checksums.json`, and all active metadata before applying SQL.
`db:generate` refreshes that checksum manifest without exposing or using
`DATABASE_URL`, so a later SQL or timestamp edit is visible and `db:check`
fails until the reviewed manifest is deliberately refreshed. A database advisory lock serializes migration
executors. Reruns are no-ops. If the journal is absent or empty while
application-owned public objects already exist, the command refuses to run the
baseline and directs the operator to guarded adoption; it never treats an
empty journal as proof of schema state.

Use one migration executor per environment and deploy with
expand–migrate–contract sequencing: add backward-compatible structures first,
deploy code that tolerates both states, migrate/backfill data through a
separately reviewed operation, then remove old structures in a later release.
Do not combine destructive contract steps with the expansion that makes them
safe.

Direct schema reconciliation is retained only as `npm run
db:push:disposable`. The wrapper refuses production-shaped environments and
requires a loopback or explicitly allow-listed development host. It is for
throwaway development/test targets and adoption test setup, not durable Neon
branches, deployment, or migration generation.

## Read-only schema inventory

The repository provides a read-only inventory command:

```bash
npm run db:inventory -- --output .artifacts/db-inventory/example.json
```

The command reads `DATABASE_URL` from the environment, opens a PostgreSQL
`REPEATABLE READ, READ ONLY` transaction, and fails before writing an output
file unless PostgreSQL confirms both transaction settings. It uses PostgreSQL
catalog queries plus a narrowly scoped read of the approved Drizzle
migration-journal relation. It does not run application startup, `db:push`,
migrations, invariant installation, or data backfills.

Inventory format version 2 also records PostgreSQL row-security metadata. For
each table it captures `relrowsecurity`, `relforcerowsecurity`, owner,
connected-role ownership, effective connected-role table privileges, and the
reason that role is governed by or bypasses RLS. It separately records the
normalized ACL, every `pg_policy` name, command, permissive/restrictive mode,
target roles, `USING`, `WITH CHECK`, catalog-visible function/relation
dependencies, and whether the policy applies to the connected role. Reference
signals flag the documented Neon Data API/Auth objects (`auth`, `neon_auth`,
`authenticated`, `anonymous`, and JWT-related expressions) for owner review;
they do not automatically declare application ownership.

PostgreSQL 17 and newer add the `MAINTAIN` table privilege. Inventory format
version 2 records it from ACLs on every supported server and includes it in
the connected role's effective privileges on PostgreSQL 17 and newer. The
effective-privilege query omits that token on PostgreSQL 16 and older, where
asking `has_table_privilege` about `MAINTAIN` is itself an error.

The installed Drizzle PostgreSQL migrator defaults to
`drizzle.__drizzle_migrations`, so that is the approved default. Catalog
discovery reports every non-system relation named `__drizzle_migrations`, but
the command inspects columns and reads rows only from the approved relation. It
refuses ambiguous discovery when multiple matching relations exist. An
independently verified alternate can be selected explicitly with validated,
unquoted identifiers:

```bash
npm run db:inventory -- --journal-relation audit.__drizzle_migrations \
  --output .artifacts/db-inventory/example.json
```

The normalized JSON captures:

- a SHA-256 fingerprint of the connection host and port, without the hostname,
  URL, password, or connection-string credentials;
- current database, role, PostgreSQL version, and confirmed transaction mode;
- connected-role `rolsuper` and `rolbypassrls` state;
- schemas, tables, columns, data types, nullability, defaults, identity and
  generated-column behavior;
- table owners, effective and granted table privileges, RLS enforcement mode,
  normalized policy definitions, and policy dependency/reference signals;
- primary, foreign-key, unique, check, and exclusion constraints;
- indexes and PostgreSQL's normalized index definitions;
- enum, domain, range, multirange, composite, and user-schema base types;
- non-extension-owned functions in application schemas;
- non-internal triggers and their function relationships;
- installed extensions; and
- migration-journal discovery metadata, separate column-inspection and
  row-collection status, and the approved journal's `id`, `hash`, and
  `created_at` entries when that relation exists.

Inventory files contain structural and environment metadata. Treat them as
review artifacts rather than source files. The default generated path,
`.artifacts/db-inventory/`, is ignored by Git.

Compare two inventories with:

```bash
npm run db:inventory:compare -- left.json right.json
npm run db:inventory:compare -- left.json right.json --json --output comparison.json
npm run db:inventory:compare -- left.json right.json --report-only
```

The comparison ignores top-level object ordering and JSON property ordering.
It uses quote-aware whitespace normalization that preserves quoted strings,
quoted identifiers, regular expressions, comments, and dollar-quoted function
bodies. Lexically incomplete or uncertain definitions are retained
byte-for-byte rather than being rewritten.
It reports missing-from-right, extra-in-right, and changed objects separately
for environment metadata, schemas, tables, table privileges, policies,
columns, constraints, indexes, types, functions, triggers, extensions, and
migration journal state. A normal comparison exits nonzero when differences
exist or input is invalid or incomplete. `--report-only` preserves the report
but exits zero for an expected transitional mismatch.

Run the known local comparison with Docker Desktop available:

```bash
npm run db:inventory:validate-local
```

This command first reads and preflights all eight journal-listed files. The
fail-closed allowlist accepts only the statement shapes present in that chain:
enum type creation, table creation, ordinary or unique index creation, adding
columns, adding foreign-key constraints, and setting a column `NOT NULL`.
Unsupported, data-changing, destructive, privilege, ownership, role, schema,
or database operations are rejected before Docker starts, before the replay
database exists, and before a replay connection opens.

After preflight, the command creates a uniquely named PostgreSQL 16 container
with an invocation ownership label and captures its exact container ID. It
creates one database from current declarations with the guarded disposable
push wrapper and another by transactionally replaying the journal under
`migrations-legacy-do-not-replay/`. It never writes
`__drizzle_migrations`. Every run writes to its own ignored
`.artifacts/db-inventory/<run-id>/` directory. Container actions and cleanup
use the captured ID after ownership-label verification; cleanup failure is a
validation failure. The known 29-versus-17 difference remains the expected
result, not a green schema-equivalence assertion.

Neither local inventory includes the startup functions and triggers from
`server/db-invariants.ts`, because the local comparison deliberately measures
the two schema-deployment mechanisms before application startup. An inventory
of a database where the application has booted will capture those functions
and triggers and report them as structural differences.

Fresh current-schema and current-schema-plus-invariants databases both leave
RLS disabled and define no policies. Do not enable RLS locally merely to make a
provider clone compare cleanly.

The approved enhanced inventory of the independently verified disposable
production clone established the ownership decision for the current state:
all 29 public application tables have RLS enabled, none use `FORCE ROW LEVEL
SECURITY`, and none define a policy. The connected application role is a
non-superuser with `BYPASSRLS`, owns all 29 tables, and is the only ACL grantee
on them. No policy, provider role grant, or policy dependency references Neon
Auth, the Data API, JWT claims, or another provider object. Consequently the
enabled flags are inert for the current application role and are classified
`EXCLUDE_FROM_APPLICATION_BASELINE` on all 29 tables. Local RLS-disabled state
is the intentional application baseline definition; do not copy the clone's
bare enabled flags into source. Preserve the separately inventoried provider
schemas and extensions as provider-managed objects outside the application
baseline. Any future non-bypass runtime or Data API role requires a new,
explicit RLS design before it receives table privileges.

## Organizations subdomain index decision

The active baseline definition is the production-shaped partial index:

```sql
CREATE UNIQUE INDEX organization_subdomain_idx
  ON organizations (subdomain)
  WHERE subdomain IS NOT NULL;
```

PostgreSQL unique indexes treat nulls as distinct unless `NULLS NOT DISTINCT`
is specified, so both the partial definition and the current full source index
allow multiple null subdomains and reject duplicate non-null subdomains. The
application lookup is equality on `organizations.subdomain`; there is no
application `IS NULL` lookup. A PostgreSQL 16 generic prepared-plan probe
confirmed that equality lookup can use the partial index. The partial form
stores and maintains only assigned subdomains, while the full form additionally
stores null entries and could serve a future `IS NULL` lookup or full index
ordering. Those unused capabilities do not justify production index churn or
a larger baseline index. Both `shared/schema` and the normalized baseline
express the approved predicate.

## Disposable Neon branch inventory procedure

This procedure is for a disposable Neon branch cloned from production. It is
not approval to inventory production itself.

1. A Neon operator creates and independently verifies a disposable branch
   cloned from the intended production branch. Record the Neon project,
   branch, endpoint host, database, and role in the approved operator record,
   separate from the JSON inventory.
2. Use a pre-provisioned read-only or least-privilege login where practical.
   It must be able to read PostgreSQL catalogs and the Drizzle journal table,
   but it does not need table-data access beyond that journal. Provisioning or
   changing the role is a separate operator action and is not performed by the
   inventory command.
3. Put the branch connection URL into `DATABASE_URL` through the operator's
   secret manager or current shell without echoing it, writing it to a file,
   or adding it to command arguments. Do not copy production credentials to
   the disposable branch.
4. Independently set all five expected-target values in the same secret-aware
   operator environment. Do not put the values in shell history or source:

   - `DB_INVENTORY_EXPECTED_DATABASE`
   - `DB_INVENTORY_EXPECTED_ROLE`
   - `DB_INVENTORY_EXPECTED_HOST_FINGERPRINT`
   - `DB_INVENTORY_EXPECTED_NEON_BRANCH_ID`
   - `DB_INVENTORY_EXPECTED_NEON_SOURCE_BRANCH_ID`

   The last two identifiers must differ. Before opening a connection, the
   command requires the URL to explicitly name its database and role and
   compares both plus the endpoint fingerprint to the independent
   expectations. It then verifies the server-reported database and role inside
   the confirmed read-only transaction before running catalog inventory
   queries. Connection-target query overrides (including host, port, database,
   role, service selectors, and PostgreSQL startup options) and percent-encoded
   hostnames are rejected before a client is constructed. If ambient `PGPORT`
   is set, the URL must name its port explicitly, and `PGOPTIONS` must be unset;
   ordinary TLS query parameters remain supported. Mismatch errors do not echo
   actual or expected values. The operator record remains responsible for
   proving that the independently fingerprinted endpoint belongs to the
   recorded disposable branch; the command does not call the Neon control
   plane.
5. Run only:

   ```bash
   npm run db:inventory -- --require-expected-target \
     --output .artifacts/db-inventory/neon/<review-id>.json
   ```

   Do not start the application, run a schema push, invoke a migration runner,
   install invariants, seed data, or run a backfill against the branch as part
   of inventory collection.
6. Review the normalized file for unexpected metadata, store it in the
   approved review-artifact system, and do not commit it. Unset
   `DATABASE_URL` when the session is complete.
7. Compare it to a reviewed local inventory with `--report-only` while the
   current mismatch is expected. Retain both the JSON comparison and the
   separate Neon target record for review.

Any future production inventory requires a separately approved operator plan,
an independently verified read-only role, explicit production target
verification, and an approved destination for the resulting artifact.

## Exact baseline fingerprint

The installed versions are `drizzle-orm@0.45.2` and
`drizzle-kit@0.31.10`. The PostgreSQL migrator defaults to schema `drizzle`
and table `__drizzle_migrations`; it creates `id SERIAL PRIMARY KEY`,
`hash text NOT NULL`, and nullable `created_at bigint`. It hashes the exact SQL
file bytes with SHA-256, uses the journal entry's `when` value as
`created_at`, reads only the row with the greatest `created_at`, and runs every
migration whose journal timestamp is greater. An existing empty table means
there is no last migration, so it causes every checked-in migration to run; it
is not evidence that a baseline is satisfied. The runner does not reconcile
stored hashes against the checked-in files.

`migrations/baseline-fingerprint.json` is fingerprint format version 1. It
contains a SHA-256 digest plus the exact normalized structural inventory for
the 29 application tables, 307 declared columns, constraints, physical
indexes, `public.user_role`, three functions, three triggers, and zero
policies. It records RLS disabled on every application table. Provider-managed
schemas, roles, extensions, privileges, ownership, connection metadata, and
physical column ordinals are deliberately excluded. Column names and all other
declared properties remain exact, so historical physical order can differ
without weakening adoption checks.

The approved identity is:

- tag: `0000_normalized_baseline`
- exact SQL SHA-256:
  `9f4398b0e90bb5a5e33406cc5f35faf73b9c9dcbff3c781bacc892479c31a302`
- journal `created_at`: `1784104330176`
- structural fingerprint SHA-256:
  `f66a78e566b5338a7e356d3ce7a7b8cd2fe1c68a51a351556bb83b60ac42fa36`

`npm run db:fingerprint -- --verify` collects catalog state inside a confirmed
`REPEATABLE READ, READ ONLY` transaction, reads no application rows, fails on
an incomplete inventory, and compares every encoded object rather than only
the digest.

## Guarded existing-database adoption

Adoption never executes baseline DDL. It is an explicit operator action that
first verifies the exact fingerprint and journal in read-only transactions,
then inserts only the reviewed baseline row in a separate serialized
transaction. A shared advisory lock serializes that inspection/write sequence
against `db:migrate`. It refuses an alternate or ambiguous journal, extra columns,
wrong types/defaults/constraints, any unexpected row, any hash/timestamp
mismatch, target mismatch, structural drift, RLS/policies, retired CardPointe
objects, or missing invariant definitions. An exact rerun fingerprints again
and returns a no-op.

Supply every value independently through the secret-aware operator
environment; never put target values or credentials in source or shell
arguments:

- `DATABASE_URL`
- `DB_ADOPTION_EXPECTED_DATABASE`
- `DB_ADOPTION_EXPECTED_ROLE`
- `DB_ADOPTION_EXPECTED_HOST_FINGERPRINT`
- `DB_ADOPTION_ENVIRONMENT_CLASS` (`local-disposable`, `ci`, or
  `neon-rehearsal`)
- `DB_ADOPTION_ENVIRONMENT_ID` (the trusted runtime/provider identity)
- `DB_ADOPTION_EXPECTED_ENVIRONMENT_ID`
- `DB_ADOPTION_BACKUP_ATTESTATION=BACKUP_AND_RESTORE_VERIFIED`
- `DB_ADOPTION_CONFIRM=ADOPT_LEAGUEVAULT_BASELINE_WITHOUT_DDL`
- `DB_ADOPTION_EXPECTED_COMMIT` (the exact 40-character clean checkout)
- `DB_ADOPTION_EXPECTED_BASELINE_TAG`
- `DB_ADOPTION_EXPECTED_BASELINE_HASH`
- `DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT`

For `neon-rehearsal`, also supply
`DB_ADOPTION_SOURCE_ENVIRONMENT_ID`. It must identify the independently
recorded source branch and must differ from the target environment identity.
The source-identity key is refused for local/CI adoption.

The runtime environment identity must exactly match the independently supplied
expectation. The command does not call the Neon control plane, so the runtime
identity must come from a trusted provider/operator context and the operator
record must independently prove that the endpoint fingerprint belongs to that
disposable branch. After a current
backup/restorable branch and restore procedure are verified, run:

```bash
npm run db:adopt-baseline
npm run db:migrate
```

For a disposable Neon rehearsal, retain before/after fingerprints, the target
record, command output, backup/restore evidence, and the exact CI-verified
commit. Confirm that adoption changed only the Drizzle journal and that the
following migration path is a no-op until a real later migration exists.

Production adoption remains unperformed and disabled by this change.
`db:adopt-baseline` refuses `APP_ENV=prod`, `NODE_ENV=production`, the
production application domain, Render/Replit deployment markers,
production-shaped or mismatched environment identities, and every environment
class outside the disposable/rehearsal allowlist. Enabling production requires
a separately reviewed operator-only change and rehearsal evidence.

## Production migration process

Follow the schema-release procedure in
[`production-runbook.md`](./production-runbook.md):

1. Start from the exact CI-verified commit that will be deployed. Confirm the
   intended Neon project, branch, host, database, and user independently.
2. Create a current Neon backup or branch suitable for restoration before
   changing the schema.
3. Set `DATABASE_URL` only in the operator or deployment environment that has
   been verified to point at that target. Never put the production value in
   source files, prompts, logs, or test fixtures.
4. Confirm the database already has the exact active journal prefix. Existing
   production is not yet adopted, so stop here until the separately approved
   production-adoption change is complete.
5. Run `npm run db:migrate` with one migration executor. Abort for an
   unexpected journal or migration failure and record the result.
6. Deploy the matching CI-verified application commit after the schema change
   is applied successfully.
7. Verify `/api/health`, authentication, the affected workflow, and any
   relevant payment-provider or webhook behavior. Confirm that Render is
   running the expected commit.

For an application-only rollback, redeploy the previous known-good commit. For
a schema regression, stop further deploys and use the prepared Neon restore
plan. Do not guess at a reverse migration.

## Backup expectations

- A current Neon backup or restorable branch is required before every
  production schema release, especially before any change that may remove or
  rewrite data.
- The backup must be associated with the verified production project, branch,
  host, and database. A local or test backup is not a production recovery
  plan.
- `npm run db:migrate` does not create a backup. This repository has no package
  script that replaces Neon backup/restore operations.
- Keep the restore plan and the reviewed schema-change output available until
  post-deployment checks pass.
- Organization deletion is an application-level destructive operation, not a
  substitute for a database backup. It is implemented as an atomic,
  system-admin-only teardown in
  [`server/storage/organizations.ts`](../server/storage/organizations.ts).

## Prohibited destructive operations

The following are not permitted as ad-hoc database work:

- pointing local, test, or exploratory commands at the production Neon
  database;
- using `npm run db:push:disposable` against production or any durable shared
  database;
- accepting an unexpected destructive statement from Drizzle without an
  explicit reviewed release plan and a restorable backup;
- manually dropping or renaming production tables, columns, constraints, or
  indexes;
- manually editing an already-applied migration or rewriting migration
  history to disguise a later schema change;
- running destructive SQL, including database or table drops, outside the
  reviewed production procedure; or
- adding startup behavior that silently performs destructive schema changes.

The current tree includes intentionally destructive historical SQL, including
[`migrations-legacy-do-not-replay/0041_remove_youth_guardian_support.sql`](../migrations-legacy-do-not-replay/0041_remove_youth_guardian_support.sql).
Its presence does not make it safe to run blindly; review its statements and
the live database state before any such release.

## Tenant ownership relationships

`organizations` is the tenant root. Organization ownership is represented both
by direct `organization_id` columns and by parent relationships. Foreign keys
ensure that referenced rows exist, but they do not enforce same-organization
relationships for every multi-tenant join. Server-side authorization and the
runtime invariants remain part of the tenant boundary.

| Data | Current ownership relationship |
| --- | --- |
| `locations` | Directly owned by `organizations` through required `organization_id`. Payment-provider credentials are stored on the location row. |
| `leagues` | Direct `organization_id` and optional `location_id`. `organization_id` remains nullable for legacy/orphan cleanup; newly created application rows require an organization, and normal access-control paths reject org-less leagues. |
| `teams`, `games`, `league_registration_questions` | Owned through `league_id`, and therefore through the league's organization. Games own `scores` through `game_id`; scores also reference a bowler and team. |
| `bowlers` | Directly owned by `organizations` through required `organization_id`. `bowler_leagues` connects a bowler to a league and team and must remain within the same tenant. |
| `payments`, `payment_schedules` | Reference both `bowler_id` and `league_id`; tenant access is derived from and checked against those owning rows. |
| `league_registrations` | Direct required `organization_id`, plus `league_id`, `bowler_id`, and optional `payment_id`. The direct organization stamp is checked against the related workflow by the application. |
| `league_secretaries`, `league_secretary_audits` | Direct organization stamps plus user/league references. The boot-time database trigger requires a secretary grant's organization to match both the league and the granted user's organization; changing a user's organization revokes stale grants. |
| `users` | `organization_id` is nullable only for platform `system_admin` accounts. The runtime trigger rejects org-less non-system-admin users. Users may also reference a bowler and location. |
| `bowler_payment_links` | Direct required `organization_id`, plus two bowlers and the creating user. The payment-link routes verify that both bowlers and the caller belong to the same organization. |
| `apple_pay_job_items` | Optional organization and location references identify the tenant work item. The parent `apple_pay_jobs` row is platform operational state and may reference its creator. |
| Tenant audit/recovery rows | Admin password/role audits, orphan-cleanup audits, and related secretary audits carry direct organization references where applicable. Some audit foreign keys are nullable or `set null` so history can survive cleanup. Email/profile audit rows are scoped through their user references. |

The remaining operational tables are not tenant roots: `session`, email
templates, deletion requests, rate-limit buckets, and alerter state are
platform-wide. Alerter payloads can contain organization or league identifiers,
but the `alerter_state` table itself has no organization foreign key.

Normal tenant access is server-authorized from the authenticated user and
organization context; a client-supplied organization, league, location, team,
bowler, payment, or other identifier is not an ownership proof. Org-less
resource rows are treated as orphaned data and are available only through the
explicit system-admin data-integrity tooling.

Permanent organization deletion is system-admin-only and runs as one database
transaction. It removes application-owned tenant data and related audit rows,
preserves platform system-admin accounts by detaching them, and does not
delete remote Square or Clover customer objects.
