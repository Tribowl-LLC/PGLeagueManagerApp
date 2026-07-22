# Third-Party Pin Verifiers

**Filed under:** Task #651
**Owner module:** `server/services/third-party-pin-verifier.ts`
**Registrations:** `server/services/third-party-pins.ts`
**Boot wiring:** `server/index.ts` → `verifyAllThirdPartyPins()`

---

## Why this exists

Task #627 added a runtime guard for the Square `Square-Version`
header so that a silent SDK upgrade — a hotfix
`npm i square@latest`, a `package-lock.json` regen, an unintentional
major-version float — couldn't ship a different wire version into
production unnoticed. The merge-gating CI test (#614) catches drift
in the lockfile that's about to merge; the runtime guard catches
drift in the lockfile that's *actually running*.

The same risk pattern applies to every other pinned third-party
client we depend on. This doc lists each pin we verify, what the
probe does, and what to do when it pages.

When a verifier paged, you'll see exactly one structured log line
of the form:

```
[ERROR] [<ProviderLogger>] [PAGE] <provider> <pinName> drift detected at runtime
        {"provider":"<provider>","pinName":"<pinName>","expected":"<X>","actual":"<Y>",
         "runbook":"docs/third-party-pins.md#<provider>","remediation":"…"}
```

`[PAGE]` is the on-call grep convention for `error` lines that need
immediate attention. Subsequent calls do **not** re-emit the line —
each verifier is memoized per process — so a paging deploy emits
the line once at boot and once per fresh restart.

---

## How a probe works

Every verifier in the registry implements:

```ts
interface PinVerifier {
  provider: string;        // 'square', 'sendgrid'
  pinName: string;         // human-friendly literal name
  expected: string;        // the audited wire literal
  probe: () => Promise<PinProbeResult>;
  runbook: string;         // anchor in this doc
  onResult: (outcome) => void; // logging + side effects (e.g. fail-shut)
}
```

A probe must capture the *current* wire literal **without making a
real network call**. Today's techniques:

1. **Fake-fetcher capture** (Square). Build a real `SquareClient`
   with a fetcher that records the headers and short-circuits
   before dispatch. Read `square-version` off the captured
   request.
2. **SDK metadata read** (SendGrid). Read `package.json` major +
   the SDK singleton's `client.defaultRequest.baseUrl`. Catches
   accidental major-version floats and region-helper firings.

Probes that throw or can't capture are treated as **non-conclusive**
(`info` line, no fail-shut). Probes that capture a wrong value are
treated as **drift** (paging `error` line, optional fail-shut).

---

## Registered pins

### Square

- **Anchor:** `#square`
- **Pin name:** `Square-Version` header
- **Expected:** `SQUARE_EXPECTED_VERSION` (currently `2026-01-22`)
- **Source of truth:** `docs/square-api-version-audit.md` §1
- **Probe:** fake-fetcher capture against a real `SquareClient`,
  reads `square-version` off `payments.get`'s headers (see
  `defaultProbeSquareSdkVersion` in `server/services/square-provider.ts`).
- **Drift behavior:** **fail-shut**. `getSquareClient()` returns
  `null`, route layer surfaces `PROVIDER_NOT_CONFIGURED` 422.
- **Recovery:** see `docs/square-api-version-audit.md` §6 (operator
  pre-flight checklist). Pin the `square` package back to a version
  whose `Square-Version` equals `SQUARE_EXPECTED_VERSION`, or
  re-run the audit in §1/§5 and update `SQUARE_EXPECTED_VERSION`
  + §1 in the same commit.
- **Tests:**
  - Merge-gating: `server/services/__tests__/square-version-header.test.ts`
  - Runtime guard: `server/services/__tests__/square-version-runtime-guard.test.ts`

### SendGrid

- **Anchor:** `#sendgrid`
- **Pin name:** SDK major + API base URL
- **Expected:** `8|https://api.sendgrid.com/`
- **Source of truth:** `@sendgrid/mail` package version + the
  `Client` constructor in
  `node_modules/@sendgrid/client/src/classes/client.js`.
- **Probe:** read `version` off `@sendgrid/mail/package.json`,
  parse the major number, and read
  `sgMail.client.defaultRequest.baseUrl` off the SDK singleton.
  Both checks together so a region-helper firing
  (`https://api.eu.sendgrid.com/`) or a Twilio-Email auth swap
  (`https://email.twilio.com/`) trips the alert in addition to a
  major bump.
- **Drift behavior:** paging `error` line; **does not** fail-shut.
  Email is best-effort across the codebase (every
  `sendTemplatedEmail` call returns `false` on failure rather than
  throwing) so refusing to send on drift would silently break
  notifications. The page is the alert; investigation decides
  whether to roll back.
- **Recovery:** Pin `@sendgrid/mail` back to the audited major
  (`^8`). If a real upgrade is intended, walk every send-site in
  `server/services/email.ts` against the new SDK's request shape
  (especially `MailDataRequired`, `trackingSettings`, and the
  domain-blocklist `dispatchMail` wrapper from task #593), then
  bump `SENDGRID_EXPECTED_MAJOR` + the audit row above in the same
  commit. A non-default base URL means a region or Twilio-Email
  helper fired unexpectedly — investigate before suppressing.

---

## Adding a new pin

When you add a new third-party client (HTTP API, SDK, webhook
receiver), add a pin verifier in the same commit. Checklist:

1. Identify the wire literal you'd want to know had silently
   changed (header value, base URL, signature algorithm, schema
   version, etc.).
2. Write a probe that captures it without a real network call.
   Pick the closest pattern from the four above.
3. Register the verifier in `server/services/third-party-pins.ts`
   using `makeDefaultPinOnResult` unless you have a back-compat
   reason to format the log differently.
4. Add a row in this doc's "Registered pins" section. Include the
   anchor, expected literal, source of truth, probe technique,
   drift behavior (fail-shut or page-only), and recovery steps.
5. Add a test under `server/services/__tests__/` that exercises
   the verifier's match / drift / non-conclusive branches against
   the shared registry — see
   `server/services/__tests__/third-party-pin-verifier.test.ts`
   for a template.
