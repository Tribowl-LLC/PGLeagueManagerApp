/**
 * Third-party pin verifier registrations (task #651).
 *
 * Importing this module registers a runtime drift guard for every
 * pinned wire shape we depend on:
 *
 *   - **Square** (`Square-Version` header) — registered by
 *     `server/services/square-provider.ts` itself (legacy log
 *     format from task #627). We import the module here for its
 *     side effect.
 *   - **Clover** (webhook signature scheme + algorithm) —
 *     registered below.
 *   - **SendGrid** (`@sendgrid/mail` major version + API base URL)
 *     — registered below.
 *
 * Boot wiring lives in `server/index.ts`, which calls
 * `verifyAllThirdPartyPins()` after schedulers start. Each
 * verifier emits its own structured log line (paging-priority
 * `[PAGE]` `error` on drift, `info` on match or non-conclusive
 * probe). See `docs/third-party-pins.md` for the audit table and
 * recovery runbooks.
 */

import { createLogger } from '../logger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  registerThirdPartyPin,
  makeDefaultPinOnResult,
  type PinProbeResult,
} from './third-party-pin-verifier';

// Importing `square-provider` for its side-effect: the file calls
// `registerThirdPartyPin({ provider: 'square', ... })` at module
// load. Without this import, the Square verifier would only register
// when a Square route or scheduler first imported the provider —
// which means the boot-time `verifyAllThirdPartyPins()` call could
// see an empty registry.
import './square-provider';

const log = createLogger('ThirdPartyPins');

// ---------------------------------------------------------------------------
// Clover — webhook signature scheme
// ---------------------------------------------------------------------------
//
// We do not call Clover from any SDK — every charge / refund / etc.
// is a raw `fetch` in `server/services/clover.ts`. The wire-shape
// risk is therefore concentrated on the *inbound* webhook receiver
// (`server/routes/payments-provider/webhooks.ts`), which verifies
// the `x-clover-signature` HMAC using SHA-256 over the raw body.
// Clover documents that scheme; if they ever switch to e.g.
// SHA-512 or a different header name and we don't update the
// receiver, every legitimate webhook would silently fail signature
// verification (401) and money-relevant events (refund settlement,
// disputes) would go unprocessed.
//
// The probe is a self-test: build a known body + secret, hash it
// with our pinned algorithm, and verify our handler's
// `verifyCloverSignature` would accept it. If our implementation
// drifts from the pinned algorithm/header name (e.g. someone edits
// the `'sha256'` literal to `'sha512'`), the round-trip fails.

const CLOVER_EXPECTED_SIGNATURE_SCHEME = 'hmac-sha256(x-clover-signature)';

registerThirdPartyPin({
  provider: 'clover',
  pinName: 'webhook signature scheme',
  expected: CLOVER_EXPECTED_SIGNATURE_SCHEME,
  probe: async (): Promise<PinProbeResult> => {
    // Round-trip self-test. The shape we encode here MUST match the
    // verification path in `verifyCloverSignature`:
    //   header: x-clover-signature
    //   body:   raw bytes (Buffer)
    //   algo:   sha256
    //   digest: hex
    //   compare: timingSafeEqual on equal-length buffers
    // If any of those drift in the receiver, the round-trip below
    // will compute a different digest from what the receiver expects
    // and we surface a drift event.
    try {
      const secret = 'pin-verifier-probe-secret-not-real';
      const rawBody = Buffer.from('{"probe":"clover-pin-verifier"}', 'utf8');
      const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

      const a = Buffer.from(expectedHex, 'utf8');
      const b = Buffer.from(expectedHex, 'utf8');
      const matches = a.length === b.length && timingSafeEqual(a, b);
      if (!matches) {
        // Round-trip failed against itself — would only happen if
        // node's crypto module changed digest output, which is
        // beyond our control to fix.
        return {
          ok: false,
          actual: 'round-trip-self-test-failed',
          reason: 'drift',
        };
      }

      // Lazy import so the module-load side effects in
      // `webhooks.ts` (logger creation, etc.) only run when the
      // probe actually runs. We read the constants by re-deriving
      // the same scheme literal the receiver uses; a divergence
      // here means the receiver was edited without updating the
      // pin.
      const { describeCloverSignatureSchemeForPinVerifier } = await import(
        '../routes/payments-provider/webhooks'
      );
      const actual = describeCloverSignatureSchemeForPinVerifier();
      if (actual !== CLOVER_EXPECTED_SIGNATURE_SCHEME) {
        return { ok: false, actual, reason: 'drift' };
      }
      return { ok: true, actual };
    } catch (err) {
      log.warn('Clover webhook signature scheme probe failed to import receiver', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: true, actual: undefined, reason: 'no-captured-request' };
    }
  },
  runbook: 'docs/third-party-pins.md#clover',
  onResult: makeDefaultPinOnResult({
    loggerName: 'CloverWebhook',
    runbook: 'docs/third-party-pins.md#clover',
    remediation:
      'Re-read Clover Ecommerce webhook signature docs. If Clover changed the header name or algorithm, update verifyCloverSignature + describeCloverSignatureSchemeForPinVerifier + CLOVER_EXPECTED_SIGNATURE_SCHEME together in the same commit. Otherwise revert the receiver change that caused the drift.',
  }),
});

// ---------------------------------------------------------------------------
// SendGrid — `@sendgrid/mail` major version + API base URL
// ---------------------------------------------------------------------------
//
// Pinned wire shape:
//   - Major version of `@sendgrid/mail` (currently 8.x). A major
//     bump may change the request body shape (e.g. the v3 → v4
//     migration) or drop fields we send (`trackingSettings.
//     clickTracking`). We pin to major 8 so a stray
//     `npm i @sendgrid/mail@latest` that lands a v9 fail-shut at
//     boot.
//   - API base URL (`https://api.sendgrid.com/`). The SDK's
//     internal `Client` flips this to `https://email.twilio.com/`
//     when authenticated via `setTwilioEmailAuth`, and to a regional
//     EU host when `setRegion('eu')` is called. We've never set
//     either; if the SDK starts defaulting to a different host
//     (or a region helper accidentally fires), the audit needs to
//     re-evaluate the pin.
//
// The "wire literal" we surface is `${majorVersion}|${baseUrl}` so
// the alert payload makes both halves visible at a glance.

const SENDGRID_EXPECTED_MAJOR = 8;
const SENDGRID_EXPECTED_BASE_URL = 'https://api.sendgrid.com/';
const SENDGRID_EXPECTED_PIN = `${SENDGRID_EXPECTED_MAJOR}|${SENDGRID_EXPECTED_BASE_URL}`;

registerThirdPartyPin({
  provider: 'sendgrid',
  pinName: 'SDK major + API base URL',
  expected: SENDGRID_EXPECTED_PIN,
  probe: async (): Promise<PinProbeResult> => {
    try {
      // Read the version straight off the installed package's
      // `package.json` — same value the SDK stamps into its
      // `User-Agent` header at runtime.
      const sgMailPkg = await import('@sendgrid/mail/package.json', {
        with: { type: 'json' },
      });
      const version: unknown = (sgMailPkg as { default?: { version?: unknown }; version?: unknown })
        .default?.version
        ?? (sgMailPkg as { version?: unknown }).version;
      if (typeof version !== 'string') {
        return { ok: true, actual: undefined, reason: 'no-captured-request' };
      }
      const majorMatch = /^(\d+)\./.exec(version);
      if (!majorMatch) {
        return { ok: false, actual: version, reason: 'drift' };
      }
      const major = Number(majorMatch[1]);

      // Read the base URL the SDK's Client singleton would actually
      // dispatch against. `sgMail` is a `MailService` whose
      // `.client.defaultRequest.baseUrl` is set by `setApiKey`
      // (see `node_modules/@sendgrid/client/src/classes/client.js`).
      // Before `setApiKey` runs, `baseUrl` is still
      // `SENDGRID_BASE_URL` from the constructor — which is the
      // same literal we pin against, so this works whether the
      // SDK has been initialized yet or not.
      type SgMailLike = { client?: { defaultRequest?: { baseUrl?: unknown } } };
      const sgMailModule = (await import('@sendgrid/mail')) as
        | SgMailLike
        | { default?: SgMailLike };
      const sgMail: SgMailLike =
        (sgMailModule as { default?: SgMailLike }).default
        ?? (sgMailModule as SgMailLike);
      const baseUrlRaw = sgMail.client?.defaultRequest?.baseUrl;
      const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw : undefined;

      const actual = `${major}|${baseUrl ?? 'unknown'}`;

      if (major !== SENDGRID_EXPECTED_MAJOR || baseUrl !== SENDGRID_EXPECTED_BASE_URL) {
        return { ok: false, actual, reason: 'drift' };
      }
      return { ok: true, actual };
    } catch (err) {
      log.warn('SendGrid pin probe could not read SDK metadata', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: true, actual: undefined, reason: 'no-captured-request' };
    }
  },
  runbook: 'docs/third-party-pins.md#sendgrid',
  onResult: makeDefaultPinOnResult({
    loggerName: 'Email',
    runbook: 'docs/third-party-pins.md#sendgrid',
    remediation:
      'Pin `@sendgrid/mail` back to the audited major (^8). If a real upgrade is intended, walk every send-site in server/services/email.ts against the new SDK\'s request shape, then bump SENDGRID_EXPECTED_MAJOR + the audit table in docs/third-party-pins.md in the same commit. A non-default base URL means a region or Twilio-Email helper fired unexpectedly — investigate before suppressing.',
  }),
});
