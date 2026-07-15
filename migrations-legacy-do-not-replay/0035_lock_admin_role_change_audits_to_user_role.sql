-- Task #463: Lock the role audit columns to valid roles at the database level.
--
-- `admin_role_change_audits.old_role` and `.new_role` were declared as plain
-- `text NOT NULL` in 0030_add_admin_role_change_audits.sql. The application
-- validates them via Zod (`z.enum(USER_ROLES)`) and the only writer today
-- (`server/storage/admin-role-change-audits.ts`) takes the typed
-- `InsertAdminRoleChangeAudit`, but a buggy future storage helper that
-- bypassed Zod could write 'admin' or '' and the database would happily
-- accept it — silently corrupting the audit log used for compliance
-- reporting. Convert both columns to the existing `user_role` Postgres enum
-- (defined in 0000_baseline.sql, currently used by `users.role`) so the DB
-- itself rejects anything outside ('system_admin', 'org_admin', 'user').
--
-- The USING clause is a plain cast: every row currently in the table came
-- through the Zod-validated insert path, so all existing values are already
-- valid `user_role` members and the cast cannot fail. If somehow it did
-- (e.g. a value snuck in via a manual SQL session) the migration would
-- abort cleanly with a "invalid input value for enum user_role" error
-- rather than silently dropping data.
ALTER TABLE "admin_role_change_audits"
  ALTER COLUMN "old_role" TYPE "public"."user_role"
  USING "old_role"::"public"."user_role";
--> statement-breakpoint
ALTER TABLE "admin_role_change_audits"
  ALTER COLUMN "new_role" TYPE "public"."user_role"
  USING "new_role"::"public"."user_role";
