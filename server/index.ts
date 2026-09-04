/**
 * Production / dev entry point.
 *
 * The full boot lives in `server/app.ts` so the per-worker test
 * harness (`server/test-entry.ts`, Task #699) can reuse the same
 * factory with `suppressBackgroundWorkers: true`. Keep this file a
 * thin one-liner so `npm run dev` keeps using the canonical path.
 */
export {};

// Sentry must initialize before Express is imported so its request tracing and
// isolation instrumentation can patch the framework during module loading.
await import('./instrument');
const { createApp } = await import('./app');

await createApp();
