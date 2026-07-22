import helmet from "helmet";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { env, isDev } from "../config";

/**
 * Helmet middleware with our Content-Security-Policy. Allows Square
 * payment SDKs, Google/Apple Pay, and Sentry error reporting.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://web.squarecdn.com",
        "https://sandbox.web.squarecdn.com",
        "https://pay.google.com",
        ...(isDev ? ["'unsafe-inline'", "'unsafe-eval'"] : []),
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://web.squarecdn.com",
        "https://sandbox.web.squarecdn.com",
      ],
      connectSrc: [
        "'self'",
        "https://web.squarecdn.com",
        "https://sandbox.web.squarecdn.com",
        "https://pds.squareup.com",
        "https://connect.squareup.com",
        "https://connect.squareupsandbox.com",
        "https://pci-connect.squareup.com",
        "https://pci-connect.squareupsandbox.com",
        "https://square-fonts-production-f.squarecdn.com",
        "https://d1g145x70srn7h.cloudfront.net",
        "https://cash-f.squarecdn.com",
        "https://pay.google.com",
        "https://google.com",
        "https://apple.com",
        "https://*.apple.com",
        "https://*.apple-pay-gateway.apple.com",
        "https://*.ingest.sentry.io",
        "https://*.ingest.us.sentry.io",
        ...(isDev ? ["ws:", "wss:"] : []),
      ],
      frameSrc: [
        "'self'",
        "https://web.squarecdn.com",
        "https://sandbox.web.squarecdn.com",
        "https://pci-connect.squareup.com",
        "https://pci-connect.squareupsandbox.com",
        "https://pay.google.com",
        "https://apple.com",
        "https://*.apple.com",
      ],
      imgSrc: ["'self'", "data:", "blob:", "https://web.squarecdn.com", "https://sandbox.web.squarecdn.com"],
      fontSrc: ["'self'", "data:", "https://square-fonts-production-f.squarecdn.com", "https://d1g145x70srn7h.cloudfront.net", "https://cash-f.squarecdn.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
      // CSP host-source matching is case-insensitive per CSP3 §6.6.2.6, but
      // emitting the canonical lowercase form keeps the directive readable.
      frameAncestors: isDev
        ? ["*"]
        : ["'self'", `https://${env.APP_DOMAIN}`, `https://*.${env.APP_DOMAIN}`],
    },
  },
  frameguard: isDev ? false : { action: 'sameorigin' },
  strictTransportSecurity: false,
  crossOriginEmbedderPolicy: false,
  // Wallet payment popups (Google Pay) need to postMessage their token back
  // to this page after the user authorises payment. Helmet's default COOP of
  // 'same-origin' isolates the popup and breaks that handshake (Google Pay
  // surfaces it as error code OR_BIBED_15 / "pop-ups may be turned off").
  // 'same-origin-allow-popups' keeps cross-origin isolation for our own page
  // while letting wallet / OAuth-style popups talk back to the opener.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
});

function getAllowedOrigins(): string[] {
  const origins: string[] = [];
  // safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
  // The Origin header sent by browsers has its host lowercased by the URL
  // parser, so the literal `allowedOrigins.includes(origin)` compare in
  // `isAllowedOrigin` would silently fail if APP_DOMAIN were mixed-case.
  origins.push(`https://${env.APP_DOMAIN}`);
  if (isDev) {
    if (env.REPLIT_DOMAINS) {
      for (const domain of env.REPLIT_DOMAINS.split(',')) {
        origins.push(`https://${domain}`);
      }
    }
    if (env.REPL_SLUG && env.REPL_OWNER) {
      origins.push(`https://${env.REPL_SLUG}.${env.REPL_OWNER}.repl.co`);
    }
    origins.push('http://localhost:5000');
    origins.push('http://localhost:5173');
    origins.push('http://127.0.0.1:5000');
    origins.push('http://127.0.0.1:5173');
  }
  return origins;
}

const allowedOrigins = getAllowedOrigins();

export function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  if (origin === 'capacitor://localhost' || origin === 'ionic://localhost') return true;
  if (origin === 'http://localhost') return true;
  try {
    const url = new URL(origin);
    // safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
    // `url.hostname` is lowercased by the WHATWG URL parser, so the suffix
    // compare is implicitly case-insensitive only because both sides are
    // already lowercase.
    if (url.hostname.endsWith(`.${env.APP_DOMAIN}`) && url.protocol === 'https:') {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Sets JSON / no-cache / CORS headers for `/api/*` and short-circuits OPTIONS
 * preflights. Allowed origins include leaguevault.app (and subdomains), Replit
 * dev domains, and Capacitor/Ionic mobile shells.
 */
export function apiHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
}
