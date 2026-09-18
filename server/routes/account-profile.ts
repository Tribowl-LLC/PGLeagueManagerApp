import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { sendError, sendSuccess, sanitizeUser, handleZodError } from '../utils/api';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { isDev } from '../config';
import {
  sendEmailChangeConfirmation,
  sendEmailChangeNotification,
  sendEmailChangeOldAddressApproval,
  getBaseUrl,
} from '../services/email';
import { requireSystemAdmin } from '../middleware/auth';
import { isOrgOrHigher, isPaymentManager, requireOrganizationAccess } from '../utils/access-control.js';
import { syncBowlerForUser } from '../services/payment-customer-sync';
import { comparePasswords } from '../lib/password';
import { maskEmail } from '../utils/pii';
import { randomBytes } from 'crypto';
import { emailSchema, type PaymentSyncStatus } from '@shared/schema';
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
  EmailChangeSecurityHoldError,
} from '../services/account-lifecycle';
import {
  awaitEmailDelivery,
  type EmailDeliveryOutcome,
} from '../services/email-delivery-outcome';
import {
  getUserVerificationProvenance,
  resetPhoneVerificationProvenance,
} from '../services/verification-provenance.js';
import { hasActiveIdentitySecurityHold } from '../storage/profile-claim-notifications.js';

const log = createLogger('Account');
const router = Router();

// Email-change reauthentication is deliberately rate-limited across replicas.
// A stolen authenticated session must not be able to turn the current-password
// check into an unlimited online guessing oracle. The target and actor are
// both part of the key so one account cannot be exhausted by requests aimed at
// another profile, while the IP component bounds distributed account probing.
const emailChangeReauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('email-change-reauth'),
  keyGenerator: (req: Request) => {
    const actorId = (req.user as { id?: number } | undefined)?.id ?? 'unknown';
    const targetId = singleRouteParam(req.params.id) || 'unknown';
    return `actor:${actorId}:target:${targetId}:ip:${ipKeyGenerator(req.ip || 'unknown')}`;
  },
  handler: (_req, res) => sendError(
    res,
    'Too many email-change attempts. Please wait before trying again.',
    429,
    'RATE_LIMITED',
  ),
});

// Update user profile (name/phone synchronously; email gated by confirmation).
//
// Response contract (200): { ...sanitizedUser, paymentSyncStatus, emailChangeRequested, emailChangeDelivery? }
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
//   emailChangeDelivery is present when emailChangeRequested is true and
//     reports each independent post-commit email attempt. A timeout is
//     reported as unknown because the provider may still accept the request.
//
// Note: this confirmation gate applies to **all** callers, including
// system_admin acting on behalf of another user, to prevent an admin (or
// session hijacker with admin privs) from silently rerouting another
// user's login email to an attacker-controlled address. If admins ever
// need to swap an email without confirmation, build a separate, audited
// admin-only endpoint — do not relax this one.
router.patch('/profile/:id', requireAuth, emailChangeReauthLimiter, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }

    const user = req.user;
    if (!user) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
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

    // Owner accounts are still bounded by the configured business in the
    // singleton deployment. The system-admin role permits delegated profile
    // edits, but it does not turn a retained foreign account into a resource
    // that this application may mutate.
    if (user.id !== userId && !requireOrganizationAccess(req, existingUser.organizationId, 'user', userId)) {
      return sendError(res, 'You do not have access to edit this user', 403, 'FORBIDDEN');
    }

    const emailRequested =
      typeof updateData.email === 'string' &&
      updateData.email.trim().length > 0 &&
      updateData.email.trim().toLowerCase() !== existingUser.email.toLowerCase();

    let emailChangeRequested = false;
    let emailChangeDelivery: {
      confirmation: EmailDeliveryOutcome;
      notification: EmailDeliveryOutcome;
    } | undefined;

    if (emailRequested) {
      // A self-service email reroute is a credential mutation. Require a
      // current-password proof before creating any pending request; an admin
      // acting on another user follows the existing audited admin path and
      // still cannot bypass the new-address confirmation.
      if (user.id === userId) {
        if (!updateData.currentPassword) {
          return sendError(res, 'Current password is required to change your email', 400, 'REAUTH_REQUIRED');
        }
        const passwordMatches = await comparePasswords(updateData.currentPassword, existingUser.password);
        if (!passwordMatches) {
          return sendError(res, 'Current password is incorrect', 400, 'INVALID_PASSWORD');
        }
      }
      const newEmail = typeof updateData.email === 'string'
        ? updateData.email.trim().toLowerCase()
        : '';
      if (!newEmail) return sendError(res, 'A replacement email is required', 400, 'VALIDATION_ERROR');
      const userWithEmail = await storage.getUserByEmail(newEmail);
      if (userWithEmail && userWithEmail.id !== userId) {
        return sendError(res, 'Email already in use', 400, 'EMAIL_IN_USE');
      }

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashEmailChangeToken(rawToken);
      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS).toISOString();
      const provenance = await getUserVerificationProvenance(existingUser.id);
      const currentEmail = existingUser.email.trim().toLowerCase();
      const needsOldMailboxProof = !provenance
        || provenance.emailStatus !== 'verified'
        || provenance.email.trim().toLowerCase() !== currentEmail;
      const rawOldToken = needsOldMailboxProof ? randomBytes(32).toString('hex') : null;
      const oldTokenHash = rawOldToken ? hashEmailChangeToken(rawOldToken) : null;
      const oldTokenExpiresAt = rawOldToken
        ? new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS).toISOString()
        : null;
      const requestedAt = new Date().toISOString();

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
        oldEmail: existingUser.email,
        oldEmailTokenHash: oldTokenHash,
        oldEmailTokenExpiresAt: oldTokenExpiresAt,
        oldEmailApprovedAt: needsOldMailboxProof ? null : requestedAt,
        reauthenticatedAt: user.id === userId ? requestedAt : null,
        credentialGeneration: existingUser.credentialGeneration,
        flowVersion: 2,
        audit: adminInitiated
          ? {
              actorUserId: user.id,
              oldEmailMasked: maskEmail(existingUser.email),
              newEmailMasked: maskEmail(newEmail),
            }
          : null,
      });

      // Build confirmation URLs from the canonical deployment host.  The
      // production singleton rejects organization-subdomain hosts with HTTP
      // 421, so organization context is retained in the request/session rather
      // than encoded as an email-link hostname.
      const org = existingUser.organizationId
        ? await storage.getOrganization(existingUser.organizationId)
        : null;
      const baseUrl = getBaseUrl(org);
      const confirmUrl = `${baseUrl}/confirm-email-change?token=${rawToken}`;
      const oldApprovalUrl = rawOldToken
        ? `${baseUrl}/confirm-email-change?kind=old&token=${rawOldToken}`
        : null;

      // The request is already committed. Bound both independent provider
      // calls so the API cannot hang, and preserve the pending request when
      // either call fails; resubmitting the same address safely issues a fresh
      // confirmation request without exposing the raw token.
      const [confirmation, notification] = await Promise.all([
        awaitEmailDelivery(() => sendEmailChangeConfirmation(
          newEmail,
          existingUser.name,
          confirmUrl,
        )),
        awaitEmailDelivery(() => rawOldToken && oldApprovalUrl
          ? sendEmailChangeOldAddressApproval(
            existingUser.email,
            existingUser.name,
            isDev ? newEmail : maskEmail(newEmail),
            oldApprovalUrl,
          )
          : sendEmailChangeNotification(
            existingUser.email,
            existingUser.name,
            isDev ? newEmail : maskEmail(newEmail),
          )),
      ]);
      emailChangeDelivery = { confirmation, notification };

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
    if (
      updateData.phone !== undefined
      && updateData.phone !== existingUser.phone
    ) {
      // The signup phone proved possession only at registration. Clear that
      // proof before accepting a later edit so a changed number cannot inherit
      // the original verification timestamp/source.
      await resetPhoneVerificationProvenance({
        userId,
        phone: updateData.phone ?? null,
      });
    }
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

    // Staff accounts are never bowlers. If a legacy payment-manager row still
    // carries a stale bowlerId, a profile edit must not mutate that global
    // bowler record through the payment-customer sync path.
    if (updatedUser.bowlerId && !isPaymentManager(user)) {
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
      ...(emailChangeDelivery ? { emailChangeDelivery } : {}),
    });
  } catch (error) {
    if (error instanceof EmailChangeSecurityHoldError) {
      return sendError(res, error.message, 423, 'IDENTITY_SECURITY_HOLD');
    }
    log.error('Error updating user:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

/**
 * Admin-assisted recovery for a user who cannot access the old mailbox.
 * This is intentionally separate from the ordinary profile PATCH: only an
 * org/system administrator may waive old-mailbox proof, the actor must
 * reauthenticate with their own password, and the replacement mailbox still
 * has to confirm the pending request before the login address changes.
 */
router.post('/profile/:id/email-recovery', requireAuth, emailChangeReauthLimiter, async (req: Request, res: Response) => {
  try {
    const userId = Number.parseInt(singleRouteParam(req.params.id), 10);
    const actor = req.user;
    if (!actor) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }
    if (!isOrgOrHigher(actor) || actor.id === userId) {
      return sendError(res, 'Administrator-assisted recovery is required for another user', 403, 'FORBIDDEN');
    }
    const parsed = z.object({
      newEmail: emailSchema,
      currentPassword: z.string().min(1, 'Current password is required'),
      reason: z.string().trim().min(1, 'A recovery reason is required').max(500),
    }).safeParse(req.body);
    if (!parsed.success) return handleZodError(res, parsed.error);

    const target = await storage.getUser(userId);
    if (!target) return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    if (!requireOrganizationAccess(req, target.organizationId, 'user', userId)) {
      return sendError(res, 'You do not have access to recover this user', 403, 'FORBIDDEN');
    }
    if (await hasActiveIdentitySecurityHold(target.id)) {
      return sendError(res, 'This account is temporarily restricted while a profile-security report is reviewed.', 423, 'IDENTITY_SECURITY_HOLD');
    }

    const actorRecord = await storage.getUser(actor.id);
    if (!actorRecord?.password || !(await comparePasswords(parsed.data.currentPassword, actorRecord.password))) {
      return sendError(res, 'Current administrator password is incorrect', 400, 'INVALID_PASSWORD');
    }

    const newEmail = parsed.data.newEmail.trim().toLowerCase();
    const existingEmailOwner = await storage.getUserByEmail(newEmail);
    if (existingEmailOwner && existingEmailOwner.id !== target.id) {
      return sendError(res, 'Email already in use', 400, 'EMAIL_IN_USE');
    }
    if (newEmail === target.email.trim().toLowerCase()) {
      return sendError(res, 'The replacement email must be different from the current email', 400, 'EMAIL_UNCHANGED');
    }

    const rawToken = randomBytes(32).toString('hex');
    const requestedAt = new Date().toISOString();
    await applyEmailChangeRequestTxn({
      userId: target.id,
      newEmail,
      tokenHash: hashEmailChangeToken(rawToken),
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS).toISOString(),
      oldEmail: target.email,
      oldEmailTokenHash: null,
      oldEmailTokenExpiresAt: null,
      // The waiver is explicit and attributable to the reauthenticated admin;
      // the destination mailbox still has to complete its own proof.
      oldEmailApprovedAt: requestedAt,
      reauthenticatedAt: requestedAt,
      credentialGeneration: target.credentialGeneration,
      flowVersion: 2,
      audit: {
        actorUserId: actor.id,
        oldEmailMasked: maskEmail(target.email),
        newEmailMasked: maskEmail(newEmail),
        reason: parsed.data.reason,
        oldMailboxWaived: true,
      },
    });

    const org = target.organizationId ? await storage.getOrganization(target.organizationId) : null;
    const baseUrl = getBaseUrl(org);
    const confirmUrl = `${baseUrl}/confirm-email-change?token=${rawToken}`;
    const [confirmation, notification] = await Promise.all([
      awaitEmailDelivery(() => sendEmailChangeConfirmation(newEmail, target.name, confirmUrl)),
      awaitEmailDelivery(() => sendEmailChangeNotification(target.email, target.name, isDev ? newEmail : maskEmail(newEmail))),
    ]);
    return sendSuccess(res, {
      emailChangeRequested: true,
      emailChangeDelivery: { confirmation, notification },
    }, 202);
  } catch (error) {
    if (error instanceof EmailChangeSecurityHoldError) {
      return sendError(res, error.message, 423, 'IDENTITY_SECURITY_HOLD');
    }
    log.error('Error creating administrator-assisted email recovery:', error);
    return sendError(res, 'Unable to start administrator-assisted email recovery', 500, 'SERVER_ERROR');
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
      if (!requireOrganizationAccess(req, bowler.organizationId, 'bowler', bowlerId)) {
        return sendError(res, 'You do not have access to retry this bowler sync', 403, 'FORBIDDEN');
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
      if (!requireOrganizationAccess(req, linkedUser.organizationId, 'user', linkedUser.id)) {
        return sendError(res, 'You do not have access to retry this user sync', 403, 'FORBIDDEN');
      }
      if (isPaymentManager(linkedUser)) {
        return sendError(res, 'Staff accounts cannot sync bowler profiles', 403, 'FORBIDDEN');
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
      const user = req.user;
      if (!user) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
      if (isPaymentManager(user)) {
        return sendError(res, 'Staff accounts cannot sync bowler profiles', 403, 'FORBIDDEN');
      }
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
