
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initCsrfToken } from "./lib/queryClient";
import { scrubSentryEvent, scrubSentrySpan } from "./lib/logger";
import { isNativeApp } from './lib/capacitor';

initCsrfToken();

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: __APP_RELEASE__,
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 1.0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
  },
  // task #770: redaction backstop so events captured outside the
  // client logger (uncaught errors, SDK breadcrumbs, etc.) still have
  // PII / secret-shaped strings masked before leaving the browser.
  beforeSend: (event) => scrubSentryEvent(event),
  beforeSendTransaction: (event) => scrubSentryEvent(event),
  beforeSendSpan: (span) => scrubSentrySpan(span),
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ('serviceWorker' in navigator && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

fetch('/api/org-context', { credentials: 'include' })
  .then(res => res.json())
  .then(({ data }) => {
    if (data?.slug && (data.appIcon || data.logo)) {
      const iconUrl = `/api/organizations/slug/${data.slug}/app-icon`;
      const appleTouch = document.querySelector('link[rel="apple-touch-icon"]');
      if (appleTouch) appleTouch.setAttribute('href', iconUrl);
    }
  })
  .catch(() => {});
