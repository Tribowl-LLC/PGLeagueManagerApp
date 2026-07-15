ALTER TABLE locations ADD COLUMN IF NOT EXISTS cardpointe_credentials jsonb;
ALTER TABLE bowlers ADD COLUMN IF NOT EXISTS cardpointe_profile_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cardpointe_retref text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cardpointe_authcode text;
