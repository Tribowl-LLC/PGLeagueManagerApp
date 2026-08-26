/**
 * Regression pin for tasks #511 and #514.
 *
 * `client/src/lib/square.ts` was rewritten twice to stop throwing
 * `Error(JSON.stringify(...))` from `createSquareCustomer`. Without this
 * spec, a well-meaning refactor
 * could re-introduce the JSON-stringified message and the user-visible
 * toast would silently regress to `{"error":{"message":...}}`.
 *
 * Each entry point is tested for the same four shapes of provider
 * response so the public contract — `.message` is a clean human
 * sentence, `.code` is structured, `.status` is the HTTP status — is
 * locked in:
 *   (a) successful response                       → resolves
 *   (b) structured `{ error: { message, code } }` → all three fields populated
 *   (c) plain-text body (HTML, gateway error)    → `.message` falls back to text, never JSON
 *   (d) `PROVIDER_NOT_CONFIGURED`                 → code/status/message survive the outer catch
 *
 * `csrfFetch` is mocked so these tests never touch the backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { csrfFetchMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
}));

vi.mock('@/lib/queryClient', () => ({
  csrfFetch: csrfFetchMock,
}));

import { createSquareCustomer, tokenizeCard } from '@/lib/square';
import { PROVIDER_NOT_CONFIGURED } from '@/lib/provider-not-configured';
import type { SquareCard } from '@/hooks/use-square-payment';

interface FakeResponseInit {
  ok: boolean;
  status: number;
  jsonBody?: unknown;
  textBody?: string;
}

/**
 * Mimic just enough of `Response` for `square.ts`: it calls
 * `.clone().json()` first and, if that throws, falls back to
 * `.text()`. The fake's `clone()` returns the same object so
 * subsequent reads on the original (or its clone) keep working.
 */
function fakeResponse({ ok, status, jsonBody, textBody }: FakeResponseInit) {
  const resp: {
    ok: boolean;
    status: number;
    clone: () => typeof resp;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  } = {
    ok,
    status,
    clone() {
      return resp;
    },
    async json() {
      if (jsonBody === undefined) {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }
      return jsonBody;
    },
    async text() {
      if (textBody !== undefined) return textBody;
      if (jsonBody !== undefined) return JSON.stringify(jsonBody);
      return '';
    },
  };
  return resp;
}

// Hold a separately-typed handle to the mock so the beforeEach reset
// doesn't need to re-cast `okTokenizeCard`.
const okTokenize = vi.fn().mockResolvedValue({ status: 'OK', token: 'tok_abc123' });
const okTokenizeCard: SquareCard = {
  tokenize: okTokenize,
  destroy: vi.fn(),
  attach: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  csrfFetchMock.mockReset();
  // The card is reused across tests; reset its tokenize stub each time
  // so call counts and resolved values can't leak between specs.
  okTokenize.mockReset().mockResolvedValue({ status: 'OK', token: 'tok_abc123' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createSquareCustomer error contract (tasks #511 / #514)', () => {
  it('(a) resolves with the customer on a successful response', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        jsonBody: { id: 'cust_42', name: 'Jane Bowler', email: 'jane@example.com' },
      }),
    );

    const customer = await createSquareCustomer('Jane Bowler', 'jane@example.com', 7);

    expect(customer).toEqual({
      id: 'cust_42',
      name: 'Jane Bowler',
      email: 'jane@example.com',
    });
  });

  it('(b) populates .message, .code, and .status from a structured error body', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: false,
        status: 409,
        jsonBody: {
          error: {
            message: 'A customer with this email already exists.',
            code: 'CUSTOMER_EXISTS',
          },
        },
      }),
    );

    const err = await createSquareCustomer('Jane Bowler', 'jane@example.com', 7)
      .then(
        () => {
          throw new Error('helper unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string; status?: number },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('A customer with this email already exists.');
    expect(err.code).toBe('CUSTOMER_EXISTS');
    expect(err.status).toBe(409);
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/"error"/);
    // The structured-body path must not prefix the message with "Failed
    // to create Square
    // customer:" either.
    expect(err.message).not.toMatch(/^Failed to create Square customer:/);
  });

  it('(c) falls back to plain-text body for non-JSON responses', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: false,
        status: 500,
        textBody: 'Internal Server Error',
      }),
    );

    const err = await createSquareCustomer('Jane Bowler', 'jane@example.com', 7)
      .then(
        () => {
          throw new Error('helper unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string; status?: number },
      );

    expect(err).toBeInstanceOf(Error);
    // Plain-text upstream errors preserve `.message` as the
    // upstream text verbatim (no "Failed to create Square customer: "
    // prefix), `.status` matches the HTTP status, and `.code` defaults
    // to `CUSTOMER_CREATION_FAILED`.
    // callers can branch on it.
    expect(err.message).toBe('Internal Server Error');
    expect(err.code).toBe('CUSTOMER_CREATION_FAILED');
    expect(err.status).toBe(500);
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/"error"/);
    expect(err.message).not.toMatch(/^Failed to create Square customer:/);
  });

  it('(d) preserves PROVIDER_NOT_CONFIGURED end-to-end through the outer catch', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: false,
        status: 422,
        jsonBody: {
          error: {
            message: "Square isn't connected for this location.",
            code: PROVIDER_NOT_CONFIGURED,
          },
        },
      }),
    );

    const err = await createSquareCustomer('Jane Bowler', 'jane@example.com', 7)
      .then(
        () => {
          throw new Error('helper unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string; status?: number },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(PROVIDER_NOT_CONFIGURED);
    expect(err.status).toBe(422);
    expect(err.message).toBe("Square isn't connected for this location.");
    // The outer catch must NOT have wrapped this into a generic
    // "Failed to create Square customer: ..." string, otherwise
    // callers like `providerNotConfiguredToast` lose their signal.
    expect(err.message).not.toMatch(/^Failed to create Square customer:/);
    expect(err.message).not.toMatch(/[{}]/);
  });
});

describe('tokenizeCard error contract (task #546)', () => {
  // tokenizeCard never touches the network — it just calls
  // `cardInstance.tokenize()` and translates the result. Each spec
  // builds the smallest possible mock card surface needed for the
  // case under test; `destroy`/`attach` are stubbed only because
  // `SquareCard` requires them structurally.
  function makeCard(tokenize: SquareCard['tokenize']): SquareCard {
    return {
      tokenize,
      destroy: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('(a) throws INITIALIZATION_ERROR with a friendly message when no card is supplied', async () => {
    const err = await tokenizeCard(null)
      .then(
        () => {
          throw new Error('tokenizeCard unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('INITIALIZATION_ERROR');
    expect(err.message).toBe('Card element not initialized');
    // Friendly-message invariants — no JSON soup, no SDK jargon.
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/Square API Error/i);
  });

  it('(b) throws TOKENIZATION_ERROR with a friendly message when tokenize returns status !== "OK"', async () => {
    const card = makeCard(
      vi.fn().mockResolvedValue({
        status: 'ERROR',
        // A realistic SDK shape for a declined / invalid card.
        errors: [{ message: 'Card was declined by the issuer.' }],
      }),
    );

    const err = await tokenizeCard(card)
      .then(
        () => {
          throw new Error('tokenizeCard unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('TOKENIZATION_ERROR');
    expect(err.message).toBe('Please check your card details and try again.');
    // The upstream SDK error array must NOT leak into the user-visible
    // message — the whole point of the static fallback.
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/"errors"/);
    expect(err.message).not.toMatch(/Square API Error/i);
  });

  it('(c) throws TOKENIZATION_ERROR with a friendly message when the SDK call itself rejects', async () => {
    // A typical raw-SDK rejection shape: developer-targeted message
    // with `Square API Error:` prefix and a JSON-ish payload. None of
    // this should reach the user-visible toast.
    const card = makeCard(
      vi.fn().mockRejectedValue(
        new Error(
          'Square API Error: {"error":{"code":"NETWORK_TIMEOUT","detail":"location_id=LY5C3TE48WEXX"}}',
        ),
      ),
    );

    const err = await tokenizeCard(card)
      .then(
        () => {
          throw new Error('tokenizeCard unexpectedly resolved instead of rejecting');
        },
        (e: unknown) => e as Error & { code?: string },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('TOKENIZATION_ERROR');
    expect(err.message).toBe('Please check your card details and try again.');
    // The whole point: the SDK's developer-jargon message must be
    // collapsed into the static friendly sentence — no JSON, no
    // Square-specific phrasing, no internal location id.
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/Square API Error/i);
    expect(err.message).not.toMatch(/location_id/);
    expect(err.message).not.toMatch(/LY5C3TE48WEXX/);
  });

  it('(d) returns the token string on a successful tokenize', async () => {
    const card = makeCard(
      vi.fn().mockResolvedValue({ status: 'OK', token: 'tok_success_42' }),
    );

    const token = await tokenizeCard(card);

    expect(token).toBe('tok_success_42');
  });
});
