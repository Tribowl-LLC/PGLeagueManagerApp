-- Enforce: every non-system_admin user must belong to an organization.
-- Bootstrap system_admin users legitimately have no org and remain exempt.
-- Stale org-less non-admin users must be cleaned via the orphaned-data tooling
-- (`/admin/data-integrity`) before this migration is applied.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_org_required"
  CHECK (role = 'system_admin' OR organization_id IS NOT NULL);
