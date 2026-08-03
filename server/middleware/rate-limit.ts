import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";

// Task #356: every limiter below is backed by the shared Postgres
// store so quotas hold across multiple app processes / replicas.
// Each limiter MUST pass a unique `prefix` to keep its key
// namespace isolated from sibling limiters.

const rateLimitMessage = (msg: string) => ({
  success: false,
  error: { message: msg, code: "RATE_LIMITED" }
});

function userKeyGenerator(req: Request): string {
  return req.user?.id?.toString() || ipKeyGenerator(req.ip ?? 'unknown');
}

/**
 * Test-only bypass for the limiters below.
 *
 * The vitest suite drives the long-running dev server through Replit's
 * HTTPS edge (and on GitHub CI through plain loopback), and in both
 * environments every test request resolves to `req.ip = '127.0.0.1'`.
 * That means a single test file that intentionally fires a burst
 * (e.g. `payments-provider-guards.test.ts`) drains the loopback bucket
 * and starves every later test in the same vitest invocation that
 * touches the same limiter — most visibly the
 * `square-provider-not-configured-422` regression which expects a 422
 * but gets a 429 once the bucket is empty.
 *
 * This bypass is gated on `NODE_ENV !== 'production'` AND the request
 * carrying `X-Test-Rate-Limit-Bypass: 1`. The header value is a fixed
 * literal rather than a secret because the gate is the NODE_ENV check:
 * a production deploy with `NODE_ENV=production` short-circuits to
 * `false` regardless of any header an attacker might send. Tests opt
 * in via `withTestBypassHeader` in `tests/helpers.ts`, which adds the
 * header on every helper-mediated call. The
 * `payments-provider-guards` burst test deliberately bypasses that
 * helper and uses raw `fetch` so the limiter actually fires for that
 * one assertion.
 */
const TEST_BYPASS_HEADER_VALUE = '1';

// Exported so route files that build their own inline `rateLimit({...})`
// (e.g. server/routes/account.ts's confirm-email-change limiter) can opt
// into the same NODE_ENV-gated bypass that every limiter declared in this
// file already uses, without re-implementing the gate locally and risking
// drift in the production-safety check.
export function testBypassSkip(req: Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return req.header('x-test-rate-limit-bypass') === TEST_BYPASS_HEADER_VALUE;
}

export const paymentWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('payment-write'),
  message: rateLimitMessage("Too many payment requests, please try again later"),
  skip: testBypassSkip,
});

export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('payment'),
  message: rateLimitMessage("Too many payment requests, please try again later"),
  skip: testBypassSkip,
});

export const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('admin-write'),
  message: rateLimitMessage("Too many admin requests, please try again later"),
  skip: testBypassSkip,
});

export const emailTestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('email-test'),
  message: rateLimitMessage("Too many test email requests, please try again later"),
  skip: testBypassSkip,
});

export const setupAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('setup-admin'),
  message: rateLimitMessage("Too many setup requests, please try again later"),
  skip: testBypassSkip,
});

export const bowlerSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('bowler-search'),
  message: rateLimitMessage("Too many search requests, please try again later"),
  skip: testBypassSkip,
});

export const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('invite'),
  message: rateLimitMessage("Too many invite requests, please try again later"),
  skip: testBypassSkip,
});

// Square deliveries originate from a small provider IP set, so a tiny per-IP
// allowance would combine unrelated tenant events and reject legitimate
// bursts. This limiter runs only after signature verification: the raw-body
// limit bounds anonymous work, while this ceiling bounds valid delivery bursts.
export const SQUARE_WEBHOOK_MAX_REQUESTS = 600;

export const squareWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: SQUARE_WEBHOOK_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('square-webhook'),
  message: rateLimitMessage("Too many requests, please try again later"),
  skip: testBypassSkip,
});
