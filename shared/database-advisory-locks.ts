/**
 * Serializes every application-owned production schema writer.
 *
 * PostgreSQL has no schema-wide DDL lock, so migrations, baseline adoption,
 * and boot-time invariant installation must all participate in this advisory
 * lock contract before creating or altering application-owned catalog objects.
 */
export const DATABASE_SCHEMA_WRITER_LOCK_KEY = 843_103_001;
