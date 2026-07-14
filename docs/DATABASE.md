# Database

This document describes the database workflow that exists in the repository
today. PostgreSQL is the production database, hosted by Neon. The production
application runs on Render, and its database connection is supplied through
`DATABASE_URL`.

## Schema source

The Drizzle schema entrypoint is [`shared/schema.ts`](../shared/schema.ts).
It is a re-export shim for [`shared/schema/index.ts`](../shared/schema/index.ts),
which re-exports the table definitions, relations, enums, and validation
schemas from the individual files under [`shared/schema/`](../shared/schema/).

[`drizzle.config.ts`](../drizzle.config.ts) currently defines:

- PostgreSQL as the dialect;
- `./shared/schema.ts` as the schema input;
- `./migrations` as Drizzle's output directory; and
- `DATABASE_URL` as the connection source.

The runtime Drizzle client is created in [`server/db.ts`](../server/db.ts).
Database invariants that are not represented solely by table declarations are
installed idempotently at application startup by
[`server/db-invariants.ts`](../server/db-invariants.ts). This currently
includes the non-system-admin user organization trigger, league-secretary
organization-matching and grant-revocation triggers, and the rate-limit bucket
table/index.

The routines under [`server/migrations/`](../server/migrations/) are narrow
startup or data-backfill routines. They are not a replacement for the schema
release process.

## Migration commands

The repository currently exposes one schema command:

```bash
# Apply the Drizzle schema to the database named by DATABASE_URL.
npm run db:push

# Always require confirmation before applying the proposed changes.
npm run db:push -- --strict
```

Before either command, set `DATABASE_URL` to the intended non-production
database and verify the target. Do not use `--force` during normal development
or against production. The test infrastructure may use a forced push against
an isolated disposable database; for example, `npm run test:local` provisions
the local PostgreSQL test container and applies the schema automatically.

There is no `db:generate` or `db:migrate` script in `package.json`. The
checked-in [`migrations/`](../migrations/) directory contains SQL files and
Drizzle metadata, but it is not a single automatically replayed deployment
history: the journal currently tracks the baseline plus the early numbered
entries, while additional hand-named SQL files are also present. CI and the
documented production process use `npm run db:push`; no repository deployment
command replays every SQL file in `migrations/`. Do not infer that a migration
filename alone proves that it has been applied, and do not batch-apply the
directory without an explicit review of the target database and each file.

The repository audit measured the current discrepancy as follows: the journal
tracks eight SQL files, replaying those files creates 17 tables, the final
tracked Drizzle metadata snapshot describes 20 tables, and `db:push` from the
current schema creates 29 tables. The other 43 SQL files under `migrations/`
are not selected by the journal. These counts are transitional facts, not an
alternative deployment contract.

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
- schemas, tables, columns, data types, nullability, defaults, identity and
  generated-column behavior;
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
for environment metadata, schemas, tables, columns, constraints, indexes,
types, functions, triggers, extensions, and migration journal state. A normal
comparison exits nonzero when differences exist or input is invalid or
incomplete. `--report-only` preserves the report but exits zero for an expected
transitional mismatch.

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
creates one database with current `db:push` and another by transactionally
replaying the preflighted statements. It never writes
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
4. Reconcile the command's database, role, PostgreSQL version, and host
   fingerprint with the separately recorded Neon target before accepting the
   artifact.
5. Run only:

   ```bash
   npm run db:inventory -- --output .artifacts/db-inventory/neon/<review-id>.json
   ```

   Do not start the application, run `db:push`, invoke a migration runner,
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
4. Run `npm run db:push`.
5. Read every proposed statement. Abort for an unexpected table, column,
   constraint, index, rename, drop, or other data-loss operation. Record the
   reviewed result and any operational notes.
6. Deploy the matching CI-verified application commit after the schema change
   is applied successfully.
7. Verify `/api/health`, authentication, the affected workflow, and any
   relevant payment-provider or webhook behavior. Confirm that Render is
   running the expected commit.

For an application-only rollback, redeploy the previous known-good commit. For
a schema regression, stop further deploys and use the prepared Neon restore
plan. Do not guess at a reverse `db:push`.

## Backup expectations

- A current Neon backup or restorable branch is required before every
  production schema release, especially before any change that may remove or
  rewrite data.
- The backup must be associated with the verified production project, branch,
  host, and database. A local or test backup is not a production recovery
  plan.
- `npm run db:push` does not create a backup. This repository has no package
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
- using `npm run db:push -- --force` against production or as a normal way to
  skip review;
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
[`migrations/0041_remove_youth_guardian_support.sql`](../migrations/0041_remove_youth_guardian_support.sql).
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
