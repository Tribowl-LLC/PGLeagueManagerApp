# SendGrid delivery alerts

LeagueVault records validated SendGrid failure events in a small operational
queue for system administrators. The queue covers the account email delivery
receiver and unrelated validated failure events, including events for the
account-ready email. Existing account delivery handling remains in place.

## Configure the signed Event Webhook

Configure the webhook in SendGrid before enabling a signed test event. The
production endpoint is:

```text
https://leaguevault.app/api/email/sendgrid/webhook
```

In SendGrid, open **Settings → Mail Settings → Event Webhooks** and:

1. Select `processed`, `delivered`, `deferred`, `bounce`, and `dropped`.
2. Enable **Signed**.
3. Save the webhook.
4. Reopen the webhook's settings using the cog or **Edit** control.
5. Copy the public verification key shown by SendGrid into the server
   environment variable `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`.

The public verification key is not a secret, but manage it through server
configuration and deploy or restart the application after setting it. Do not
put a private key or a SendGrid API key into this variable, and do not expose
either of those secrets in source code, documentation, browser environment
variables, or support tickets.

SendGrid's Event Webhook documentation describes the event fields and signed
webhook flow:

- [Event Webhook event reference](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
- [Twilio SendGrid Event Webhook overview](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/twilio-sendgrid-event-webhook-overview)
- [Enable signature verification](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features#enable-signature-verification)

The receiver deduplicates normal SendGrid events by `sg_event_id`. The general
failure-alert path requires a valid event ID, recipient, timestamp, and
failure event, then records the operational alert independently of application
correlation. This means a signed bounce or dropped test event with an unknown
application correlation still creates an alert. The existing account-action
delivery receiver remains correlation-aware and continues to ignore unknown
account-action correlations when recording account delivery lifecycle state.
A missing or invalid signature fails the webhook request so an unsigned or
tampered request cannot be treated as trusted delivery evidence.

SendGrid reports `blocked` as a bounce event type. LeagueVault keeps the
blocked failure class separate from the more specific sending-IP-blocklisted
reason when that reason is present.

## Test the integration

After saving the signed webhook and setting the server variable, send a signed
test event from SendGrid and verify that the endpoint accepts it. Configure the
signed webhook first; enabling a signed test before the public verification
key is available will fail signature verification.

SendGrid's test event may use an unknown application correlation. A valid
signed bounce or dropped test event still creates a general delivery alert;
the account-action lifecycle receiver ignores the unknown correlation for its
separate account delivery record. Real historical provider events were not
received by LeagueVault and are not backfilled automatically, so the queue
begins with events received after configuration.

## Review alerts in LeagueVault

**Super Admin → Delivery Alerts** is available to system administrators only.
Organization administrators and other organization members cannot see this
global delivery operational data. The sidebar badge shows the number of
unacknowledged alerts. While the alert page is open, it refreshes the pending
queue every 60 seconds in a visible browser tab and when a system administrator
returns to it; the sidebar badge follows that count and also refreshes on its
normal focus/mount cycle.

The page shows the recipient, safe failure explanation, provider event time,
received time, sending IP when supplied, SMTP status when supplied, and the
acknowledgement history. Provider reason text and credentials are not shown.

Acknowledging an alert records that an administrator reviewed it. It does not
repair delivery, change the provider result, or resend the provider message.
Every new validated failure creates a new alert, and LeagueVault does not
automatically resend failed provider messages.
