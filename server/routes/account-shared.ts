import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { sendError } from '../utils/api';
import { phoneSchema, updateUserSchemaBase } from '@shared/schema';
import { PASSWORD_CHANGED_I18N } from '../services/email-i18n/password-changed';

// Languages we currently ship translations for. Sourced from the
// password-changed email bundle so adding a new locale there
// automatically widens the accepted set on this endpoint (and, by
// extension, the account-settings selector that hits it). Exported
// so the test pinning the round trip can assert the same set.
export const SUPPORTED_PREFERRED_LANGUAGES = Object.keys(
  PASSWORD_CHANGED_I18N,
) as ReadonlyArray<string>;

// PATCH /profile/:id body schema. Phone is intentionally tri-state so
// the handler can distinguish three caller intents:
//   undefined            → field omitted, leave the column untouched
//   null OR ""           → caller is explicitly clearing the field, write NULL
//   non-empty string     → caller is setting a new value
// We collapse empty / whitespace-only strings to null at the schema
// boundary so older clients (and the profile form, which submits a
// blank Input as "") get the same "clear it" behaviour as a JSON null.
//
// `preferredLanguage` follows the same tri-state shape (omit /
// explicit null / known locale code). The base schema's loose
// `z.string().nullable()` is tightened here to an allowlist drawn
// from the bundled translations — anything else gets a 400 instead
// of being silently persisted as garbage that the email helper would
// then fall back to English on (task #417).
//
// Exported for unit tests.
export const profileUpdateSchema = updateUserSchemaBase
  .pick({ name: true, email: true, phone: true })
  .extend({
    phone: phoneSchema
      .nullable()
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        return v.trim() === '' ? null : v;
      }),
    preferredLanguage: z
      .union([
        z.enum(SUPPORTED_PREFERRED_LANGUAGES as [string, ...string[]]),
        z.null(),
      ])
      .optional(),
  });

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  }
  next();
}

// How long an email-change confirmation token stays valid.
export const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashEmailChangeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
