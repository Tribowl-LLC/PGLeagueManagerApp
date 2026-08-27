import { Response } from 'express';
import { ZodError } from 'zod';
import { type User, type Organization, type Location, type Bowler, type Payment, type PaginationMeta } from '@shared/schema';

// Allowlist projection (deny-by-default) — the safer of the two
// strategies in task #327. Switching from a strip-list (`omit`) to an
// allowlist (`pick`) means a future column on `users` cannot leak
// just because its name happens to dodge the sensitive-name regex
// (e.g. `apiKey`, `clientSecret`, `webhookKey`, `credentials`,
// `authConfig`). Anything not on this list is dropped before the
// payload ever reaches the wire.
//
// Adding a new safe column? Add it here AND extend `SanitizedUser`
// implicitly via the `Pick<>` below. Adding a sensitive column?
// Don't list it. The regression test in
// `tests/unit/sanitize-user.test.ts` walks the live Drizzle schema
// and pins both halves of the contract.
//
// Exported so the deny-by-default contract test in
// `tests/api/safe-fields-contract.test.ts` can assert that the keys
// returned by real endpoints are a strict subset of this list — any
// new route that forgets to call `sanitizeUser` would surface a key
// that isn't on the allowlist and fail the integration test.
export const SAFE_USER_FIELDS = [
  'id',
  'email',
  'bowlerId',
  'name',
  'phone',
  'avatar',
  'role',
  'organizationId',
  'locationId',
  // The user's chosen UI / notification language (task #410 / #417).
  // Safe to expose so the account-settings selector can pre-fill the
  // currently saved value. The column is nullable — null means
  // "no preference, follow the default" (English today).
  'preferredLanguage',
  // Task #455: surface the "admin reset, please rotate" flag to the
  // client so the App.tsx route guards can intercept the user and
  // route them to /change-password-required before they can use any
  // of the rest of the app. Safe to expose: a non-tampered client
  // already sees their post-reset password (the admin gave it to
  // them) and the server-side guard cannot be bypassed by spoofing
  // this flag — it's authoritative on the DB row.
  'mustChangePassword',
  'createdAt',
] as const;

// Deny-list (task #501) — the inverse of `SAFE_USER_FIELDS`. Every
// column on `users.$inferSelect` is on EXACTLY ONE of these two
// lists; the compile-time exhaustiveness check below guarantees a
// new column on the table can't land without being classified.
//
// The structural wire-sanitization guard from task #382 catches raw
// `User` rows or shapes assignable to the full `User` type, but a
// hand-rolled projection like
//   sendSuccess(res, { id: u.id, password: u.password })
// is NOT structurally assignable to `User` (it's missing required
// columns) and so silently passes that gate. The complementary
// deny-by-default check in `scripts/check-wire-sanitization.ts`
// reads THIS list and fails on any inline-object property at a
// `sendSuccess` / `sendPaginatedSuccess` / `res.json` call site
// whose name OR initializer source matches a member here.
//
// Adding a new sensitive column? List it here. Adding a safe
// column? List it in `SAFE_USER_FIELDS`. The exhaustiveness check
// below fails type-check if a new column on `users.$inferSelect`
// is missing from BOTH lists, so the deny half can't go stale.
const SENSITIVE_USER_FIELDS = [
  'password',
  'inviteToken',
  'inviteTokenExpiry',
  'failedPasswordChangeAttempts',
  'passwordChangeLockedUntil',
] as const;

// Compile-time exhaustiveness check: SAFE ∪ SENSITIVE = keyof User.
// If a new column lands on the `users` table without being added to
// one of the two lists, `_UnclassifiedUserField` resolves to that
// column name and the assignment below fails to compile with a
// pointer to the missing field. Keeps the deny-list co-located with
// the safe-list so adding a new sensitive column can't be silently
// forgotten by the deny-list scanner.
type _UnclassifiedUserField = Exclude<
  keyof User,
  (typeof SAFE_USER_FIELDS)[number] | (typeof SENSITIVE_USER_FIELDS)[number]
>;
const _userFieldsExhaustive: [_UnclassifiedUserField] extends [never]
  ? true
  : ['ERROR: classify these User columns as SAFE or SENSITIVE', _UnclassifiedUserField] = true;
void _userFieldsExhaustive;

// Compile-time disjointness check: SAFE ∩ SENSITIVE = ∅. The
// exhaustiveness check above guarantees every column lands in AT
// LEAST one list; this one guarantees it lands in AT MOST one. A
// column appearing on both lists would mean the deny-list scanner
// flags a name the allowlist treats as safe — a contradiction that
// would silently break either sanitize round-trips or the wire
// guard. If a column is mistakenly added to both, this assignment
// fails to compile with a pointer to the duplicate name.
type _OverlappingUserField = Extract<
  (typeof SAFE_USER_FIELDS)[number],
  (typeof SENSITIVE_USER_FIELDS)[number]
>;
const _userFieldsDisjoint: [_OverlappingUserField] extends [never]
  ? true
  : ['ERROR: User columns appear on BOTH SAFE and SENSITIVE lists', _OverlappingUserField] = true;
void _userFieldsDisjoint;

export type SanitizedUser = Pick<User, typeof SAFE_USER_FIELDS[number]>;

export function sanitizeUser(user: User): SanitizedUser {
  const input = user as Record<string, unknown>;
  const safeUser: Record<string, unknown> = {};
  for (const field of SAFE_USER_FIELDS) {
    if (field in input) safeUser[field] = input[field];
  }
  return safeUser as SanitizedUser;
}

// Same allowlist strategy for organizations: anything new that lands on
// the table is dropped by default until it is deliberately added here.
//
// Exported alongside `SAFE_USER_FIELDS` so the integration test in
// `tests/api/safe-fields-contract.test.ts` can pin the wire contract
// against real organization endpoints.
export const SAFE_ORG_FIELDS = [
  'id',
  'name',
  'slug',
  'subdomain',
  'address',
  'city',
  'state',
  'zipCode',
  'phone',
  'email',
  'logo',
  'darkLogo',
  'appIcon',
  'active',
  'createdAt',
] as const;

// Deny-list (task #501) — the inverse of `SAFE_ORG_FIELDS`. The
// exhaustiveness check below pins that any future column has to be
// classified into one of the two halves before the project will
// type-check. The deny-list scanner in
// `scripts/check-wire-sanitization.ts` reads this list and fails
// any inline-object property at a `sendSuccess` /
// `sendPaginatedSuccess` / `res.json` call site whose name OR
// initializer source matches a member here — closing the gap that
// the structural check leaves open against hand-rolled projections
// like `sendSuccess(res, { slug: org.slug, credentials: org.credentials })`.
const SENSITIVE_ORG_FIELDS = [] as const;

// Same compile-time exhaustiveness check as for `User`: SAFE ∪
// SENSITIVE = keyof Organization. A new column on the table without
// classification fails type-check at this assignment.
type _UnclassifiedOrgField = Exclude<
  keyof Organization,
  (typeof SAFE_ORG_FIELDS)[number] | (typeof SENSITIVE_ORG_FIELDS)[number]
>;
const _orgFieldsExhaustive: [_UnclassifiedOrgField] extends [never]
  ? true
  : ['ERROR: classify these Organization columns as SAFE or SENSITIVE', _UnclassifiedOrgField] = true;
void _orgFieldsExhaustive;

// Disjointness counterpart of the User check above: SAFE ∩
// SENSITIVE = ∅. Catches an Organization column accidentally added
// to both lists.
type _OverlappingOrgField = Extract<
  (typeof SAFE_ORG_FIELDS)[number],
  (typeof SENSITIVE_ORG_FIELDS)[number]
>;
const _orgFieldsDisjoint: [_OverlappingOrgField] extends [never]
  ? true
  : ['ERROR: Organization columns appear on BOTH SAFE and SENSITIVE lists', _OverlappingOrgField] = true;
void _orgFieldsDisjoint;

export type SanitizedOrganization = Pick<Organization, typeof SAFE_ORG_FIELDS[number]>;

export function sanitizeOrg(org: Organization): SanitizedOrganization {
  const input = org as Record<string, unknown>;
  const safeOrg: Record<string, unknown> = {};
  for (const field of SAFE_ORG_FIELDS) {
    if (field in input) safeOrg[field] = input[field];
  }
  return safeOrg as SanitizedOrganization;
}

export function sanitizeOrgs(orgs: Organization[]): SanitizedOrganization[] {
  return orgs.map(sanitizeOrg);
}

// Same allowlist strategy for locations (task #381).
// The `squareCredentials` JSONB column holds the raw access token for
// the location's payment processor and must never appear on the wire.
// The dedicated `/api/locations/:id/square-config` endpoint publishes
// the safe boolean-flag projection
// (`accessTokenConfigured: true`); the base CRUD routes had been
// returning the raw blob alongside it for years. Anything new that
// lands on the table will be dropped by default until it's
// deliberately added here.
const SAFE_LOCATION_FIELDS = [
  'id',
  'name',
  'address',
  'city',
  'state',
  'zipCode',
  'phone',
  'active',
  'organizationId',
] as const;

export type SanitizedLocation = Pick<Location, typeof SAFE_LOCATION_FIELDS[number]>;

export function sanitizeLocation(location: Location): SanitizedLocation {
  const input = location as Record<string, unknown>;
  const safeLocation: Record<string, unknown> = {};
  for (const field of SAFE_LOCATION_FIELDS) {
    if (field in input) safeLocation[field] = input[field];
  }
  return safeLocation as SanitizedLocation;
}

export function sanitizeLocations(locations: Location[]): SanitizedLocation[] {
  return locations.map(sanitizeLocation);
}

// Same allowlist strategy for bowlers (task #381). Two flavors of
// risk live on this table:
//
//   1. Saved-card vault references that are not safe to publish
//      (`paymentProviderLocationId` is internal routing data for the
//      deletion service). This value has no UI consumer today and is dropped.
//
//   2. Payment-system identifiers and retry bookkeeping that the
//      bowlers/admin UI legitimately needs to render. These stay on
//      the allowlist because dropping them would silently break the UI;
//      they are not credentials.
//
// Anything new that lands on the table will be dropped by default
// until it's deliberately added here.
const SAFE_BOWLER_FIELDS = [
  'id',
  'name',
  'email',
  'phone',
  'active',
  'order',
  'organizationId',
  'paymentCustomerId',
  'paymentSyncPendingAt',
  'paymentSyncAttempts',
  'paymentSyncLastAttemptAt',
  'paymentSyncNextRetryAt',
] as const;

export type SanitizedBowler = Pick<Bowler, typeof SAFE_BOWLER_FIELDS[number]>;

export function sanitizeBowler(bowler: Bowler): SanitizedBowler {
  const input = bowler as Record<string, unknown>;
  const safeBowler: Record<string, unknown> = {};
  for (const field of SAFE_BOWLER_FIELDS) {
    if (field in input) safeBowler[field] = input[field];
  }
  return safeBowler as SanitizedBowler;
}

export function sanitizeBowlers(bowlers: Bowler[]): SanitizedBowler[] {
  return bowlers.map(sanitizeBowler);
}

// Same allowlist strategy for payments (task #504). Task #381 covered
// locations + bowlers; payments was deferred as lower-risk because
// the only sensitive-looking column is operational:
//
//   - `idempotencyKey` is a client-supplied dedupe key.
//
// It stays on the allowlist because UI consumers depend on it. The point of
// wiring an allowlist projection in anyway is
// deny-by-default for the *next* column: a future addition to the
// `payments` table (e.g. `processorWebhookSecret`, `merchantApiKey`,
// `customerCardToken`) will be dropped at the response boundary
// instead of silently riding along on every list / detail / refund
// response. Anything new that lands on the table will be dropped
// until it's deliberately added here.
const SAFE_PAYMENT_FIELDS = [
  'id',
  'organizationId',
  'bowlerId',
  'leagueId',
  'amount',
  'currency',
  'status',
  'type',
  'checkNumber',
  // Provider payment id powers the Square dashboard deep-link in
  // bowler-payment-history-table.tsx and the lazy receipt backfill
  // in view-receipt-button.tsx. Not a credential — Square treats it
  // as a public-ish reference (the dashboard URL contains it).
  'providerPaymentId',
  // Client-supplied dedupe key. Surfacing it back to the same client
  // that submitted it doesn't disclose anything new.
  'idempotencyKey',
  // Refund bookkeeping. `squareRefundId` is the provider-side
  // reference for the refund (parallel to `providerPaymentId` for
  // the original charge); the others are admin-visible refund
  // metadata rendered in the payment history.
  'squareRefundId',
  'refundReason',
  'refundedAt',
  // Dispute / chargeback bookkeeping (task #577). `disputeId` is the
  // provider-side dispute reference; `disputedAt` is when our webhook
  // receiver processed the event. Operational, surfaced in the admin
  // payment-history table.
  'disputeId',
  'disputedAt',
  // Square hosted-receipt cache (task #503). receiptUrl /
  // receiptNumber are the public hosted-receipt link Square emails
  // to the buyer; receiptEmailMissing drives the "no receipt sent"
  // badge on payments-table.tsx + payment-history-table.tsx and the
  // refund-dialog notice.
  'receiptUrl',
  'receiptNumber',
  'receiptEmailMissing',
  // Free-text admin notes attached to the payment row.
  'notes',
  // payer-attribution. Stamped on every autopay row
  // (including combined-autopay partner rows) so the UI can render a
  // "Paid by <name>" badge when someone other than the bowler funded
  // the payment. The id is safe to expose — paired with the
  // `paidByName` enrichment below it powers the bowler-history badge.
  'paidByUserId',
  'createdAt',
] as const;

export type SanitizedPayment = Pick<Payment, typeof SAFE_PAYMENT_FIELDS[number]> & {
  // optional display-only enrichment computed by the route
  // (NOT stored on the row). Set when `paidByUserId` resolves to a
  // user whose name (or fallback email) we can publish.
  paidByName?: string | null;
};

export function sanitizePayment(payment: Payment, paidByName?: string | null): SanitizedPayment {
  const input = payment as Record<string, unknown>;
  const safePayment: Record<string, unknown> = {};
  for (const field of SAFE_PAYMENT_FIELDS) {
    if (field in input) safePayment[field] = input[field];
  }
  if (paidByName) safePayment.paidByName = paidByName;
  return safePayment as SanitizedPayment;
}

export function sanitizePayments(
  payments: Payment[],
  paidByNameById?: Map<number, string>,
): SanitizedPayment[] {
  return payments.map((p) => {
    const name = p.paidByUserId && paidByNameById
      ? paidByNameById.get(p.paidByUserId) ?? null
      : null;
    return sanitizePayment(p, name);
  });
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function sendSuccess<T>(res: Response, data: T, status = 200) {
  const response: ApiResponse<T> = {
    success: true,
    data
  };
  res.status(status).json(response);
}

export function sendPaginatedSuccess<T>(res: Response, data: T[], pagination: PaginationMeta, status = 200) {
  res.status(status).json({
    success: true,
    data,
    pagination,
  });
}

/**
 * Parse an optional integer query-string parameter (task #421, lifted
 * out of `server/routes/payments/payment-reports.ts` so every list
 * endpoint can adopt the same contract).
 *
 * Returns `undefined` when the param is missing or is the empty
 * string (the route's "no filter" sentinel — clients that submit a
 * cleared form input must not get a 400) and `null` when the caller
 * sent something we couldn't make sense of — the route maps `null`
 * to a 400 with a per-filter error message.
 *
 * The validation is intentionally STRICT (digits with an optional
 * leading minus, nothing else): the previous `parseInt` + `isNaN`
 * pattern silently accepted partially-numeric input like
 * `?leagueId=42abc` as `42`, which is exactly the failure mode
 * task #406 set out to fix.
 */
export function parseOptionalIntParam(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  // Express normalizes single-occurrence query params to strings;
  // anything else (array, object) is malformed by definition.
  if (typeof raw !== 'string') return null;
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an optional date query-string parameter. Same tri-state
 * contract as `parseOptionalIntParam`: `undefined` = not provided,
 * `null` = unparseable (→ 400), Date = good. `new Date('garbage')`
 * returns an Invalid Date silently, so the old pattern would forward
 * those straight into the storage layer and trip a confusing 500.
 */
export function parseOptionalDateParam(raw: unknown): Date | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  if (raw === '') return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse an optional comma-separated integer-list query-string
 * parameter (e.g. `?ids=1,2,3`). Same tri-state contract — and a
 * single bad element (`?ids=1,foo,3`) makes the whole list `null` so
 * the caller learns that the request was malformed instead of
 * silently dropping the bad id.
 */
export function parseOptionalIntListParam(raw: unknown): number[] | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  if (raw === '') return undefined;
  const parts = raw.split(',');
  const result: number[] = [];
  for (const part of parts) {
    if (!/^-?\d+$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n)) return null;
    result.push(n);
  }
  return result;
}

export function parsePaginationParams(query: Record<string, unknown>): { page: number; limit: number } | null {
  const page = query.page ? parseInt(query.page as string) : undefined;
  const limit = query.limit ? parseInt(query.limit as string) : undefined;

  if (page === undefined && limit === undefined) return null;

  const safePage = (page && !isNaN(page) && page > 0) ? page : 1;
  const safeLimit = (limit && !isNaN(limit) && limit > 0) ? Math.min(limit, 100) : 50;

  return { page: safePage, limit: safeLimit };
}

export function handleZodError(res: Response, error: ZodError) {
  sendError(res, 'Validation error', 400, 'VALIDATION_ERROR', error.format());
}

/**
 * If the error came from one of the typed user-org guards
 * (`NonAdminMissingOrgError`), responds with
 * a 400 ORG_REQUIRED and returns true so the caller can short-circuit.
 * Otherwise returns false and the caller should fall through to its
 * normal error handling.
 */
export function handleUserOrgError(res: Response, error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  if (name === 'NonAdminMissingOrgError') {
    const message = (error as { message?: string }).message ||
      'Non-admin users must belong to an organization.';
    sendError(res, message, 400, 'ORG_REQUIRED');
    return true;
  }
  if (name === 'ElevatedRoleBowlerLinkError') {
    const message = (error as { message?: string }).message ||
      'Staff accounts cannot be linked to bowler records.';
    sendError(res, message, 409, 'STAFF_BOWLER_CONFLICT');
    return true;
  }
  if (name === 'PaymentManagerScopeError') {
    const message = (error as { message?: string }).message ||
      'Payment managers must have an organization and location.';
    sendError(res, message, 400, 'LOCATION_REQUIRED');
    return true;
  }
  return false;
}

/**
 * Canonical error-code values:
 *
 *   - 404 → 'NOT_FOUND' (default for the "resource not found" case).
 *     Domain-narrowed alternatives 'USER_NOT_FOUND',
 *     'LEAGUE_NOT_FOUND', and 'RECEIPT_UNAVAILABLE' are also
 *     accepted; everything else (`'NotFound'`, `'not_found'`,
 *     missing arg → falls back to `'ServerError'`) is drift.
 *
 * The 4xx code values for 404 specifically are pinned by
 * `scripts/check-not-found-code.ts` (task #552), which fails CI on
 * any new `sendError(res, msg, 404, 'NotFound')`-style call site
 * under `server/routes/`. Pre-existing drift is captured in that
 * script's KNOWN_VIOLATIONS baseline pending the unification
 * cleanup task. The `code: string` parameter type is intentionally
 * left wide here so other status codes can declare their own
 * conventions without forcing this guard to enumerate them.
 */
export function sendError(
  res: Response,
  message: string,
  status: number = 500,
  code: string = 'ServerError',
  details?: unknown
) {
  const response: ApiResponse<null> = {
    success: false,
    error: {
      code,
      message,
      details
    }
  };

  res.status(status).json(response);
}
