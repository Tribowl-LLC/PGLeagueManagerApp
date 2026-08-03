/**
 * Integration test that the dormant Square webhook receiver
 * is actually reachable in the running app stack WITHOUT session auth
 * and WITHOUT a CSRF token.
 *
 * Pins three properties of the wiring at once:
 *   1. The Square receiver is mounted before `requireAuth` in
 *      `server/routes/index.ts`. If a future refactor
 *      re-applies session auth to the prefix, this test fails with
 *      `AUTH_REQUIRED` instead of the expected dormant response.
 *   2. The CSRF exemption at `server/middleware/csrf.ts` covers the
 *      whole `/payments-provider/webhooks` prefix, including the
 *      Square receiver. A CSRF rejection (`CSRF_ERROR`) here would mean
 *      the exemption was removed unexpectedly.
 *   3. The dormant receiver returns 503 with the documented error code,
 *      not a generic 404 / 500.
 *
 * The unit test in `tests/unit/square-webhook.test.ts` covers the signature,
 * raw-body, ingestion, and log-safety contracts; this file is about wiring.
 */
import { describe, it, expect } from 'vitest';
import { BASE_URL } from '../helpers';

describe('POST /api/payments-provider/webhooks/square is reachable without session/CSRF', () => {
  it('returns the dormant-mode response when called anonymously', async () => {
    const res = await fetch(`${BASE_URL}/api/payments-provider/webhooks/square`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'payment.updated',
        event_id: 'evt_routing_sq_1',
      }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const body = await res.json().catch(() => ({}));
    expect(body?.success).toBe(false);
    expect(body?.error?.code).toBe('SQUARE_WEBHOOK_DISABLED');
    // Sanity: must not be the wrong reason. AUTH_REQUIRED would
    // mean the session-auth mount swallowed the request before it
    // reached the receiver; CSRF_ERROR would mean the exemption was
    // narrowed; 404 would mean the route wasn't mounted at all.
    expect(body?.error?.code).not.toBe('AUTH_REQUIRED');
    expect(body?.error?.code).not.toBe('CSRF_ERROR');
  });
});
