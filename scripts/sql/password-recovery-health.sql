-- Read-only recovery health snapshot. No recipient, token, hash, session,
-- provider payload, or credential-generation value leaves the database.
SELECT status, count(*) AS jobs,
       max(extract(epoch FROM (now() - created_at)))::bigint AS oldest_age_seconds
FROM account_action_delivery_jobs
WHERE created_at >= now() - interval '24 hours'
GROUP BY status ORDER BY status;

SELECT count(*) FILTER (WHERE status IN ('pending', 'retry_scheduled')
                              AND next_attempt_at < now() - interval '2 minutes') AS overdue_jobs,
       count(*) FILTER (WHERE status = 'processing'
                              AND lease_expires_at < now() - interval '2 minutes') AS abandoned_leases,
       count(*) FILTER (WHERE status = 'failed') AS terminal_failures
FROM account_action_delivery_jobs
WHERE created_at >= now() - interval '24 hours';

SELECT event_type, count(*) AS events,
       count(DISTINCT account_delivery_job_id) AS jobs
FROM account_email_delivery_events
WHERE received_at >= now() - interval '24 hours'
GROUP BY event_type ORDER BY event_type;

SELECT count(*) AS reset_actions,
       count(*) FILTER (WHERE status = 'consumed') AS completed,
       count(*) FILTER (WHERE status = 'expired'
          OR (status = 'pending' AND expires_at <= now())) AS expired,
       count(*) FILTER (WHERE status = 'revoked') AS revoked,
       count(*) FILTER (WHERE status = 'superseded') AS invalidated_after_completion
FROM account_action_requests
WHERE action = 'password_reset' AND created_at >= now() - interval '24 hours';
