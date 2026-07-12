import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { sendError, sendSuccess, sanitizeUser, handleZodError } from '../utils/api';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { isDev } from '../config';
import {
  sendEmailChangeConfirmation,
  sendEmailChangeNotification,
  getBaseUrl,
} from '../services/email';
import { requireSystemAdmin } from '../middleware/auth';
import { syncBowlerForUser } from '../services/payment-customer-sync';
import { maskEmail } from '../utils/pii';
import { randomBytes } from 'crypto';
import { type PaymentSyncStatus } from '@shared/schema';
import { cacheInvalidate } from '../utils/cache';
import { createSharedRateLimitStore } from '../utils/rate-limit-store';
import {
  requireAuth,
  profileUpdateSchema,
  hashEmailChangeToken,
  EMAIL_CHANGE_TOKEN_TTL_MS,
} from './account-shared';
import {
  applyEmailChangeRequestTxn,
  applyAdminProfileEditTxn,
  type AdminProfileEditFieldChange,
} from '../services/account-lifecycle';

const log = createLogger('Account');
const router = Router();

// Update user profile (name/phone synchronously; email gated by confirmation).
//
// Response contract (200): { ...sanitizedUser, paymentSyncStatus, emailChangeRequested }
//   paymentSyncStatus is one of:
//     - 'synced'         : provider customer record updated successfully
//     - 'skipped'        : no provider configured (informational, not a warning)
//     - 'pending_retry'  : provider call failed for a real reason; bowler row
//                          flagged with payment_sync_pending_at, will be retried
//                          on next profile edit or via the admin retry endpoint
//     - 'not_applicable' : no linked bowler (nothing to sync)
//   emailChangeRequested: true when a new email was supplied that differs
//     from the current login email — the email is NOT applied; instead a
//     confirmation link is sent to the new address and a notification to
//     the old. The login email only changes after confirmation.
//
// Note: this confirmation gate applies to **all** callers, including
// system_admin acting on behalf of another user, to prevent an admin (or
// session hijacker with admin privs) from silently rerouting another
// user's login email to an attacker-controlled address. If admins ever
// need to swap an email without confirmation, build a separate, audited
// admin-only endpoint — do not relax this one.
router.patch('/profile/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }

    const user = req.user!;
    if (user.id !== userId && user.role !== 'system_admin') {
      return sendError(res, 'Unauthorized', 403, 'UNAUTHORIZED');
    }

    const validationResult = profileUpdateSchema.safeParse(req.body);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const updateData = validationResult.data;

    const existingUser = await storage.getUser(userId);
    if (!existingUser) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    const emailRequested =
      typeof updateData.email === 'string' &&
      updateData.email.trim().length > 0 &&
      updateData.email.trim().toLowerCase() !== existingUser.email.toLowerCase();

    let emailChangeRequested = false;

    if (emailRequested) {
      const newEmail = updateData.email!.trim().toLowerCase();
      const userWithEmail = await storage.getUserByEmail(newEmail);
      if (userWithEmail && userWithEmail.id !== userId) {
        return sendError(res, 'Email already in use', 400, 'EMAIL_IN_USE');
      }

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashEmailChangeToken(rawToken);
      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS).toISOString();

      // Supersede any older pending request and create the new one
      // (and, when adminInitiated, the audit row) in a single
      // transaction — see `applyEmailChangeRequestTxn` for the
      // atomicity contract.
      const adminInitiated = user.id !== userId;
      await applyEmailChangeRequestTxn({
        userId,
        newEmail,
        tokenHash,
        expiresAt,
        audit: adminInitiated
          ? {
              actorUserId: user.id,
              oldEmailMasked: maskEmail(existingUser.email),
              newEmailMasked: maskEmail(newEmail),
            }
          : null,
      });

      // Build confirmation URL using the org's subdomain when known so the
      // resulting click lands in the right tenant.
      const org = existingUser.organizationId
        ? await storage.getOrganization(existingUser.organizationId)
        : null;
      const baseUrl = getBaseUrl(org);
      const confirmUrl = `${baseUrl}/confirm-email-change?token=${rawToken}`;

      // Best-effort email delivery; do not fail the API call if the SMTP
      // hop fails. We still record the request so the user can retry.
      try {
        await sendEmailChangeConfirmation(newEmail, existingUser.name, confirmUrl);
      } catch (mailErr) {
        log.error('Failed to send email-change confirmation (non-fatal):', mailErr);
      }
      try {
        await sendEmailChangeNotification(
          existingUser.email,
          existingUser.name,
          isDev ? newEmail : maskEmail(newEmail),
        );
      } catch (mailErr) {
        log.error('Failed to send email-change notification to old address (non-fatal):', mailErr);
      }

      emailChangeRequested = true;
      log.info('Email-change request created', {
        userId,
        oldEmail: maskEmail(existingUser.email),
        newEmail: maskEmail(newEmail),
      });
    }

    // Build the actual storage patch — name/phone only, never email.
    // For phone we keep the tri-state semantics from the schema: only
    // SKIP the column when the field was OMITTED (undefined). An
    // explicit `null` is a "clear it" intent and must propagate so the
    // DB row ends up with phone = NULL.
    const storagePatch: Parameters<typeof storage.updateUser>[1] = {};
    if (updateData.name !== undefined) storagePatch.name = updateData.name;
    if (updateData.phone !== undefined) storagePatch.phone = updateData.phone;
    // task #417: persist the user's UI / notification language. Same
    // tri-state semantics as phone — `undefined` skips the column,
    // `null` clears it ("follow the default"), a known code sets it.
    if (updateData.preferredLanguage !== undefined) {
      storagePatch.preferredLanguage = updateData.preferredLanguage;
    }

    // Task #376: when a system_admin edits another user's name, phone,
    // or preferredLanguage, write one audit row per changed field in
    // the SAME transaction as the user update so the audit and the
    // change cannot disagree (mirrors the email-change contract from
    // task #325). Self-serve edits skip the audit table entirely;
    // the existing INFO log on `storage.updateUser` already covers
    // those, and they aren't a triage concern.
    const adminInitiatedProfileEdit = user.id !== userId;
    const profileFieldChanges: AdminProfileEditFieldChange[] = [];
    if (adminInitiatedProfileEdit) {
      if (
        updateData.name !== undefined &&
        updateData.name !== existingUser.name
      ) {
        profileFieldChanges.push({
          field: 'name',
          oldValue: existingUser.name,
          newValue: updateData.name,
        });
      }
      if (
        updateData.phone !== undefined &&
        updateData.phone !== existingUser.phone
      ) {
        profileFieldChanges.push({
          field: 'phone',
          oldValue: existingUser.phone,
          newValue: updateData.phone,
        });
      }
      if (
        updateData.preferredLanguage !== undefined &&
        updateData.preferredLanguage !== existingUser.preferredLanguage
      ) {
        profileFieldChanges.push({
          field: 'preferred_language',
          oldValue: existingUser.preferredLanguage,
          newValue: updateData.preferredLanguage,
        });
      }
    }

    let updatedUser = existingUser;
    if (Object.keys(storagePatch).length > 0) {
      if (profileFieldChanges.length > 0) {
        // Atomic admin-initiated edit: user update + per-field audit
        // rows in one transaction. Delegated to `applyAdminProfileEditTxn`
        // so the unit test in
        // `tests/unit/admin-profile-edit-audit-atomicity.test.ts` can pin
        // the SAME function the route runs in production. We still
        // replicate the cache invalidation that `storage.updateUser`
        // would have done (the helper is the bare transaction; cache
        // invalidation is a route concern).
        updatedUser = await applyAdminProfileEditTxn({
          userId,
          storagePatch,
          actorUserId: user.id,
          fieldChanges: profileFieldChanges,
        });
        cacheInvalidate(`user:${userId}`);
        log.info('Admin-initiated profile edit recorded', {
          actorUserId: user.id,
          targetUserId: userId,
          fields: profileFieldChanges.map((c) => c.field),
        });
      } else {
        updatedUser = await storage.updateUser(userId, storagePatch);
      }
    }

    let paymentSyncStatus: PaymentSyncStatus = 'not_applicable';

    if (updatedUser.bowlerId) {
      const nameChanged =
        updateData.name !== undefined && updateData.name !== existingUser.name;
      const phoneChanged =
        updateData.phone !== undefined && updateData.phone !== existingUser.phone;

      if (nameChanged || phoneChanged) {
        // Email is intentionally NOT synced here — that happens at confirm time.
        const result = await syncBowlerForUser(updatedUser, {
          nameChanged: !!nameChanged,
          emailChanged: false,
          phoneChanged: !!phoneChanged,
        });
        paymentSyncStatus = result;
      }
    }

    return sendSuccess(res, {
      ...sanitizeUser(updatedUser),
      paymentSyncStatus,
      emailChangeRequested,
    });
  } catch (error) {
    log.error('Error updating user:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

// Throttle the admin-initiated retry endpoint (task #440), companion
// to `retryPaymentSyncLimiter` (defined below) for the self-serve
// path. Same cost shape — every call makes a payment-provider
// request and bumps `payment_sync_attempts` — so a slipping admin
// finger or a runaway script in an admin browser tab can still
// hammer one user even though admins are otherwise trusted.
//
// The bucket is keyed on the **target bowler id** from the URL (not
// the admin's own user id) so:
//   - one admin walking through many users in quick succession
//     (a common bulk-fix flow) is NOT throttled, but
//   - any single user can never be ground against the provider
//     past ~10 retries / minute, no matter how many admins are
//     poking at them in parallel.
//
// The cap is intentionally a touch more generous than the self-serve
// 5/min because the legitimate admin workflow does sometimes need a
// couple of close-together retries on the same account (e.g.
// waiting for a webhook to land or a transient provider blip to
// clear).
//
// Ordering: this limiter runs AFTER `requireAuth` +
// `requireSystemAdmin`, unlike the self-serve limiter which runs
// BEFORE `requireAuth` and falls back to per-IP keying. The reason
// is the keying surface — the per-bowler bucket here comes from a
// path param, so an unauth attacker reaching the limiter first
// could pile hits onto an arbitrary bowler-id bucket and DoS the
// admin's retry budget for that user without ever authenticating.
// Gating on `requireSystemAdmin` first means only authorized
// callers can ever increment a bucket.
const adminRetryPaymentSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('admin-retry-payment-sync'),
  // The key MUST be the same canonical id the handler uses to talk
  // to the payment provider — otherwise the budget can be trivially
  // bypassed by requesting equivalent variants of the same bowler
  // id ('9001', '09001', '9001abc' all parse to bowler 9001 but
  // would land in three separate buckets if we keyed off the raw
  // string). Mirror the handler's `parseInt(req.params.id, 10)`
  // exactly; route to a single 'invalid' bucket on NaN so garbage
  // path callers can't spawn unbounded fresh buckets either.
  keyGenerator: (req: Request) => {
    const parsed = Number.parseInt(singleRouteParam(req.params.id), 10);
    return Number.isNaN(parsed) ? 'b:invalid' : `b:${parsed}`;
  },
  handler: (req, res) => {
    log.warn('Admin payment-sync retry throttled', {
      adminUserId: (req.user as { id?: number } | undefined)?.id,
      targetBowlerId: req.params.id,
    });
    return sendError(
      res,
      'Too many retry attempts for this user. Please wait a minute before retrying.',
      429,
      'RATE_LIMITED',
    );
  },
});

// Admin-initiated retry for a bowler whose payment-customer sync failed.
// Re-runs the same provider call the profile-update path uses; success
// clears `payment_sync_pending_at`, failure leaves it set.
router.post(
  '/bowlers/:id/retry-payment-sync',
  requireAuth,
  requireSystemAdmin,
  adminRetryPaymentSyncLimiter,
  async (req: Request, res: Response) => {
    try {
      // Task #472: strict digit-only check on the URL id. JavaScript's
      // built-in `parseInt` is lenient — `parseInt('9001abc', 10)`
      // returns 9001, and the previous `if (isNaN(bowlerId))` guard
      // therefore did NOT reject typo'd admin URLs. An admin pasting
      // a corrupted id from a chat or log line (e.g. an extra
      // character on the end) would silently retry sync for the
      // PREFIX-numeric bowler — i.e. act on the wrong person. We
      // require [0-9]+ so the only inputs that reach `getBowler`
      // are unambiguous integer ids. Leading-zero forms ('09001')
      // are intentionally still accepted because they are still
      // digit-only and parse to the same canonical id; rejecting
      // them would surprise no-one but would needlessly diverge
      // from the limiter's keying contract above.
      //
      // Note: the limiter's `keyGenerator` at line ~729 still uses
      // `Number.parseInt` and intentionally collapses equivalent
      // variants ('9201', '09201', '9201abc') into one bucket.
      // That is the right behavior for the limiter — it's a
      // bypass-prevention canonicalization (the per-bowler budget
      // must not be defeatable by URL-variant tricks). The handler's
      // strict check below is a separate concern (correctness of
      // which row we act on) and runs after the limiter, so the
      // two contracts compose without conflict.
      const rawId = singleRouteParam(req.params.id);
      if (!/^\d+$/.test(rawId)) {
        return sendError(res, 'Invalid bowler ID', 400, 'INVALID_ID');
      }
      const bowlerId = Number.parseInt(rawId, 10);

      const bowler = await storage.getBowler(bowlerId);
      if (!bowler) {
        return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
      }

      // Find the user record linked to this bowler so we can resolve the
      // location/org context for provider lookup. If no user is linked we
      // can't sync — surface a clear 422.
      const linkedUser = await storage.getUserByBowlerId(bowlerId);
      if (!linkedUser) {
        return sendError(
          res,
          'No user is linked to this bowler; cannot retry sync',
          422,
          'NO_LINKED_USER',
        );
      }

      // Task #682: the bowler must have an email — `syncBowlerForUser`
      // returns `'skipped'` for emailless bowlers (nothing to push to
      // Square). Surface that contract as a clean 422 here so admins
      // viewing a data-integrity row see why the retry is a no-op
      // instead of getting a misleading `synced` / `skipped` status
      // back. The `linkedUser.email ?? bowler.email` order below is
      // the same fallback the helper itself uses, so this guard
      // checks the same value the helper would have seen.
      const effectiveEmail = linkedUser.email ?? bowler.email;
      if (!effectiveEmail) {
        return sendError(
          res,
          'Bowler has no email; nothing to sync',
          422,
          'NO_EMAIL',
        );
      }

      // Source-of-truth for retry is the linked **user's** profile, not the
      // bowler row. The bowler row may carry stale values from the failed
      // sync attempt; the user record reflects what the user submitted.
      // Fall back to bowler fields only when the user record is missing data.
      const status = await syncBowlerForUser(
        {
          id: linkedUser.id,
          bowlerId,
          name: linkedUser.name ?? bowler.name,
          email: linkedUser.email ?? bowler.email,
          phone: linkedUser.phone ?? bowler.phone,
          locationId: linkedUser.locationId,
          organizationId: linkedUser.organizationId,
        },
        { nameChanged: true, emailChanged: true, phoneChanged: true },
      );

      return sendSuccess(res, { paymentSyncStatus: status });
    } catch (error) {
      log.error('Error retrying payment sync:', error);
      return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
    }
  },
);

// Throttle the self-serve retry endpoint (task #365). Every call
// makes an external payment-provider request and bumps the
// `payment_sync_attempts` counter, so a user mashing the "Retry now"
// button — or a script doing so — can both pressure the provider's
// own rate limits and wear out our DB row. A small budget (5 / min
// per user) is plenty for legitimate use; the background retry sweep
// (task #284) handles the long-tail recovery anyway. Same shape as
// `changePasswordLimiter` below: per-user keying with IP fallback so
// pre-auth callers still get throttled, shared Postgres store so the
// budget holds across replicas (task #356), and the standard
// `RATE_LIMITED` error envelope so the client's existing 429 handling
// continues to work.
const retryPaymentSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('retry-payment-sync'),
  keyGenerator: (req: Request) => {
    const userId = (req.user as { id?: number } | undefined)?.id;
    if (userId) return `u:${userId}`;
    // Fall through to IP if not yet authenticated — `requireAuth`
    // runs AFTER this limiter, so an unauth caller still gets per-IP
    // throttling instead of bypassing the limit by omitting cookies.
    // `ipKeyGenerator` collapses IPv6 addresses down to a /64 prefix,
    // which is what blocks the "rotate addresses inside one /64 to
    // dodge the bucket" bypass that `req.ip` alone permits — and is
    // also what express-rate-limit v8+ now hard-validates at module
    // load (`ERR_ERL_KEY_GEN_IPV6`), so this also keeps the server
    // from refusing to boot.
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (req, res) => {
    log.warn('Self-serve payment-sync retry throttled', {
      userId: (req.user as { id?: number } | undefined)?.id,
    });
    return sendError(
      res,
      'Too many retry attempts. Please wait a minute and try again.',
      429,
      'RATE_LIMITED',
    );
  },
});

// Self-serve retry for the *current* user's bowler when an earlier
// profile-update left the payment-customer sync in `pending_retry`
// (task #323). The ProfileInfoCard surfaces a "Retry now" button
// when the most recent PATCH or retry returned `pending_retry`; this
// route powers that button so a user can resolve the temporarily-
// out-of-date state on demand instead of waiting for the background
// sweep.
//
// Security shape: no path param. The bowler id is read from the
// authenticated session (`req.user.bowlerId`), so a user can never
// trigger a sync for someone else's bowler — this route does NOT
// reuse the admin endpoint above (which lives behind
// `requireSystemAdmin` and takes an :id from the URL).
router.post(
  '/profile/retry-payment-sync',
  retryPaymentSyncLimiter,
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const bowlerId = (user as { bowlerId?: number | null }).bowlerId ?? null;

      // Same 422 contract the admin endpoint uses when no bowler is
      // linked, so the client-side error handling stays uniform.
      if (bowlerId === null) {
        return sendError(
          res,
          'No bowler is linked to your account; nothing to retry',
          422,
          'NO_LINKED_BOWLER',
        );
      }

      const bowler = await storage.getBowler(bowlerId);
      if (!bowler) {
        return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
      }

      // Source-of-truth for retry is the linked user's profile, not
      // the bowler row — same rationale as the admin endpoint.
      const status = await syncBowlerForUser(
        {
          id: user.id,
          bowlerId,
          name: user.name ?? bowler.name,
          email: user.email ?? bowler.email,
          phone: user.phone ?? bowler.phone,
          locationId: user.locationId,
          organizationId: user.organizationId,
        },
        { nameChanged: true, emailChanged: true, phoneChanged: true },
      );

      return sendSuccess(res, { paymentSyncStatus: status });
    } catch (error) {
      log.error('Error in self-serve payment-sync retry:', error);
      return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
    }
  },
);

export default router;
