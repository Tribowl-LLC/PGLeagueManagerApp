# `log.debug` PII Audit (Task #336)

This is the inventory of every `log.debug` / `logger.debug` call site under
`server/` as of task #336, with a per-site verdict on whether the payload is
safe to surface in production when an operator deliberately opts into
`LOG_LEVEL=debug` to debug a live incident.

The default minimum log level in production is `info` (see task #306 and the
operator note in `docs/AGENTS.md`), so debug lines do not flow by default. This
audit exists so an operator can flip to `LOG_LEVEL=debug` without leaking
PII into a production log sink.

## Definition of "PII" used here

Treated as PII / sensitive and **not allowed** at debug level in raw form:

- Email addresses (full or partial — must be routed through `maskEmail` in
  `server/utils/pii.ts`).
- Personal names, phone numbers, mailing addresses.
- Payment identifiers (Square payment ids, Clover charge ids, customer
  ids, card-on-file ids).
- Session ids, CSRF tokens, password hashes, invite/setup secrets,
  password-reset tokens.
- Free-text user-supplied content that has not been validated as
  non-sensitive.

Treated as **acceptable** at debug level:

- Internal numeric primary keys (`bowlerId`, `userId`, `organizationId`,
  `leagueId`, `paymentId`, …). These correlate to a person only via direct
  database access, which an operator with log access already has.
- Role names (`system_admin`, `org_admin`, `user`).
- Resource type strings, status strings, structural counts.
- Dev-utility state: workflow names, port numbers, health-check booleans,
  file-system paths under `/tmp` or repo-relative paths.

## Inventory

### `server/utils/access-control.ts` — 5 sites
Lines 48, 66, 144, 270, 306. Logs the deny-on-null branch of every
authorization helper (`requireOrganizationAccess`, `hasAccessToLeague`,
`hasAccessToBowler`, `hasAccessToPayment`).

Payload: `resourceType`, `resourceId`, `userId`, `role`.

**Verdict: safe.** Internal numeric ids only. This is the original
motivating site for routing org-less drift signal at debug instead of
warn (see task #296 and the operator note in `docs/AGENTS.md`). The doc
comment at the top of the file already pins the contract.

### `server/utils/bowler-claim-tokens.ts:88`
`registered bowler claim: bowler=<id> user=<id> org=<id|null>`

Payload: three internal numeric ids.

**Verdict: safe.** No email/name. The `org=null` literal is a structural
fact (org-less user), not a value derived from user input.

### `server/routes/organizations.ts:208`
`Create request body keys: <Object.keys(orgData)>`

Payload: just the *names* of the fields the client submitted (e.g.,
`["name", "slug", "subdomain", "address"]`). Crucially this does NOT
log the values.

**Verdict: safe.** Diagnostic for debugging schema-validation failures
during org creation. No PII.

### `server/utils/wait-for-port.ts` — 19 sites
Lines 36, 41, 46, 50, 56, 63, 69, 81, 87, 93, 97, 108, 122, 128, 141,
154, 160, 169, 180. Dev-only utility that waits for the Replit dev
workflow's port to be listening before firing health checks.

Payloads logged: workflow name string, port number, attempt counters,
health-check HTTP status codes, port-status JSON (which contains
workflow + port + listening boolean), file-not-found / network errors.

**Verdict: safe.** This file is only invoked by the dev workspace
startup orchestration. No request bodies, no user data, no auth state.

## Summary

- **Total `log.debug` call sites audited**: 26 (5 + 1 + 1 + 19).
- **Sites that needed redaction**: 0.
- **Sites converted to `log.warn` with sanitized payload**: 0.

No code changes were required. The audit verifies that today's debug
output is incident-safe for an operator opting into `LOG_LEVEL=debug`
on a production deploy.

## Future-proofing

When adding a new `log.debug` call site under `server/`:

1. Default to logging internal numeric ids and structural facts only.
2. If you must include an email or other identifying string, route it
   through `maskEmail` (or extend `server/utils/pii.ts` with a new
   redactor) before interpolation.
3. Never log request/response bodies wholesale, payment identifiers,
   tokens, or password material — even at debug.
4. If a debug payload would only be safe in dev, gate the call with
   `if (isDev) log.debug(...)` so it cannot be opted into in prod.

## Enforcement (tasks #389, #405)

The contract above is enforced in CI by
[`scripts/check-log-debug-pii.ts`](../scripts/check-log-debug-pii.ts),
driven by the vitest forcing function in
[`tests/unit/check-log-debug-pii.test.ts`](../tests/unit/check-log-debug-pii.test.ts).
The guard walks every `.ts` file under `server/` (excluding
`*.test.ts` and `__tests__/`), parses it with the TypeScript
compiler, walks each `log.debug(...)` / `logger.debug(...)` call
expression (including aliased and destructured forms — `const d =
log.debug; d(...)`, `const { debug } = log; debug(...)`, optional
chaining, and bracket-notation access), and fails the build when its
argument list contains any of `email`, `password`, `token`, `phone`,
`address`, or `secret` without one of:

1. A `mask*` helper call (`maskEmail`, etc.) **inside the same
   subtree** as the offending value. The exemption is per-argument
   and per-property: a `mask*` call on one object field exempts only
   that field's value, not sibling fields or sibling arguments. Add
   new redactors to `server/utils/pii.ts`.
2. An inline `/* pii-lint-ok: <reason> */` annotation comment with a
   non-empty reason after the colon. Used only when reviewers can
   verify the payload is structural (e.g. logging field *names*
   rather than values). An empty `pii-lint-ok:` does not suppress.

Run the guard locally with:

```
tsx scripts/check-log-debug-pii.ts            # advisory
tsx scripts/check-log-debug-pii.ts --strict   # CI gate
```

When the team picks a CI provider, wire the `--strict` invocation as
its own step alongside the existing checks.
