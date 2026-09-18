/**
 * Square Customer Custom Attribute helpers (task #429).
 *
 * The bowler-customer sync writes two seller-scoped attributes onto
 * every Square customer record so admins can build Smart Lists in
 * Square Marketing without leaving Square:
 *
 *   league_name   — alphabetical comma-joined list of leagues the
 *                   bowler is currently in (active rows only).
 *   league_season — distinct season labels (e.g. "Fall '25 Season"),
 *                   chronological by `seasonStart`.
 *
 * Each attribute requires a one-time *definition* per Square seller
 * account. `ensureDefinitions` creates both definitions and treats
 * "already exists" (HTTP 409 / `BAD_REQUEST` with a duplicate-key
 * detail) as success so it is safe to call on every cold start AND
 * lazily before each upsert.
 *
 * The definitions are intentionally *neutral* (no LeagueVault wording
 * or branding leaks into the seller's Square dashboard) per the task
 * spec: keys + names use generic "League Name" / "League Season".
 *
 * Visibility is `VISIBILITY_READ_ONLY` — the documented setting that
 * surfaces the attribute in Square's Customer Directory UI and in
 * Square Marketing Smart List filters, while preventing other Square
 * apps from overwriting our values.
 *
 * This module is intentionally STATELESS: it takes a Square `Client`
 * from the caller (the SquarePaymentProvider) so it can be unit-
 * tested with a mock client and so it has no circular dependency on
 * `square-provider.ts`. Per-seller bootstrap caching lives on the
 * provider where the locationId is naturally available.
 */
import type { SquareClient, SquareError as SquareErrorT } from 'square';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Lazy-load `square` (task #692). Only `SquareError` is used as a
// runtime value in this module (for `instanceof` discrimination in
// the helpers). Defer the multi-MB SDK import until the first call
// site actually needs to introspect a thrown error.
const _squareRequire = createRequire(import.meta.url);
let _squareSdk: typeof import('square') | null = null;
function getSquareErrorCtor(): typeof SquareErrorT {
  if (_squareSdk === null) {
    _squareSdk = _squareRequire('square') as typeof import('square');
  }
  return _squareSdk.SquareError;
}
import { createLogger } from '../logger';

const log = createLogger('SquareCustomAttrs');

export const LEAGUE_NAME_KEY = 'league_name';
export const LEAGUE_SEASON_KEY = 'league_season';

// Square requires a $ref-style JSON schema to mark the attribute as a
// free-form string (vs Selection / Number / Boolean / Address). The
// previous host (`developer.squareup.com/schemas/v1/common.json`) is
// rejected today with `BAD_REQUEST: Unsupported schema URI
// encountered: ...`. The currently-accepted host (verified end-to-
// end against a live seller and matching every example in
// `node_modules/square/reference.md` for
// `customAttributeDefinitions.create`) is
// `developer-production-s.squarecdn.com/schemas/v1/common.json`.
// Note the `/schemas/v1/` path segment — the bare `/i/common.json`
// host is rejected with the same "Unsupported schema URI" error.
// The SDK accepts the schema as a free-form `Record<string,
// unknown>` so we pass it raw.
const STRING_SCHEMA = {
  $ref: 'https://developer-production-s.squarecdn.com/schemas/v1/common.json#squareup.common.String',
} as const;

interface DefinitionSpec {
  key: string;
  name: string;
  description: string;
}

const DEFINITIONS: DefinitionSpec[] = [
  {
    key: LEAGUE_NAME_KEY,
    name: 'League Name',
    description:
      'Comma-separated list of leagues this customer is currently in. Updated automatically.',
  },
  {
    key: LEAGUE_SEASON_KEY,
    name: 'League Season',
    description:
      'Comma-separated list of season labels for the leagues this customer is in. Updated automatically.',
  },
];

/**
 * Detects "the definition already exists" responses across the two
 * shapes Square has been observed to return:
 *   - HTTP 409 (`statusCode === 409`) — modern responses
 *   - HTTP 400 with `errors[].code === 'BAD_REQUEST'` and the message
 *     mentioning a duplicate key — older surfaces
 * Both are SUCCESS for our idempotent bootstrap.
 */
/**
 * Returns true when Square's CONFLICT response specifically blames
 * the `name` field — i.e. a *different* key on the seller already
 * uses our requested display name. Distinct from a key collision
 * (which is the desired idempotent outcome). Triggers our recovery:
 * retry the create with a LeagueVault-prefixed name.
 *
 * Observed shape (2026-05-09, prod org 3 / location 1, Farmington):
 *   statusCode=409, code=CONFLICT,
 *   detail="A custom attribute definition with the specified `name`
 *           already exists; name=League Name"
 */
function isNameCollisionError(err: unknown): boolean {
  if (!(err instanceof getSquareErrorCtor())) return false;
  const errors = err.errors;
  if (!errors?.length) return false;
  return errors.some((e) => {
    const code = (e.code ?? '').toUpperCase();
    const detail = (e.detail ?? '').toLowerCase();
    if (code !== 'CONFLICT' && code !== 'ALREADY_EXISTS') return false;
    return /specified .?name.? already exists|name.*already (exists|in use|defined)/.test(
      detail,
    );
  });
}

export function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof getSquareErrorCtor())) return false;
  if (err.statusCode === 409) return true;
  // v40+ flat-client SDK exposes structured errors directly on the
  // SquareError instance; the legacy `.result.errors[]` wrapper is
  // gone. Same `category` / `code` / `detail` / `field` fields.
  const errors = err.errors;
  if (!errors?.length) return false;
  return errors.some((e) => {
    const code = (e.code ?? '').toUpperCase();
    if (code === 'CONFLICT' || code === 'ALREADY_EXISTS') return true;
    const detail = (e.detail ?? '').toLowerCase();
    return code === 'BAD_REQUEST' && /already (exists|in use|defined)|duplicate/.test(detail);
  });
}

/**
 * Structural minimum of `SquareClient` that the definition bootstrap
 * exercises. Declared as its own interface so tests can pass a
 * hand-rolled fake without needing to launder a partial through
 * `as unknown as SquareClient` (which the repo lint config bans). The
 * real `SquareClient` is structurally compatible with this type, so
 * production callers pass it unchanged.
 */
interface ListedDefinition {
  key?: string | null;
}

interface ListedDefinitionsPage {
  data?: ListedDefinition[];
  [Symbol.asyncIterator]?: () => AsyncIterator<ListedDefinition>;
}

export interface SquareCustomAttrDefinitionsClient {
  customers: {
    customAttributeDefinitions: {
      // Square's SDK returns a paginated async iterable. The optional
      // shape keeps small test doubles and older callers compatible;
      // production's Square client always provides this method.
      list?: (input?: { limit?: number | null; cursor?: string | null }) =>
        Promise<ListedDefinitionsPage>;
      create(input: {
        customAttributeDefinition: {
          key: string;
          name: string;
          description?: string;
          // Narrow to the literal union Square's SDK exposes so the
          // real `SquareClient` is structurally assignable to this
          // interface (function parameters are contravariant — a
          // looser `string` here would reject the SDK signature).
          visibility?: 'VISIBILITY_HIDDEN' | 'VISIBILITY_READ_ONLY' | 'VISIBILITY_READ_WRITE_VALUES';
          schema?: Record<string, unknown> | null;
        };
        idempotencyKey?: string;
      }): Promise<unknown>;
      // Used by the repair path (task: stale-broken-definition recovery).
      // Square only requires the key to delete; the SDK's exact response
      // shape is irrelevant to us — the call either succeeds, throws
      // NOT_FOUND (idempotent miss, treated as success), or throws hard.
      delete(input: { key: string }): Promise<unknown>;
    };
  };
}

async function listExistingDefinitionKeys(
  client: SquareCustomAttrDefinitionsClient,
): Promise<Set<string> | null> {
  const list = client.customers.customAttributeDefinitions.list;
  if (!list) return null;

  try {
    const page = await list({});
    const keys = new Set<string>();
    const asyncIterator = page[Symbol.asyncIterator];

    if (asyncIterator) {
      const iterator = asyncIterator.call(page);
      for (;;) {
        const result = await iterator.next();
        if (result.done) break;
        if (result.value.key) keys.add(result.value.key);
      }
    } else {
      for (const definition of page.data ?? []) {
        if (definition.key) keys.add(definition.key);
      }
    }

    return keys;
  } catch (err) {
    // Listing is an optimization and a way to keep normal startup logs
    // clean. Preserve the create + 409 fallback if the read is not
    // available during a transient Square/API-permission problem.
    log.warn('Could not preflight Square customer custom-attribute definitions; falling back to create', {
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return null;
  }
}

async function createDefinition(
  client: SquareCustomAttrDefinitionsClient,
  spec: DefinitionSpec,
  idempotencyKeyOverride?: string,
  nameOverride?: string,
): Promise<'created' | 'exists' | 'failed'> {
  const effectiveName = nameOverride ?? spec.name;
  try {
    // v40+ flat-client SDK nests the customer custom attribute
    // definition resource under `customers.customAttributeDefinitions`.
    await client.customers.customAttributeDefinitions.create({
      customAttributeDefinition: {
        key: spec.key,
        name: effectiveName,
        description: spec.description,
        visibility: 'VISIBILITY_READ_ONLY',
        schema: STRING_SCHEMA as unknown as Record<string, unknown>,
      },
      // Idempotency-key shape: re-running the create with the same key
      // is exactly what the "already exists" branch was designed for.
      //
      // Bumped v1 → v2 (2026-05-09) because Square's server-side
      // idempotency cache for the v1 keys had gone stale — `create`
      // calls were returning the original months-ago response (a mix
      // of "created" and "ALREADY_EXISTS") without checking the actual
      // seller state, so bootstrap always thought the definitions were
      // there even when the seller had nothing. Subsequent upserts kept
      // failing `definition_missing`. The v2 suffix forces Square to
      // re-execute the create, which then either returns 'created' (if
      // truly missing) or a real ALREADY_EXISTS (if truly present) —
      // both of which the `'exists'` branch handles correctly.
      //
      // Repair callers MUST pass `idempotencyKeyOverride` — see
      // `repairDefinition` for the rationale.
      idempotencyKey: idempotencyKeyOverride ?? `leaguevault-${spec.key}-def-v2`,
    });
    log.info('Created Square customer custom attribute definition', {
      key: spec.key,
      name: effectiveName,
    });
    return 'created';
  } catch (err) {
    // Name-collision recovery: when a *different* key on the seller
    // already owns our requested display name (e.g. an org's Square
    // dashboard manually created a "League Name" attribute under a
    // `square:<uuid>` key), Square rejects our create with HTTP 409
    // CONFLICT blaming `name`. The key itself is still free, so retry
    // once with a LeagueVault-prefixed name to escape the collision.
    // Without this, the entire org's bowler payment-customer sync gets
    // wedged on `definition_missing` upserts forever.
    if (!nameOverride && isNameCollisionError(err)) {
      const fallbackName = `${spec.name} (LeagueVault)`;
      // CRITICAL: the fallback create MUST carry its own idempotency
      // key. Reusing the original would let Square replay the 409
      // name-collision response (the very failure mode that wedged
      // bowlers in the first place) and we'd never actually attempt
      // the fallback name. Length-bounded ≤45 chars per Square's
      // idempotency-key spec.
      const fallbackIdempotencyKey = `lv-${spec.key}-fb-${Date.now().toString(36)}`.slice(
        0,
        45,
      );
      log.info('createDefinition: name collision — retrying with prefixed name', {
        key: spec.key,
        attemptedName: effectiveName,
        fallbackName,
        fallbackIdempotencyKey,
      });
      return createDefinition(client, spec, fallbackIdempotencyKey, fallbackName);
    }
    if (nameOverride && isAlreadyExistsError(err)) {
      // Fallback-name path: a 409 here is ONLY safe to treat as
      // success when it's a *key* collision (= our key already exists
      // on the seller, which is exactly the idempotent-success state
      // we wanted). A *name* collision in the fallback path means
      // even our prefixed name was somehow taken — surface as failure
      // rather than silently returning 'exists' and re-wedging the
      // sync queue (architect review, 2026-05-09).
      if (isNameCollisionError(err)) {
        log.warn('createDefinition: fallback name also collided — refusing to mark as exists', {
          key: spec.key,
          fallbackName: effectiveName,
          error: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
        return 'failed';
      }
      log.info('createDefinition: fallback create — Square reported key already exists', {
        key: spec.key,
        name: effectiveName,
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return 'exists';
    }
    if (isAlreadyExistsError(err)) {
      // One-line diagnostic so the prod log captures Square's *actual*
      // ALREADY_EXISTS shape — needed to disambiguate (a) cached
      // idempotency response, (b) genuine pre-existing key, and
      // (c) name-collision against a different key (e.g. seller
      // already has `square:<uuid>` with our `name`).
      log.info('createDefinition: Square reported already-exists', {
        key: spec.key,
        name: effectiveName,
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return 'exists';
    }
    log.warn('Failed to create Square custom attribute definition', {
      key: spec.key,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return 'failed';
  }
}

/**
 * Creates both `league_name` and `league_season` definitions on the
 * Square seller account behind `client`. Idempotent: safe to call on
 * every cold start AND lazily before each customer attribute upsert.
 *
 * Returns true when both definitions are known to exist (created or
 * pre-existing). Returns false on hard API failure — the caller must
 * treat false as NON-FATAL and continue with the customer write.
 */
export async function ensureDefinitions(
  client: SquareCustomAttrDefinitionsClient,
): Promise<boolean> {
  const existingKeys = await listExistingDefinitionKeys(client);
  let allOk = true;
  for (const spec of DEFINITIONS) {
    if (existingKeys?.has(spec.key)) {
      log.info('Square customer custom attribute definition already exists', {
        key: spec.key,
      });
      continue;
    }
    const status = await createDefinition(client, spec);
    if (status === 'failed') allOk = false;
  }
  return allOk;
}

/**
 * Deletes a customer custom-attribute definition from the seller. Used
 * by the repair path when the upsert keeps reporting `definition_missing`
 * for a key that `createDefinition` claims already exists — the only
 * consistent explanation is a stale/broken definition (e.g. one created
 * with the now-rejected `developer.squareup.com/...` schema URI). Square
 * silently keeps the orphan record by name, blocks recreate with
 * "already exists", and rejects upserts against it. The fix is to
 * delete-and-recreate.
 *
 * NOT_FOUND is treated as success so the helper is idempotent — a
 * second caller in a race can still progress to recreate.
 *
 * Returns true on success (including idempotent NOT_FOUND), false on
 * any other API failure. Callers should treat false as NON-FATAL.
 */
async function deleteDefinition(
  client: SquareCustomAttrDefinitionsClient,
  key: string,
): Promise<boolean> {
  try {
    await client.customers.customAttributeDefinitions.delete({ key });
    log.info('Deleted Square customer custom attribute definition', { key });
    return true;
  } catch (err) {
    if (err instanceof getSquareErrorCtor() && err.statusCode === 404) {
      log.info('Square customer custom attribute definition already absent', { key });
      return true;
    }
    log.warn('Failed to delete Square custom attribute definition', {
      key,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return false;
  }
}

/**
 * Repair a single broken/stale customer custom-attribute definition
 * by deleting and recreating it. Returns true when the definition is
 * known-good after the repair (created fresh, or already-exists after
 * the delete failed but Square's `create` still returned a usable
 * record), false on hard failure.
 *
 * Used by:
 *   - `scripts/repair-square-customer-attr-definitions.ts` (one-shot
 *     operator cleanup),
 *   - `SquarePaymentProvider.syncCustomerLeagueAttributes`'s last-
 *     ditch self-heal when bust-cache + re-bootstrap still leaves the
 *     upsert reporting `definition_missing`.
 */
export async function repairDefinition(
  client: SquareCustomAttrDefinitionsClient,
  key: string,
): Promise<boolean> {
  const spec = DEFINITIONS.find((d) => d.key === key);
  if (!spec) {
    log.warn('repairDefinition called with unknown key — refusing', { key });
    return false;
  }
  // Delete is best-effort; if it fails for a non-404 reason we still
  // try the create — Square may surface ALREADY_EXISTS, in which case
  // the upsert still won't work and we surface false to the caller.
  await deleteDefinition(client, key);
  // Square's delete is async on the seller side — empirically the
  // immediate next create against the same key returns ALREADY_EXISTS
  // for ~1s after a successful delete. Sleep briefly so the recreate
  // actually lands a fresh definition instead of bouncing.
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  // Use a fresh idempotency key so Square doesn't dedupe against the
  // cached success of the original (now-deleted) v1 create. With the
  // baked-in v1 key, Square returns the cached 200 without re-running
  // the create against the empty seller — we logged "exists" but the
  // definition stayed gone, and every subsequent upsert kept failing
  // with `definition_missing`.
  // Square caps idempotency_key at 45 chars, so use a compact form:
  // `lv-<key>-r-<base36(now)>` — e.g. `lv-league_season-r-lzx8f9k` (~27).
  const freshKey = `lv-${spec.key}-r-${Date.now().toString(36)}`;
  const status = await createDefinition(client, spec, freshKey);
  return status === 'created' || status === 'exists';
}

/**
 * Repair both LEAGUE_* definitions (delete + recreate). Returns the
 * per-key success map so operators (and the in-process self-heal) can
 * tell which key the failure was on.
 */
export async function repairAllDefinitions(
  client: SquareCustomAttrDefinitionsClient,
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const spec of DEFINITIONS) {
    result[spec.key] = await repairDefinition(client, spec.key);
  }
  return result;
}

/**
 * Detects "the definition for this key does not exist on this seller"
 * responses. Square returns these as HTTP 404 with a `NOT_FOUND` error
 * code whose detail mentions the missing custom-attribute definition.
 * The caller's recovery path is to (re-)bootstrap the definitions and
 * retry the upsert once.
 */
export function isDefinitionMissingError(err: unknown): boolean {
  if (!(err instanceof getSquareErrorCtor())) return false;
  // v40+ flat-client SDK exposes structured errors directly on the
  // SquareError instance (`.errors[]`, `.statusCode`, `.body`); the
  // legacy `.result.errors[]` wrapper is gone.
  const errors = err.errors;
  if (errors?.length) {
    for (const e of errors) {
      const code = (e.code ?? '').toUpperCase();
      const detail = (e.detail ?? '').toLowerCase();
      const field = (e.field ?? '').toLowerCase();
      if (code === 'NOT_FOUND' && /custom[_ ]?attribute|definition/.test(detail)) {
        return true;
      }
      // Square's actual response when a customer custom-attribute
      // upsert references a key with no seller-side definition is
      // HTTP 400 / `BAD_REQUEST` with detail "No matching definition
      // found for value" and field=`key` — NOT a 404. Without this
      // branch the recovery path in
      // `square-provider.syncCustomerLeagueAttributes` (bust cache,
      // re-bootstrap, retry once) never fires when a definition is
      // deleted out-of-band on the seller account, leaving every
      // bowler in that org stuck in the payment-sync retry queue.
      if (
        code === 'BAD_REQUEST' &&
        field === 'key' &&
        /no matching definition/.test(detail)
      ) {
        return true;
      }
    }
  }
  // Some surfaces return a bare 404 without per-error detail. Treat a
  // 404 on the upsert path as definition-missing too — the customer
  // record was already verified by the caller before we got here.
  return err.statusCode === 404;
}

export type UpsertAttributeResult =
  | { ok: true }
  | { ok: false; reason: 'definition_missing' | 'other' };

/**
 * Upserts a single string custom attribute on a Square customer.
 *
 * On failure, returns a discriminated result so the caller can
 * distinguish "definition was deleted out-of-band" (recoverable via
 * bootstrap + retry) from any other error (flag the bowler for the
 * background retry sweep).
 */
export async function upsertCustomerStringAttribute(
  client: SquareClient,
  customerId: string,
  key: string,
  value: string,
  bowlerId: number | string,
): Promise<UpsertAttributeResult> {
  try {
    // Idempotency key includes a short hash of the payload so:
    //   - A true retry of the SAME write (transient network error,
    //     duplicate fire from two routes) reuses the same key and
    //     Square correctly dedupes inside its idempotency window.
    //   - A REAL update (league rename, season change, bowler joins
    //     a new league) gets a fresh key and is not blocked by a
    //     previous-payload entry that Square would otherwise either
    //     dedupe-with-stale-result or reject as a conflict.
    // Square's idempotency-key limit is 45 chars; a 12-hex-char SHA-
    // 1 prefix gives 2^48 collision space per (bowler,key) which is
    // far beyond anything we'd hit in practice. Shape preserved across
    // the v40 SDK upgrade so post-deploy retries dedupe against any
    // pre-upgrade upsert still in flight on Square's side.
    const valueHash = createHash('sha1').update(value).digest('hex').slice(0, 12);
    // v40+ flat-client SDK nests the customer custom attribute resource
    // under `customers.customAttributes` and folds (customerId, key)
    // into the request body itself.
    await client.customers.customAttributes.upsert({
      customerId,
      key,
      customAttribute: {
        value,
      },
      idempotencyKey: `lv-${bowlerId}-${key}-${valueHash}`,
    });
    return { ok: true };
  } catch (err) {
    const definitionMissing = isDefinitionMissingError(err);
    log.warn('Failed to upsert customer custom attribute', {
      customerId,
      key,
      bowlerId,
      definitionMissing,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return { ok: false, reason: definitionMissing ? 'definition_missing' : 'other' };
  }
}
