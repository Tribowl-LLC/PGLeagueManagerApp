export const USERS_ROLE_ORG_REQUIRED_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION users_role_org_required_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role <> 'system_admin' AND NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'users_role_org_required: non-admin users must have organization_id'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
`.trim();

export const USERS_ROLE_ORG_REQUIRED_TRIGGER_SQL = `
CREATE TRIGGER users_role_org_required
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION users_role_org_required_fn();
`.trim();

export const APPROVED_INVARIANT_FUNCTION_SQL = [
  USERS_ROLE_ORG_REQUIRED_FUNCTION_SQL,
] as const;

export const APPROVED_INVARIANT_TRIGGER_SQL = [
  USERS_ROLE_ORG_REQUIRED_TRIGGER_SQL,
] as const;

export const APPROVED_INVARIANT_FUNCTION_NAMES = [
  'users_role_org_required_fn',
] as const;

export const APPROVED_INVARIANT_TRIGGER_NAMES = [
  'users_role_org_required',
] as const;
