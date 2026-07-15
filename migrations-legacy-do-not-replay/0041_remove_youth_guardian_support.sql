-- Adult leagues only. Review the production backup before applying.
-- This intentionally removes retired youth/guardian data structures.
DROP TABLE IF EXISTS "bowler_guardians";
ALTER TABLE "league_registrations"
  DROP COLUMN IF EXISTS "guardian_user_id";
ALTER TABLE "bowlers"
  DROP COLUMN IF EXISTS "is_minor";
ALTER TABLE "leagues"
  DROP COLUMN IF EXISTS "is_youth";
