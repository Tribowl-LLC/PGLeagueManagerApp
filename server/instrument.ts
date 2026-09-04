import { env } from "./config";
import { configureServerErrorReporter } from "./logger";
import { scrubSentryEvent } from "@shared/telemetry-scrubber";

const Sentry = await import("@sentry/node");

Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  tracesSampleRate: 1.0,
  sendDefaultPii: false,
  beforeSend: (event) => scrubSentryEvent(event),
});

configureServerErrorReporter((error, { logger }) => {
  Sentry.captureException(error, { tags: { logger_scope: logger } });
});
