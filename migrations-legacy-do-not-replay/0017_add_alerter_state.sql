CREATE TABLE IF NOT EXISTS "alerter_state" (
  "kind" text PRIMARY KEY NOT NULL,
  "last_sent_at" timestamp NOT NULL,
  "suppressed_count" integer DEFAULT 0 NOT NULL
);
