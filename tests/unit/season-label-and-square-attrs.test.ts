/**
 * Unit tests for the two pure helpers introduced by task #429:
 *
 *   1. `getSeasonLabel` (`shared/season-utils.ts`) — moved from the
 *      client into shared so the server-side Square custom-attribute
 *      sync produces the EXACT same string users see in-app. These
 *      tests pin the season-boundary cases (Nov–Feb → Winter,
 *      Mar–Apr → Spring, etc.) and cross-year labeling.
 *
 *   2. `isAlreadyExistsError` (`server/services/square-custom-
 *      attributes.ts`) — the duplicate-definition detector that
 *      makes `ensureDefinitions` idempotent. Both observed Square
 *      response shapes (modern HTTP 409 and legacy 400+detail) MUST
 *      be classified as success, otherwise every cold start would
 *      log a spurious bootstrap failure.
 *
 * Both helpers are stateless and dependency-free, so this file does
 * not need any storage / Express / Square mocks.
 */
import { describe, expect, it } from 'vitest';
import { SquareError } from 'square';
import { getSeasonLabel } from '../../shared/season-utils';
import {
  isAlreadyExistsError,
  isDefinitionMissingError,
  ensureDefinitions,
  type SquareCustomAttrDefinitionsClient,
} from '../../server/services/square-custom-attributes';

describe('getSeasonLabel', () => {
  it('labels a December start as Winter (current year suffix)', () => {
    expect(getSeasonLabel('2025-12-01', '2025-12-31')).toBe("Winter '25 Season");
  });

  it('labels a January start as Winter', () => {
    expect(getSeasonLabel('2025-01-15', '2025-04-01')).toBe("Winter '25 Season");
  });

  it('labels a February start as Winter', () => {
    expect(getSeasonLabel('2025-02-01', '2025-05-01')).toBe("Winter '25 Season");
  });

  it('labels a March start as Spring', () => {
    expect(getSeasonLabel('2025-03-10', '2025-06-10')).toBe("Spring '25 Season");
  });

  it('labels an April start as Spring', () => {
    expect(getSeasonLabel('2025-04-30', '2025-07-31')).toBe("Spring '25 Season");
  });

  it('labels a May start as Summer', () => {
    expect(getSeasonLabel('2025-05-31', '2025-08-31')).toBe("Summer '25 Season");
  });

  it('labels a June start as Summer', () => {
    expect(getSeasonLabel('2025-06-01', '2025-09-01')).toBe("Summer '25 Season");
  });

  it('labels a July start as Summer', () => {
    expect(getSeasonLabel('2025-07-31', '2025-10-31')).toBe("Summer '25 Season");
  });

  it('labels an August start as Fall', () => {
    expect(getSeasonLabel('2025-08-15', '2025-11-15')).toBe("Fall '25 Season");
  });

  it('labels a September start as Fall', () => {
    expect(getSeasonLabel('2025-09-01', '2025-12-01')).toBe("Fall '25 Season");
  });

  it('labels an October start as Fall', () => {
    expect(getSeasonLabel('2025-10-31', '2026-02-15')).toBe("Fall '25 Season");
  });

  it('labels a November start as Winter', () => {
    expect(getSeasonLabel('2025-11-01', '2026-03-15')).toBe("Winter '25 Season");
  });

  it('uses the starting month label when the season spans calendar years', () => {
    expect(getSeasonLabel('2025-09-01', '2026-04-30')).toBe("Fall '25 Season");
  });

  it('accepts Date objects as well as ISO strings', () => {
    // Both the client (form data, ISO strings) and the server (DB
    // rows, Date objects) call this — pinning both call shapes here
    // protects the server side from accidentally regressing.
    expect(getSeasonLabel(new Date('2025-09-01'), new Date('2025-12-01'))).toBe(
      "Fall '25 Season",
    );
  });
});

describe('isAlreadyExistsError', () => {
  it('returns false for null/undefined', () => {
    expect(isAlreadyExistsError(undefined)).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(isAlreadyExistsError(new Error('network exploded'))).toBe(false);
  });

  it('classifies HTTP 409 as already-exists', () => {
    // Modern Square shape: bare statusCode on the SquareError. This
    // is the path the v44+ SDK takes today; pinning it makes sure a
    // future SDK upgrade that drops the legacy 400+detail shape still
    // keeps cold-start bootstrap idempotent.
    expect(isAlreadyExistsError(new SquareError({ statusCode: 409 }))).toBe(true);
  });

  it('classifies an errors[].code === CONFLICT as already-exists', () => {
    // v44 flat-client shape: structured errors live directly on the
    // SquareError (no `.result.errors` wrapper). Constructed here by
    // passing `body: { errors: [...] }` to the SquareError ctor —
    // see node_modules/square/errors/SquareError.js.
    expect(
      isAlreadyExistsError(
        new SquareError({
          statusCode: 400,
          body: { errors: [{ code: 'CONFLICT', detail: 'definition exists' }] },
        }),
      ),
    ).toBe(true);
  });

  it('classifies an errors[].code === ALREADY_EXISTS as already-exists', () => {
    expect(
      isAlreadyExistsError(
        new SquareError({
          statusCode: 400,
          body: { errors: [{ code: 'ALREADY_EXISTS' }] },
        }),
      ),
    ).toBe(true);
  });

  it('classifies BAD_REQUEST + duplicate-key detail as already-exists', () => {
    // Legacy Square response shape: HTTP 400 with a free-form detail
    // string mentioning duplication. We must treat this as success or
    // every cold start logs a bogus bootstrap failure for sellers
    // whose definitions were created before the SDK was upgraded.
    expect(
      isAlreadyExistsError(
        new SquareError({
          statusCode: 400,
          body: {
            errors: [
              {
                code: 'BAD_REQUEST',
                detail: 'A custom attribute definition with that key already exists.',
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it('does NOT classify a generic BAD_REQUEST as already-exists', () => {
    // Important regression pin: a real validation failure (bad
    // schema, missing field) returns BAD_REQUEST too. We must NOT
    // swallow it as success — that would mask a true bootstrap bug.
    expect(
      isAlreadyExistsError(
        new SquareError({
          statusCode: 400,
          body: {
            errors: [{ code: 'BAD_REQUEST', detail: 'Schema is invalid: missing $ref.' }],
          },
        }),
      ),
    ).toBe(false);
  });

  it('does NOT classify an empty errors array as already-exists', () => {
    expect(
      isAlreadyExistsError(new SquareError({ statusCode: 400, body: { errors: [] } })),
    ).toBe(false);
  });
});

describe('isDefinitionMissingError (task #680)', () => {
  it('returns false for non-SquareError values', () => {
    expect(isDefinitionMissingError(undefined)).toBe(false);
    expect(isDefinitionMissingError(null)).toBe(false);
    expect(isDefinitionMissingError(new Error('boom'))).toBe(false);
  });

  it('classifies HTTP 404 as definition-missing', () => {
    expect(isDefinitionMissingError(new SquareError({ statusCode: 404 }))).toBe(true);
  });

  it('classifies a NOT_FOUND errors[].code with definition-related detail as definition-missing', () => {
    expect(
      isDefinitionMissingError(
        new SquareError({
          statusCode: 404,
          body: {
            errors: [
              { code: 'NOT_FOUND', detail: 'Custom attribute definition not found.' },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it("classifies Square's BAD_REQUEST `No matching definition found for value` shape (production-log fixture)", () => {
    // Pinned from the production log shape that left three bowlers in
    // org 3 stuck for nearly a day (task #680). HTTP 400 / BAD_REQUEST,
    // detail mentions "No matching definition found for value", and
    // field is `key`. Without recognising this shape, the bust-cache /
    // re-bootstrap / retry path in `syncCustomerLeagueAttributes`
    // never fires when a definition is deleted out-of-band.
    expect(
      isDefinitionMissingError(
        new SquareError({
          statusCode: 400,
          body: {
            errors: [
              {
                code: 'BAD_REQUEST',
                detail: 'No matching definition found for value',
                field: 'key',
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it('does NOT classify an unrelated BAD_REQUEST as definition-missing', () => {
    // Sanity check: a generic validation error (e.g. invalid value
    // type) must NOT be treated as definition-missing — that would
    // trigger pointless re-bootstraps for unrelated failures.
    expect(
      isDefinitionMissingError(
        new SquareError({
          statusCode: 400,
          body: {
            errors: [
              { code: 'BAD_REQUEST', detail: 'Value must be a string.', field: 'value' },
            ],
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('ensureDefinitions schema shape (task #680)', () => {
  // Pin the JSON schema we send to Square's
  // `customAttributeDefinitions.create`. The previous URI host
  // (`developer.squareup.com/schemas/v1/common.json`) was rejected by
  // Square with `BAD_REQUEST: Unsupported schema URI encountered: ...`
  // so a schema regression here would silently break smart-list
  // attribute writes for every Square seller.
  it('sends the squarecdn.com $ref shape that Square currently accepts', async () => {
    const captured: Array<Record<string, unknown>> = [];
    // ensureDefinitions accepts a structural minimum
    // (`SquareCustomAttrDefinitionsClient`) declared alongside the
    // helper, so this test fake satisfies the parameter type directly
    // — no `as unknown as SquareClient` laundering required.
    const fakeClient: SquareCustomAttrDefinitionsClient = {
      customers: {
        customAttributeDefinitions: {
          async create(input) {
            captured.push(
              input.customAttributeDefinition.schema as Record<string, unknown>,
            );
            return { customAttributeDefinition: { key: 'k' } };
          },
          // Test fake satisfies the structural minimum even though this
          // test only exercises `create`. The real provider also calls
          // `delete` from the repair path (deleteDefinition / repairDefinition).
          async delete(_input) {
            return { success: true };
          },
        },
      },
    };

    const ok = await ensureDefinitions(fakeClient);

    expect(ok).toBe(true);
    // Two definitions get created (league_name + league_season); both
    // must carry the same string-schema $ref.
    expect(captured).toHaveLength(2);
    for (const schema of captured) {
      expect(schema).toEqual({
        $ref: 'https://developer-production-s.squarecdn.com/schemas/v1/common.json#squareup.common.String',
      });
    }
  });
});

describe('createDefinition name-collision recovery (architect review, 2026-05-09)', () => {
  // These tests pin the recovery contract for the production wedge
  // where Square's seller had a manually-created `square:<uuid>` def
  // with name="League Name", causing our `league_name` create to 409
  // with `specified \`name\` already exists`. The fallback retry MUST:
  //   (a) use a fresh idempotency key (otherwise Square replays the
  //       cached 409 and we never actually try the fallback name);
  //   (b) treat a 409 in the fallback path as success ONLY when it's
  //       a key collision — a *name* collision in the fallback must
  //       surface as failure rather than silently re-wedging sync.

  // Build the precise SquareError shape `isNameCollisionError` matches.
  function makeNameCollisionError(field = 'name'): SquareError {
    return new SquareError({
      statusCode: 409,
      body: {
        errors: [
          {
            category: 'INVALID_REQUEST_ERROR',
            code: 'CONFLICT',
            field,
            detail: `A custom attribute definition with the specified \`${field}\` already exists; ${field}=League Name`,
          },
        ],
      },
    });
  }

  // A non-name 409 — same status, but the detail does not match the
  // name-collision regex. The fallback path should treat this as a
  // benign key-already-exists.
  function makeKeyCollisionError(): SquareError {
    return new SquareError({
      statusCode: 409,
      body: {
        errors: [
          {
            category: 'INVALID_REQUEST_ERROR',
            code: 'CONFLICT',
            field: 'key',
            detail: 'A custom attribute definition with the specified `key` already exists.',
          },
        ],
      },
    });
  }

  it('uses a FRESH idempotency key on the fallback create (no replay of the original 409)', async () => {
    type CreateInput = Parameters<
      SquareCustomAttrDefinitionsClient['customers']['customAttributeDefinitions']['create']
    >[0];
    const captured: CreateInput[] = [];
    let call = 0;
    const fakeClient: SquareCustomAttrDefinitionsClient = {
      customers: {
        customAttributeDefinitions: {
          async create(input) {
            captured.push(input);
            call++;
            if (call === 1) {
              // First create (original "League Name") → name collision.
              throw makeNameCollisionError();
            }
            // Second create (prefixed "League Name (LeagueVault)") → success.
            return { customAttributeDefinition: { key: 'league_name' } };
          },
          async delete(_input) {
            return { success: true };
          },
        },
      },
    };

    const ok = await ensureDefinitions(fakeClient);
    expect(ok).toBe(true);

    // 3 creates total: league_name (fails), league_name fallback (succeeds), league_season (succeeds)
    expect(captured).toHaveLength(3);

    const [first, second, third] = captured;
    expect(first.customAttributeDefinition.key).toBe('league_name');
    expect(first.customAttributeDefinition.name).toBe('League Name');
    expect(first.idempotencyKey).toBe('leaguevault-league_name-def-v2');

    expect(second.customAttributeDefinition.key).toBe('league_name');
    expect(second.customAttributeDefinition.name).toBe('League Name (LeagueVault)');
    // The whole point of this test: the fallback MUST NOT reuse the
    // first create's idempotency key. Otherwise Square would just
    // replay the cached name-collision response and we'd be back
    // in the original wedge.
    expect(second.idempotencyKey).toBeDefined();
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    // Sanity: stays under Square's 45-char idempotency-key cap.
    expect((second.idempotencyKey ?? '').length).toBeLessThanOrEqual(45);

    // The other definition is untouched.
    expect(third.customAttributeDefinition.key).toBe('league_season');
  });

  it('returns failed when the fallback name ALSO collides (does not silently mark as exists)', async () => {
    let call = 0;
    const fakeClient: SquareCustomAttrDefinitionsClient = {
      customers: {
        customAttributeDefinitions: {
          async create(input) {
            call++;
            // league_season succeeds; league_name first AND fallback both name-collide.
            if (input.customAttributeDefinition.key === 'league_season') {
              return { customAttributeDefinition: { key: 'league_season' } };
            }
            throw makeNameCollisionError();
          },
          async delete(_input) {
            return { success: true };
          },
        },
      },
    };

    const ok = await ensureDefinitions(fakeClient);
    // Bootstrap MUST report failure: a double name-collision means
    // even the prefixed name is unusable, so the upsert path will
    // still hit `definition_missing` — we must NOT pretend success.
    expect(ok).toBe(false);
    // Exactly 3 creates: league_name (fails), league_name fallback (fails), league_season (ok).
    expect(call).toBe(3);
  });

  it('returns exists when the fallback create surfaces a non-name 409 (true key collision)', async () => {
    let call = 0;
    const fakeClient: SquareCustomAttrDefinitionsClient = {
      customers: {
        customAttributeDefinitions: {
          async create(input) {
            call++;
            if (input.customAttributeDefinition.key === 'league_season') {
              return { customAttributeDefinition: { key: 'league_season' } };
            }
            // First league_name create → name collision; fallback → key collision (benign).
            if (call === 1) throw makeNameCollisionError();
            throw makeKeyCollisionError();
          },
          async delete(_input) {
            return { success: true };
          },
        },
      },
    };

    const ok = await ensureDefinitions(fakeClient);
    // Both definitions are effectively present on the seller, so
    // bootstrap is a success — the upsert path will work normally.
    expect(ok).toBe(true);
    expect(call).toBe(3);
  });
});
