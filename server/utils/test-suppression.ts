/**
 * Test-only "kick suppression" headers (#569, #571).
 *
 * Each background worker the dev server runs that mutates rows the
 * test suite reads is paired with a header that, when present AND
 * `NODE_ENV !== 'production'`, short-circuits the route's worker
 * kick. Without this, the dev server's live worker shares a DB with
 * the vitest suite and races test assertions by acting on rows tests
 * just inserted (#569 was the original incident on apple-pay; #571
 * generalises the convention to every other route-kicked worker).
 *
 * The NODE_ENV check is the security gate: production deploys ignore
 * the header regardless of value, so the convention cannot be abused
 * to disable a production worker by spoofing the header.
 *
 * Convention for adding a new worker:
 *   1. Pick a header name of the shape `x-test-suppress-<worker>-kick`
 *      and export it as a constant from this file.
 *   2. Gate the worker kick at the route boundary with
 *      `isTestKickSuppressed(req, HEADER)`.
 *   3. Add the new header to `tests/helpers.ts:withTestBypassHeader`
 *      so every test request is shielded by default.
 */
export function isTestKickSuppressed(
  req: { headers: Record<string, unknown> },
  headerName: string,
): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return req.headers[headerName] === '1';
}

/** Suppresses `applePayWorker.kick()` / `enqueue` kick in dev (#569). */
export const APPLE_PAY_WORKER_KICK_HEADER = 'x-test-suppress-apple-pay-kick';
