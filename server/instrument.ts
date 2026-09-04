import { env } from "./config";
import { configureServerErrorReporter } from "./logger";
import { scrubSentryEvent, scrubSentrySpan } from "@shared/telemetry-scrubber";

const Sentry = await import("@sentry/node");

Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  release: process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT,
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  },
  beforeSend: (event) => scrubSentryEvent(event),
  beforeSendTransaction: (event) => scrubSentryEvent(event),
  beforeSendSpan: (span) => scrubSentrySpan(span),
});

configureServerErrorReporter((error, { logger }) => {
  Sentry.captureException(error, { tags: { logger_scope: logger } });
});
