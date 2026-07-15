-- Task #410: localize user-facing security emails.
--
-- Adds a nullable `preferred_language` column to `users` so the
-- "your password was just changed" notification (and future
-- notifications) can be rendered in the recipient's chosen language.
-- The column is intentionally nullable: existing rows get NULL,
-- which the email helpers treat as "fall back to English" via
-- `pickPasswordChangedLocale`.
--
-- Values are ISO 639-1 two-letter codes (`en`, `es`, ...). No CHECK
-- constraint is added at the schema level because the resolver
-- already silently falls back to English on any unknown / corrupt
-- value — security-critical emails must always render even if the
-- preference column has been hand-edited to garbage.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_language" text;
