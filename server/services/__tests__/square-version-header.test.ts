import { describe, it, expect, vi } from 'vitest';

import { SQUARE_EXPECTED_VERSION, buildSquareClient } from '../square-provider.js';

/**
 * Task #614 — Catch Square SDK header drift in CI.
 *
 * Background: `docs/square-api-version-audit.md` §1 confirmed that
 * the SDK's *baked-in* `Square-Version` header (`2026-05-20` in
 * `square@44.2.0`) is what actually goes on the wire — the dashboard
 * pin is functionally inert today. That fact is only documented in
 * the audit doc; nothing in CI would catch it if a future SDK
 * upgrade silently changed the header (e.g. Square ships
 * `square@45` with a different default), which could subtly change
 * response shapes across every call site at once.
 *
 * This test asserts that:
 *   1. The SDK still sends a `Square-Version` header.
 *   2. The header value still equals `SQUARE_EXPECTED_VERSION`
 *      (currently `2026-05-20`), which is the constant the audit
 *      doc was written against.
 *
 * It uses the *same* `buildSquareClient` factory that
 * `getSquareClient` in `server/services/square-provider.ts` calls,
 * so any drift in how the production client is constructed (e.g.
 * someone adding a `version: '2025-01-23'` override on the
 * SquareClient options) will be caught here too.
 *
 * If this test fails after a `square` package upgrade, do NOT just
 * bump the constant. Re-run the audit in
 * `docs/square-api-version-audit.md` §1 + §6 first — a header
 * change means the wire version changed for every single call
 * site at once.
 */

const AUDIT_HINT =
  'Re-run the audit in docs/square-api-version-audit.md §1 (effective ' +
  'header) and §6 (operator pre-flight checklist) before changing ' +
  'SQUARE_EXPECTED_VERSION or bumping the `square` package.';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, unknown>;
}

/**
 * Build a Square client with a fake `fetcher` that captures the
 * outgoing request and short-circuits the network call. We don't
 * need a successful API response — we only need to capture the
 * headers the SDK assembles before dispatch. Returning a
 * `FailedResponse` lets us surface the captured request even though
 * the SDK throws downstream.
 */
async function buildClientCapturingRequests(): Promise<{ captured: CapturedRequest[]; client: Awaited<ReturnType<typeof buildSquareClient>> }> {
  const captured: CapturedRequest[] = [];
  const fetcher = vi.fn(async (args: { url: string; method: string; headers?: Record<string, unknown> }) => {
    captured.push({
      url: args.url,
      method: args.method,
      headers: args.headers ?? {},
    });
    // Shape mirrors `APIResponse<R, Fetcher.Error>` with the
    // `UnknownError` variant so the SDK can surface a clean
    // test-only error without trying to parse a body. The SDK's
    // `RawResponse` is structurally `Response` minus `ok`/`body`/
    // `bodyUsed`, so we use a real (empty) `Response` instance.
    const rawResponse = new Response(null, { status: 599, statusText: 'short-circuited' });
    return {
      ok: false as const,
      error: { reason: 'unknown' as const, errorMessage: 'short-circuited by version-header test' },
      rawResponse,
    };
  });
  // Production-shaped token (`EAAAEv...` is recognized by
  // `buildSquareClient`'s heuristic as a Production token, so this
  // exercises the same Production environment URL the live code
  // uses). The token is a well-formed prefix only; no real call
  // leaves the test because `fetcher` short-circuits.
  const client = await buildSquareClient(
    'EAAAEvFAKE_TEST_TOKEN_NOT_A_REAL_SECRET',
    undefined,
    { fetcher },
  );
  return { captured, client };
}

describe('Square SDK Square-Version header (task #614)', () => {
  it('sends Square-Version: SQUARE_EXPECTED_VERSION on payments.get', async () => {
    const { captured, client } = await buildClientCapturingRequests();

    // Any real SDK method works — `payments.get` is small and has
    // no required body. The SDK will throw because our fetcher
    // returns `ok: false`; we ignore the throw because we only
    // care about the captured headers from before dispatch.
    await client.payments.get({ paymentId: 'noop-test-id' }).catch(() => undefined);

    const firstRequest = captured[0];
    expect(firstRequest).toBeDefined();
    if (!firstRequest) return; // type narrow for the rest of the test
    // The SDK's fetcher lowercases header keys before dispatch
    // (HTTP/2-style canonicalization), so we look at
    // `square-version`. The wire literal is `Square-Version`; the
    // case-insensitive match is what matters.
    const version = firstRequest.headers['square-version'];

    expect(
      version,
      `${AUDIT_HINT}\n\nThe SDK did not send a 'Square-Version' header at all.`,
    ).toBeDefined();
    expect(
      version,
      `${AUDIT_HINT}\n\nExpected Square-Version=${SQUARE_EXPECTED_VERSION} but the ` +
        `SDK sent Square-Version=${String(version)}. This means the installed ` +
        '`square` package now defaults to a different API version than the audit ' +
        'reviewed. Every Square call site is now talking to a different version ' +
        'at once — re-audit before merging.',
    ).toBe(SQUARE_EXPECTED_VERSION);
  });

  it('also sends Square-Version on a different resource (catalog.list)', async () => {
    // Belt-and-suspenders: the SDK assembles the header *per
    // resource client* (each generated `Client.js` sets it
    // independently — see `node_modules/square/api/resources/*/client/Client.js`).
    // Asserting on a second resource catches the (unlikely) case
    // where one client drifts from the rest after a regen.
    const { captured, client } = await buildClientCapturingRequests();

    // `catalog.list` returns an `HttpResponsePromise<Page<>>`. Just
    // await it directly — it dispatches the first page on await,
    // which is all we need for the header capture.
    await client.catalog.list({ types: 'ITEM' }).catch(() => undefined);

    const firstRequest = captured[0];
    expect(firstRequest).toBeDefined();
    if (!firstRequest) return;
    expect(
      firstRequest.headers['square-version'],
      `${AUDIT_HINT}\n\ncatalog.list sent a different Square-Version than ` +
        `payments.get — generated SDK clients have drifted within square@*.`,
    ).toBe(SQUARE_EXPECTED_VERSION);
  });

  it('SQUARE_EXPECTED_VERSION matches the date format Square publishes (YYYY-MM-DD)', () => {
    // Cheap structural guard so a typo in the constant
    // (e.g. `2026-1-22`, missing zero-padding) is caught
    // immediately rather than only when the next SDK upgrade
    // surfaces the mismatch.
    expect(
      SQUARE_EXPECTED_VERSION,
      `${AUDIT_HINT}\n\nSQUARE_EXPECTED_VERSION must be a YYYY-MM-DD string.`,
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
