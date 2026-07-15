# Active migrations

This directory is the only authoritative Drizzle migration history. The first
entry, `0000_normalized_baseline.sql`, initializes an empty database to the
approved LeagueVault application schema and installs the three approved
database invariant functions and triggers.

Generate future entries with `npm run db:generate -- --name <description>`,
review the SQL, metadata, and refreshed `migration-checksums.json`, and run
`npm run db:check` before committing. The checksum manifest makes edits to
reviewed SQL or journal timestamps explicit and fail closed.
Never edit an entry after it has been applied to a shared environment.

Do not run the baseline on an existing populated database. Existing matching
databases require the explicit, fingerprint-gated `db:adopt-baseline` workflow.
Historical SQL is retained under `migrations-legacy-do-not-replay/` and must
not be copied back into this journal.
