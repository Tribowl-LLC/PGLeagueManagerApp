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

export const LEAGUE_SECRETARY_ORG_MATCH_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION league_secretary_org_match_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  league_org_id integer;
  user_org_id integer;
BEGIN
  SELECT organization_id INTO league_org_id FROM leagues WHERE id = NEW.league_id;
  IF league_org_id IS NULL THEN
    RAISE EXCEPTION 'league_secretary_org_match: league % has no organization_id (org-less rows are not eligible for secretary grants)', NEW.league_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.organization_id <> league_org_id THEN
    RAISE EXCEPTION 'league_secretary_org_match: league_secretaries.organization_id (%) must match league %.organization_id (%)', NEW.organization_id, NEW.league_id, league_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Defence in depth: the granted user must belong to the same
  -- organization as the league. The route layer also enforces this
  -- (USER_NOT_IN_ORG), but a buggy bypass or direct SQL operation
  -- could otherwise grant a cross-tenant user per-league powers.
  SELECT organization_id INTO user_org_id FROM users WHERE id = NEW.user_id;
  IF user_org_id IS NULL THEN
    RAISE EXCEPTION 'league_secretary_org_match: user % has no organization_id (org-less users are not eligible for secretary grants)', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF user_org_id <> league_org_id THEN
    RAISE EXCEPTION 'league_secretary_org_match: user %.organization_id (%) must match league %.organization_id (%)', NEW.user_id, user_org_id, NEW.league_id, league_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
`.trim();

export const USERS_ORG_CHANGE_REVOKE_SECRETARIES_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION users_org_change_revoke_secretaries_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
    DELETE FROM league_secretaries WHERE user_id = NEW.id;
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

export const LEAGUE_SECRETARY_ORG_MATCH_TRIGGER_SQL = `
CREATE TRIGGER league_secretaries_org_match
BEFORE INSERT OR UPDATE ON league_secretaries
FOR EACH ROW
EXECUTE FUNCTION league_secretary_org_match_fn();
`.trim();

export const USERS_ORG_CHANGE_REVOKE_SECRETARIES_TRIGGER_SQL = `
CREATE TRIGGER users_org_change_revoke_secretaries
AFTER UPDATE OF organization_id ON users
FOR EACH ROW
EXECUTE FUNCTION users_org_change_revoke_secretaries_fn();
`.trim();

export const LEAGUE_SECRETARY_ORG_MATCH_STARTUP_SQL = `
DO $$
BEGIN
  IF to_regclass('public.league_secretaries') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS league_secretaries_org_match ON league_secretaries;
    EXECUTE $trigger$${LEAGUE_SECRETARY_ORG_MATCH_TRIGGER_SQL}$trigger$;
  END IF;
END $$;
`.trim();

export const USERS_ORG_CHANGE_REVOKE_SECRETARIES_STARTUP_SQL = `
DO $$
BEGIN
  IF to_regclass('public.league_secretaries') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS users_org_change_revoke_secretaries ON users;
    EXECUTE $trigger$${USERS_ORG_CHANGE_REVOKE_SECRETARIES_TRIGGER_SQL}$trigger$;
  END IF;
END $$;
`.trim();

export const APPROVED_INVARIANT_FUNCTION_SQL = [
  USERS_ROLE_ORG_REQUIRED_FUNCTION_SQL,
  LEAGUE_SECRETARY_ORG_MATCH_FUNCTION_SQL,
  USERS_ORG_CHANGE_REVOKE_SECRETARIES_FUNCTION_SQL,
] as const;

export const APPROVED_INVARIANT_TRIGGER_SQL = [
  USERS_ROLE_ORG_REQUIRED_TRIGGER_SQL,
  LEAGUE_SECRETARY_ORG_MATCH_TRIGGER_SQL,
  USERS_ORG_CHANGE_REVOKE_SECRETARIES_TRIGGER_SQL,
] as const;

export const APPROVED_INVARIANT_FUNCTION_NAMES = [
  'league_secretary_org_match_fn',
  'users_org_change_revoke_secretaries_fn',
  'users_role_org_required_fn',
] as const;

export const APPROVED_INVARIANT_TRIGGER_NAMES = [
  'league_secretaries_org_match',
  'users_org_change_revoke_secretaries',
  'users_role_org_required',
] as const;
