-- Refuse installation until operators resolve every existing hostname
-- collision. The application resolver lowercases incoming hostnames, so the
-- audit uses the same normalized namespace and also refuses mixed-case rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM organizations
    WHERE slug <> lower(slug)
       OR (subdomain IS NOT NULL AND subdomain <> lower(subdomain))
  ) THEN
    RAISE EXCEPTION 'organization hostname namespace contains non-lowercase identifiers; run npm run db:audit:organization-hostnames'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    WITH identifiers AS (
      SELECT id AS organization_id, lower(slug) AS hostname FROM organizations
      UNION ALL
      SELECT id AS organization_id, lower(subdomain) AS hostname
      FROM organizations
      WHERE subdomain IS NOT NULL
    )
    SELECT 1
    FROM identifiers
    GROUP BY hostname
    HAVING count(DISTINCT organization_id) > 1
  ) THEN
    RAISE EXCEPTION 'organization hostname namespace collision detected; run npm run db:audit:organization-hostnames and remediate before retrying'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'organization_hostname_namespace_guard';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION organization_hostname_namespace_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize every hostname mutation. The lock is held until transaction
  -- completion, closing the check-then-insert race in both collision
  -- directions even when the write originates outside the application.
  PERFORM pg_advisory_xact_lock(843103002);

  IF NEW.slug <> lower(NEW.slug)
     OR (NEW.subdomain IS NOT NULL AND NEW.subdomain <> lower(NEW.subdomain)) THEN
    RAISE EXCEPTION 'organization hostname identifiers must be lowercase'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'organization_hostname_namespace_lowercase';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM organizations AS existing
    WHERE existing.id <> NEW.id
      AND (
        lower(existing.slug) = lower(NEW.slug)
        OR (
          NEW.subdomain IS NOT NULL
          AND lower(existing.slug) = lower(NEW.subdomain)
        )
        OR (
          existing.subdomain IS NOT NULL
          AND lower(existing.subdomain) = lower(NEW.slug)
        )
        OR (
          existing.subdomain IS NOT NULL
          AND NEW.subdomain IS NOT NULL
          AND lower(existing.subdomain) = lower(NEW.subdomain)
        )
      )
  ) THEN
    RAISE EXCEPTION 'organization hostname namespace conflict'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'organization_hostname_namespace_guard';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_hostname_namespace_guard
BEFORE INSERT OR UPDATE OF slug, subdomain ON organizations
FOR EACH ROW
EXECUTE FUNCTION organization_hostname_namespace_guard_fn();
