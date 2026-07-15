-- Task #349: let users opt out of the post-deletion confirmation email.
--
-- Adds a `notify_on_completion` boolean to `deletion_requests` so the
-- account-data deletion executor (server/services/account-deletion.ts)
-- can skip the SendGrid confirmation email when the requester
-- explicitly checked "do not email me when this is done" on the
-- public deletion-request form. Defaults to TRUE so historical rows
-- (and any deletion requests submitted before the form was updated)
-- continue to receive the confirmation email exactly as before.

ALTER TABLE "deletion_requests"
  ADD COLUMN IF NOT EXISTS "notify_on_completion" boolean NOT NULL DEFAULT true;
