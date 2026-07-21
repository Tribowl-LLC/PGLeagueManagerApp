# Active migrations

This directory is the only authoritative Drizzle migration history. The first
entry, `0000_normalized_baseline.sql`, initializes an empty database to the
approved LeagueVault application schema and installs the three approved
database invariant functions and triggers.

Generate future entries with
`npm run db:generate -- --name <lowercase_description>` using only letters,
digits, and underscores,
review the SQL, metadata, and refreshed `migration-checksums.json`, and run
`npm run db:check` before committing. The checksum manifest makes edits to
reviewed SQL or journal timestamps explicit and fail closed. The wrapper accepts
only that validated name, pins the reviewed config, strips database/config
overrides, and cannot write into `migrations-legacy-do-not-replay/`.
Never edit an entry after it has been applied to a shared environment.

Migration identity is the SHA-256 of the exact committed SQL bytes. Active SQL
must be valid UTF-8 with LF line endings; `.gitattributes` preserves those bytes
across Windows and Linux checkouts, and `npm run db:migration-bytes:check`
verifies the attributes, bytes, journal metadata, and checksum manifest. CI
runs the same checker in a clean `core.autocrlf=true` clone without relying on
ignored or local artifacts.

Do not run the baseline on an existing populated database. Existing matching
databases require the explicit, fingerprint-gated `db:adopt-baseline` workflow,
which accepts strictly verified tool-owned local Docker, disposable Neon
rehearsal, and separately gated production modes. Production must first pass
the dedicated read-only `db:adopt-baseline:preflight` command; only a separate
human authorization may supply the execution confirmation and ephemeral token.
Historical SQL is
retained under `migrations-legacy-do-not-replay/` and must not be copied back
into this journal or exposed to the active migrator.
