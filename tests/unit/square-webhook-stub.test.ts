/**
 * Security regression coverage for the deliberately disabled Square webhook.
 * The route must remain observable without accepting events or copying any
 * caller-controlled payload, query, or header value into logs.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const {
  fakeLogger,
  mockStorage,
  mockGetPaymentProvider,
  mockProcessScheduledPayment,
  mockEnqueue,
  downstreamTenantResolver,
} = vi.hoisted(() => ({
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockStorage: {
    createPayment: vi.fn(),
    updatePayment: vi.fn(),
    refundPayment: vi.fn(),
    openDispute: vi.fn(),
    getOrganizationBySubdomain: vi.fn(),
    getOrganizationBySlug: vi.fn(),
  },
  mockGetPaymentProvider: vi.fn(),
  mockProcessScheduledPayment: vi.fn(),
  mockEnqueue: vi.fn(),
  downstreamTenantResolver: vi.fn(),
}));

vi.mock('../../server/logger', () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));
vi.mock('../../server/storage', () => ({ storage: mockStorage }));
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: mockGetPaymentProvider,
}));
vi.mock('../../server/services/payment-lifecycle', () => ({
  processScheduledPaymentJob: mockProcessScheduledPayment,
}));
vi.mock('../../server/services/payment-scheduler', () => ({
  paymentScheduler: { schedulePayment: mockEnqueue },
}));

const {
  registerSquareWebhookTripwire,
  SQUARE_WEBHOOK_REQUEST_ID_HEADER,
  SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES,
  SQUARE_WEBHOOK_TRIPWIRE_PATH,
} = await import('../../server/routes/payments-provider/square-webhook-tripwire');
const { SQUARE_WEBHOOK_TRIPWIRE_MAX_REQUESTS } = await import(
  '../../server/middleware/rate-limit'
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  registerSquareWebhookTripwire(app);

  // Any request that reaches this middleware has escaped the exact tripwire
  // chain and could enter tenant/business routing in the production app.
  app.use((_req, res) => {
    downstreamTenantResolver();
    res.status(204).end();
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(fakeLogger)) fn.mockReset();
  for (const fn of Object.values(mockStorage)) fn.mockReset();
  mockGetPaymentProvider.mockReset();
  mockProcessScheduledPayment.mockReset();
  mockEnqueue.mockReset();
  downstreamTenantResolver.mockReset();
});

interface PostOptions {
  ip: string;
  body?: string;
  query?: string;
  headers?: Record<string, string>;
}

async function postSquare({ ip, body, query = '', headers = {} }: PostOptions) {
  return fetch(`${baseUrl}${SQUARE_WEBHOOK_TRIPWIRE_PATH}${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...headers,
    },
    body,
  });
}

function expectNoSideEffects(): void {
  for (const fn of Object.values(mockStorage)) expect(fn).not.toHaveBeenCalled();
  expect(mockGetPaymentProvider).not.toHaveBeenCalled();
  expect(mockProcessScheduledPayment).not.toHaveBeenCalled();
  expect(mockEnqueue).not.toHaveBeenCalled();
  expect(downstreamTenantResolver).not.toHaveBeenCalled();
}

function serializedObservations(responseText: string): string {
  return JSON.stringify({
    warnCalls: fakeLogger.warn.mock.calls,
    errorCalls: fakeLogger.error.mock.calls,
    responseText,
  });
}

describe('disabled Square webhook tripwire', () => {
  it('returns 501 with a correlated server-generated request id and exact safe metadata', async () => {
    const sentinels = {
      authorization: 'Bearer SENTINEL_AUTHORIZATION_TOKEN',
      cookie: 'session=SENTINEL_COOKIE_VALUE',
      signature: 'SENTINEL_SQUARE_SIGNATURE',
      custom: 'SENTINEL_CUSTOM_HEADER',
      query: 'SENTINEL_QUERY_VALUE',
      nested: 'SENTINEL_NESTED_BODY_TOKEN',
      control: 'SENTINEL_CONTROL\n[ERROR] forged-log-line',
      userAgent: 'SENTINEL_USER_AGENT',
      contentTypeParameter: 'SENTINEL_CONTENT_TYPE_PARAMETER',
    };
    const body = JSON.stringify({
      data: {
        token: sentinels.nested,
        nested: { control: sentinels.control },
      },
    });

    const res = await postSquare({
      ip: '203.0.113.11',
      body,
      query: `?payload=${encodeURIComponent(sentinels.query)}`,
      headers: {
        authorization: sentinels.authorization,
        cookie: sentinels.cookie,
        'x-square-signature': sentinels.signature,
        'x-custom-sensitive': sentinels.custom,
        'user-agent': sentinels.userAgent,
        'content-type': `application/json; profile=${sentinels.contentTypeParameter}`,
      },
    });

    expect(res.status).toBe(501);
    const requestId = res.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER);
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const responseText = await res.text();
    const response = JSON.parse(responseText);
    expect(response).toEqual({
      success: false,
      error: {
        code: 'SQUARE_WEBHOOK_NOT_IMPLEMENTED',
        message: 'Square webhook receiver is not implemented',
      },
    });
    expect(response.success).not.toBe(true);

    expect(fakeLogger.warn).toHaveBeenCalledTimes(1);
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(fakeLogger.warn.mock.calls[0]).toEqual([
      'Disabled Square webhook request rejected',
      {
        event: 'square_webhook_not_implemented',
        requestId,
        method: 'POST',
        path: SQUARE_WEBHOOK_TRIPWIRE_PATH,
        contentType: 'application/json',
        declaredContentLength: Buffer.byteLength(body),
        outcome: 'rejected_not_implemented',
      },
    ]);

    const observed = serializedObservations(responseText);
    for (const sentinel of Object.values(sentinels)) {
      expect(observed).not.toContain(sentinel);
    }
    const metadata = fakeLogger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('headers');
    expect(metadata).not.toHaveProperty('body');
    expect(metadata).not.toHaveProperty('rawBody');
    expect(metadata).not.toHaveProperty('originalUrl');
    expectNoSideEffects();
  });

  it('accepts an under-limit JSON body only to reject the disabled endpoint', async () => {
    const body = JSON.stringify({ payload: 'x'.repeat(512) });
    const res = await postSquare({ ip: '203.0.113.12', body });

    expect(res.status).toBe(501);
    expect(res.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER)).toBeTruthy();
    expect((await res.json()).error.code).toBe('SQUARE_WEBHOOK_NOT_IMPLEMENTED');
    expectNoSideEffects();
  });

  it('rejects an oversized body before the handler without logging its contents', async () => {
    const sentinel = 'SENTINEL_OVERSIZED_BODY_SECRET';
    const body = JSON.stringify({
      payload: sentinel + 'x'.repeat(SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES),
    });
    const res = await postSquare({ ip: '203.0.113.13', body });

    expect(res.status).toBe(413);
    const requestId = res.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER);
    expect(requestId).toBeTruthy();
    const responseText = await res.text();
    expect(JSON.parse(responseText).error).toEqual({
      code: 'SQUARE_WEBHOOK_PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds the allowed size',
    });
    expect(fakeLogger.warn.mock.calls[0]).toEqual([
      'Disabled Square webhook request rejected',
      {
        event: 'square_webhook_not_implemented',
        requestId,
        method: 'POST',
        path: SQUARE_WEBHOOK_TRIPWIRE_PATH,
        contentType: 'application/json',
        declaredContentLength: Buffer.byteLength(body),
        outcome: 'rejected_payload_too_large',
      },
    ]);
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(serializedObservations(responseText)).not.toContain(sentinel);
    expect(responseText).not.toMatch(/entity\.too\.large|stack|SyntaxError/i);
    expectNoSideEffects();
  });

  it('applies the same small limit to non-JSON bodies without logging bytes', async () => {
    const sentinel = 'SENTINEL_NON_JSON_OVERSIZED_BODY';
    const body = sentinel + 'x'.repeat(SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES);
    const res = await postSquare({
      ip: '203.0.113.17',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.status).toBe(413);
    const responseText = await res.text();
    expect(JSON.parse(responseText).error.code).toBe('SQUARE_WEBHOOK_PAYLOAD_TOO_LARGE');
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(serializedObservations(responseText)).not.toContain(sentinel);
    expectNoSideEffects();
  });

  it('contains malformed JSON errors without logging body fragments or parser details', async () => {
    const sentinel = 'SENTINEL_MALFORMED_JSON_TOKEN';
    const body = `{"nested":{"token":"${sentinel}"`;
    const res = await postSquare({ ip: '203.0.113.14', body });

    expect(res.status).toBe(400);
    const requestId = res.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER);
    expect(requestId).toBeTruthy();
    const responseText = await res.text();
    expect(JSON.parse(responseText).error).toEqual({
      code: 'SQUARE_WEBHOOK_INVALID_JSON',
      message: 'Malformed JSON body',
    });
    expect(fakeLogger.warn.mock.calls[0]).toEqual([
      'Disabled Square webhook request rejected',
      {
        event: 'square_webhook_not_implemented',
        requestId,
        method: 'POST',
        path: SQUARE_WEBHOOK_TRIPWIRE_PATH,
        contentType: 'application/json',
        declaredContentLength: Buffer.byteLength(body),
        outcome: 'rejected_invalid_json',
      },
    ]);
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(serializedObservations(responseText)).not.toContain(sentinel);
    expect(responseText).not.toMatch(/Unexpected token|JSON at position|stack/i);
    expectNoSideEffects();
  });

  it('rate-limits only this exact endpoint before parsing or logging a blocked body', async () => {
    const limitedIp = '203.0.113.15';
    for (let i = 0; i < SQUARE_WEBHOOK_TRIPWIRE_MAX_REQUESTS; i += 1) {
      const allowed = await postSquare({
        ip: limitedIp,
        body: JSON.stringify({ probe: i }),
      });
      expect(allowed.status).toBe(501);
    }

    fakeLogger.warn.mockClear();
    const blockedSentinel = 'SENTINEL_RATE_LIMITED_BODY';
    const blocked = await postSquare({
      ip: limitedIp,
      body: `{"secret":"${blockedSentinel}"}`,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER)).toBeTruthy();
    const blockedText = await blocked.text();
    expect(JSON.parse(blockedText).error.code).toBe('RATE_LIMITED');
    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(blockedText).not.toContain(blockedSentinel);

    const separateIdentity = await postSquare({
      ip: '203.0.113.16',
      body: '{}',
    });
    expect(separateIdentity.status).toBe(501);

    const siblingPath = await fetch(`${baseUrl}${SQUARE_WEBHOOK_TRIPWIRE_PATH}/extra`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': limitedIp,
      },
      body: '{}',
    });
    expect(siblingPath.status).toBe(204);
    expect(downstreamTenantResolver).toHaveBeenCalledTimes(1);
  });

  it('is registered before tenant resolution and global raw-body capture', () => {
    const appSource = readFileSync(
      new URL('../../server/app.ts', import.meta.url),
      'utf8',
    );
    const tripwireIndex = appSource.indexOf('registerSquareWebhookTripwire(app);');
    const tenantIndex = appSource.indexOf('app.use(subdomainDetection);');
    const globalJsonIndex = appSource.indexOf("limit: '256kb'");

    expect(tripwireIndex).toBeGreaterThan(-1);
    expect(tripwireIndex).toBeLessThan(tenantIndex);
    expect(tripwireIndex).toBeLessThan(globalJsonIndex);
  });
});
