import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { sendError, sendSuccess, sanitizeUser, handleZodError } from '../utils/api';
import { storage } from '../storage';
import { hashPassword, destroyOtherSessionsForUser, destroyAllSessionsForUser } from '../auth';
import { PASSWORD_CHANGE_LOCKOUT_DURATION_MS } from '../storage/users';
import { passwordSchema } from '@shared/password-validation';
import { insertDeletionRequestSchema } from '@shared/schema';
import { createLogger } from '../logger';
import { comparePasswords } from '../lib/password';
import {
  sendDeletionRequestNotification,
  sendPasswordChangedNotification,
  sendAccountLockoutAlert,
} from '../services/email';
import { testBypassSkip } from '../middleware/rate-limit';
import { syncBowlerForUser } from '../services/payment-customer-sync';
import { maskEmail } from '../utils/pii';
import { getPgErrorCode } from '../utils/db-errors';
import { isPaymentManager } from '../utils/access-control.js';
import { type PaymentSyncStatus } from '@shared/schema';
import {
  markAdminEmailChangeAuditConfirmed,
} from '../storage/admin-email-change-audits';
import { createSharedRateLimitStore } from '../utils/rate-limit-store';
import { db } from '../db';
import { requireAuth, hashEmailChangeToken } from './account-shared';
import {
  applyConfirmEmailChangeTxn,
  type ConfirmEmailChangeOutcome,
} from '../services/account-lifecycle';

const log = createLogger('Account');
const router = Router();

const GENERIC_DELETION_RESPONSE = {
  success: true as const,
  data: { message: 'Deletion request received' },
};

export async function changeUserPasswordTxn(
  userId: number,
  passwordHash: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await storage.updateUser(userId, {
      password: passwordHash,
      mustChangePassword: false,
    }, tx);
    return storage.revokePendingAccountActionsForUser(
      userId,
      ['password_reset'],
      tx,
    );
  });
}

// Anti-enumeration: even when throttled, return the same generic success
// response (HTTP 200) so callers cannot distinguish accepted vs limited.
const deletionRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Task #356: shared Postgres store so the quota holds across
  // multi-replica deployments. Anti-enumeration response above is
  // unaffected.
  store: createSharedRateLimitStore('deletion-request'),
  handler: (req, res) => {
    log.warn('Deletion request throttled (per-IP limit reached)');
    res.status(200).json(GENERIC_DELETION_RESPONSE);
  },
});

const MAX_DELETION_REQUESTS_PER_EMAIL_PER_DAY = 3;

// Public: request account deletion (no auth required so departed users can submit)
router.post('/request-deletion', deletionRequestLimiter, async (req, res) => {
  try {
    const rawEmail = typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : req.body?.email;
    const parsed = insertDeletionRequestSchema.safeParse({
      email: rawEmail,
      reason: typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : null,
      // Task #349: requester can opt out of the post-deletion
      // confirmation email. Default true (matches the schema default)
      // so legacy clients that don't send the field still get email.
      notifyOnCompletion:
        typeof req.body?.notifyOnCompletion === 'boolean'
          ? req.body.notifyOnCompletion
          : true,
    });

    if (!parsed.success) {
      // Always return generic success to prevent enumeration; just log the failure.
      log.info('Deletion request rejected (invalid input)', {
        issues: parsed.error.issues.map(i => i.message),
      });
      return res.json(GENERIC_DELETION_RESPONSE);
    }

    const { email, reason, notifyOnCompletion } = parsed.data;

    // Per-email throttle on top of per-IP limiter
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await storage.countDeletionRequestsForEmailSince(email, since);
    if (recentCount >= MAX_DELETION_REQUESTS_PER_EMAIL_PER_DAY) {
      log.warn('Deletion request throttled (per-email cap reached)', { recentCount });
      return res.json(GENERIC_DELETION_RESPONSE);
    }

    const ipAddress = (req.ip ?? req.socket?.remoteAddress ?? null)?.toString().slice(0, 100) ?? null;
    const userAgent = req.headers['user-agent']?.toString().slice(0, 500) ?? null;

    const created = await storage.createDeletionRequest({
      email,
      reason: reason ?? null,
      ipAddress,
      userAgent,
      notifyOnCompletion,
    });

    log.info('Account deletion request recorded', { id: created.id });

    // Notify system admins (non-fatal)
    try {
      const allUsers = await storage.getUsers();
      const adminEmails = allUsers
        .filter(u => u.role === 'system_admin' && u.email)
        .map(u => u.email);
      if (adminEmails.length > 0) {
        await sendDeletionRequestNotification(adminEmails, {
          id: created.id,
          email: created.email,
          reason: created.reason,
          createdAt: created.createdAt,
        });
      }
    } catch (notifyError) {
      log.error('Failed to notify admins of deletion request (non-fatal):', notifyError);
    }

    return res.json(GENERIC_DELETION_RESPONSE);
  } catch (error) {
    log.error('Error processing deletion request:', error);
    // Still return generic success to avoid leaking error state
    return res.json(GENERIC_DELETION_RESPONSE);
  }
});

// Brute-force defense for the unauthenticated confirm endpoint. The 32-byte
// token space is huge but we still want guessing to be operationally
// infeasible. Keyed strictly on IP because the endpoint is unauthenticated
// (no userId is available before the token is parsed). `skipSuccessfulRequests`
// means a legitimate user clicking the link from email never burns budget —
// only failed lookups (INVALID_TOKEN / TOKEN_EXPIRED / TOKEN_CONSUMED /
// EMAIL_IN_USE — all 400) count toward the limit.
const confirmEmailChangeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // Task #356: shared Postgres store so failed-attempt budget holds
  // across multi-replica deployments.
  store: createSharedRateLimitStore('confirm-email-change'),
  // Test-only NODE_ENV-gated bypass shared with every limiter declared in
  // server/middleware/rate-limit.ts. Without this, the shared-IP bucket is
  // drained under heavy parallel CI load by the cumulative failed confirms
  // emitted by the file's other tests (the "N parallel confirms" test alone
  // burns N-1 failures), causing the race-test loser to receive 429 instead
  // of the expected 400 EMAIL_IN_USE. The dedicated limiter coverage in this
  // same file (the "trips the limiter after 30 failed confirms" / "fresh
  // window" / "skipSuccessfulRequests" tests) deliberately uses a raw
  // `postWithBucket` helper that does NOT add the bypass header, so the
  // limiter still fires for those assertions.
  skip: testBypassSkip,
  keyGenerator: (req: Request) => {
    // In non-prod, allow tests to claim an isolated bucket via header so a
    // single suite can exercise the limit without polluting (or being
    // polluted by) other tests sharing the same loopback IP. Header is
    // ignored entirely in production.
    if (process.env.NODE_ENV !== 'production') {
      const bucket = req.headers['x-test-rl-bucket'];
      if (typeof bucket === 'string' && bucket.length > 0) {
        return `test:${bucket}`;
      }
    }
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (req, res) => {
    log.warn('Email-change confirm attempts throttled', { ip: req.ip });
    return sendError(
      res,
      'Too many confirmation attempts. Please wait a few minutes and try again.',
      429,
      'RATE_LIMITED',
    );
  },
});

// Test-only: reset the limiter counter for a single bucket so tests can
// exercise the "fresh window allows requests again" behavior without
// waiting 10 minutes of wall-clock time. Available only when
// NODE_ENV !== 'production'; mounted as a sibling of the limited route.
if (process.env.NODE_ENV !== 'production') {
  router.post('/_test/reset-confirm-email-change-limit', (req, res) => {
    const bucket = req.headers['x-test-rl-bucket'];
    if (typeof bucket !== 'string' || bucket.length === 0) {
      return sendError(res, 'bucket required', 400, 'BAD_REQUEST');
    }
    confirmEmailChangeLimiter.resetKey(`test:${bucket}`);
    return sendSuccess(res, { reset: true });
  });
}

// Confirm a pending email-change request. The token itself is the
// authentication factor (like password reset), so this endpoint is open
// to unauthenticated callers — anyone who clicks the link in the
// confirmation email can complete the swap.
router.post('/confirm-email-change', confirmEmailChangeLimiter, async (req: Request, res: Response) => {
  try {
    const schema = z.object({ token: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return handleZodError(res, parsed.error);
    }

    const tokenHash = hashEmailChangeToken(parsed.data.token);

    // Atomic claim + email swap in a single transaction so we cannot leave
    // the token consumed if the email update fails (or vice versa), and
    // racing confirm calls can never both succeed. The transaction body
    // is extracted into `applyConfirmEmailChangeTxn` so the atomicity
    // contract can be pinned by a unit test against the SAME function
    // production runs — see task #494 / its sibling test file. The
    // helper also returns the claimed `requestId` on success so the
    // post-confirm code below can update the originating admin's
    // audit row (task #487).
    let outcome: ConfirmEmailChangeOutcome;
    try {
      outcome = await applyConfirmEmailChangeTxn(tokenHash);
    } catch (err) {
      // Postgres unique_violation — the new email was claimed by someone
      // else between request and confirm. Transaction rolled back, so the
      // token is still pending; we explicitly consume it now so a page
      // refresh doesn't keep retrying the same losing race.
      if (getPgErrorCode(err) === '23505') {
        // Consume only the specific token that just lost the race. Other
        // pending requests (e.g. one the user submitted after seeing the
        // first link sit in their inbox) are unaffected.
        const conflicted = await storage.getEmailChangeRequestByTokenHash(tokenHash);
        if (conflicted) {
          await storage.consumeEmailChangeRequest(conflicted.id);
        }
        return sendError(res, 'Email already in use', 400, 'EMAIL_IN_USE');
      }
      throw err;
    }

    if (outcome.kind === 'invalid') {
      return sendError(res, 'Invalid or expired confirmation link', 400, 'INVALID_TOKEN');
    }
    if (outcome.kind === 'consumed') {
      return sendError(res, 'This confirmation link has already been used', 400, 'TOKEN_CONSUMED');
    }
    if (outcome.kind === 'expired') {
      return sendError(res, 'This confirmation link has expired', 400, 'TOKEN_EXPIRED');
    }
    if (outcome.kind === 'user_gone') {
      return sendError(res, 'Account no longer exists', 404, 'USER_NOT_FOUND');
    }

    const updatedUser = outcome.user;

    let paymentSyncStatus: PaymentSyncStatus = 'not_applicable';
    // Staff accounts are never bowlers. A stale legacy link must not let an
    // email confirmation mutate a global bowler profile via provider sync.
    if (updatedUser.bowlerId && !isPaymentManager(updatedUser)) {
      const result = await syncBowlerForUser(updatedUser, {
        nameChanged: false,
        emailChanged: true,
        phoneChanged: false,
      });
      paymentSyncStatus = result;
    }

    // Re-surface the post-confirm sync result on the originating
    // admin's email-change history row (task #487). The PATCH that
    // initiated the change only triggers the payment-sync when the
    // admin also edited name/phone — for a pure email edit the actual
    // sync (and any `pending_retry`) happens HERE, after the target
    // user clicks the link. The admin never sees this confirmation
    // page, so the audit row is the only surface we have to bubble a
    // failed sync back to the admin who needs to retry it.
    //
    // Best-effort: this column is triage metadata, not part of the
    // user-visible flow. If the UPDATE throws (column missing on a
    // not-yet-migrated DB, network blip, etc.) we log and continue —
    // the email change itself has already succeeded above.
    try {
      await markAdminEmailChangeAuditConfirmed({
        emailChangeRequestId: outcome.requestId,
        status: paymentSyncStatus,
      });
    } catch (auditErr) {
      log.error('Failed to record post-confirm payment-sync status on admin audit row (non-fatal):', auditErr);
    }

    log.info('Email-change confirmed', {
      userId: updatedUser.id,
      newEmail: maskEmail(updatedUser.email),
    });

    return sendSuccess(res, { ...sanitizeUser(updatedUser), paymentSyncStatus });
  } catch (error) {
    log.error('Error confirming email change:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

// Slow down credential-stuffing / current-password brute-forcing on a
// session that's already been hijacked. Keyed on (userId|ip) so a
// single attacker can't burn through attempts on multiple accounts
// from one IP, and a single legit user behind CG-NAT isn't blocked
// by an unrelated stranger. Returns the standard 429 error shape via
// `sendError` so the existing client-side error handling keeps working.
//
// Exported for unit testing — see
// `tests/unit/change-password-rate-limit-key.test.ts`, which pins the
// IPv6 /64 collapsing so a future refactor can't reintroduce the
// `req.ip` bypass that gives every IPv6 address its own bucket.
export function changePasswordKeyGenerator(req: Request): string {
  const userId = (req.user as { id?: number } | undefined)?.id;
  if (userId) return `u:${userId}`;
  // Fall through to IP if not yet authenticated — requireAuth runs
  // AFTER this limiter, so an unauth caller still gets per-IP
  // throttling instead of bypassing the limit by omitting cookies.
  // `ipKeyGenerator` collapses IPv6 addresses down to a /64 prefix,
  // which is what blocks the "rotate addresses inside one /64 to dodge
  // the bucket" bypass that `req.ip` alone permits.
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Task #356: shared Postgres store so the per-user budget can't be
  // bypassed by spreading attempts across multiple replicas.
  store: createSharedRateLimitStore('change-password'),
  keyGenerator: changePasswordKeyGenerator,
  handler: (req, res) => {
    log.warn('Password-change attempts throttled', {
      userId: (req.user as { id?: number } | undefined)?.id,
    });
    return sendError(
      res,
      'Too many password-change attempts. Please wait a few minutes and try again.',
      429,
      'RATE_LIMITED',
    );
  },
});

// Change password for the currently authenticated user
router.post('/change-password', changePasswordLimiter, requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    const schema = z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: passwordSchema,
    });

    const validationResult = schema.safeParse(req.body);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const { currentPassword, newPassword } = validationResult.data;

    const existingUser = await storage.getUser(user.id);
    if (!existingUser) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    // Task #357: hard lockout check. If the user previously crossed the
    // failed-attempt threshold and the lock window is still in the
    // future, refuse the request without ever calling comparePasswords —
    // even a CORRECT password should bounce while the lock is active,
    // because the locking event itself is a signal that someone with
    // session access has been guessing. The user recovers via the
    // forgot-password flow (which doesn't require the old password).
    if (existingUser.passwordChangeLockedUntil) {
      const lockedUntilMs = Date.parse(existingUser.passwordChangeLockedUntil);
      if (Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now()) {
        log.warn('Change-password attempt on locked account', {
          userId: user.id,
          lockedUntil: existingUser.passwordChangeLockedUntil,
        });
        return sendError(
          res,
          'Your account is temporarily locked after too many failed password attempts. Please use the forgot-password flow to reset your password.',
          423,
          'ACCOUNT_LOCKED',
          { lockedUntil: existingUser.passwordChangeLockedUntil },
        );
      }
    }

    const isValid = await comparePasswords(currentPassword, existingUser.password);
    if (!isValid) {
      // Task #357: bump the failure counter and engage the lockout if
      // this attempt crossed the threshold. The storage helper is
      // race-safe (FOR UPDATE inside a transaction) so two concurrent
      // failures can't double-fire the side effects.
      //
      // Counter semantics — by design this is a CUMULATIVE counter
      // ("N failed attempts since the last successful change-password"
      // or since the last lock auto-expired), not a strict rolling
      // 25-in-1-hour window. The task #357 spec says "consecutive
      // failed attempts", which the cumulative model satisfies
      // exactly: any successful rotation OR an expired lock fully
      // resets the count to zero (see resetFailedPasswordChangeAttempts
      // and the expired-lock branch inside recordFailedPasswordChangeAttempt).
      // If product/security later wants a true sliding window, that
      // requires a separate timestamp-array column.
      //
      // Failure posture — if the storage helper itself throws (e.g.
      // a transient DB blip), we deliberately DEGRADE GRACEFULLY:
      // log loudly, continue with lockResult=null, and return the
      // normal INVALID_PASSWORD response. Returning 5xx here would
      // be more secure (fail-closed against brute force) but punishes
      // legitimate users mistyping during a database incident with a
      // confusing server error. The log line below is the operational
      // signal — alerting on `[SECURITY] lockout-counter-write-failed`
      // will catch sustained outages that would otherwise erode the
      // lockout guarantee.
      let lockResult: Awaited<ReturnType<typeof storage.recordFailedPasswordChangeAttempt>> | null = null;
      try {
        lockResult = await storage.recordFailedPasswordChangeAttempt(user.id);
      } catch (err) {
        log.error('[SECURITY] lockout-counter-write-failed: change-password failure was NOT counted toward the account lockout threshold. If this fires repeatedly, the lockout protection is degraded — investigate the database immediately.', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (lockResult?.justLocked) {
        const lockedUntil = lockResult.lockedUntil
          ? new Date(lockResult.lockedUntil)
          : new Date(Date.now() + PASSWORD_CHANGE_LOCKOUT_DURATION_MS);
        log.warn('Account locked after repeated failed change-password attempts', {
          userId: user.id,
          count: lockResult.count,
          lockedUntil: lockedUntil.toISOString(),
        });

        // Kill EVERY session for this user — including the caller's,
        // since the locking event itself suggests the caller may be
        // an attacker with a stolen cookie. Best-effort: a session-
        // store hiccup must not roll back the lock that already
        // committed; we log loudly and keep going.
        try {
          const dropped = await destroyAllSessionsForUser(user.id);
          if (dropped > 0) {
            log.info('Destroyed all sessions on account-lockout', {
              userId: user.id,
              count: dropped,
            });
          }
        } catch (err) {
          log.error('Failed to destroy sessions on account-lockout', {
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Fire-and-forget alert email so the user finds out they're
        // locked even if they're no longer in front of the browser
        // that triggered it. A SendGrid failure must NOT roll back
        // the lock that already committed.
        try {
          const rawUa = (req.get('user-agent') ?? '').slice(0, 256);
          void sendAccountLockoutAlert(existingUser.email, existingUser.name, {
            lockedAt: new Date(),
            unlocksAt: lockedUntil,
            ipAddress: req.ip ?? null,
            userAgent: rawUa || null,
            locale: existingUser.preferredLanguage ?? null,
          })
            .then(ok => {
              if (!ok) {
                log.warn('Account-lockout alert helper returned false', { userId: user.id });
              }
            })
            .catch(err => {
              log.error('Account-lockout alert threw unexpectedly', {
                userId: user.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        } catch (err) {
          log.error('Failed to dispatch account-lockout alert', {
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        return sendError(
          res,
          'Your account is temporarily locked after too many failed password attempts. Please use the forgot-password flow to reset your password.',
          423,
          'ACCOUNT_LOCKED',
          { lockedUntil: lockedUntil.toISOString() },
        );
      }

      return sendError(res, 'Current password is incorrect', 400, 'INVALID_PASSWORD');
    }

    const hashedNew = await hashPassword(newPassword);
    // Task #455: clear the "must change password on next sign-in"
    // flag in the SAME update as the new hash. The flag is set by
    // the admin-driven reset endpoint at server/routes/organization-
    // admin.ts; clearing it here is what lets the App.tsx route
    // guards stop redirecting the user to /change-password-required
    // on their next refetch of /api/user. We always write the flag
    // (even when it was already false) so the reset path is
    // idempotent and a stale-flag DB row from a missed migration
    // would self-heal on the user's first self-service rotation.
    await changeUserPasswordTxn(user.id, hashedNew);

    // Task #357: clean slate after a successful rotation. Wipe any
    // accumulated failure counter and clear a stale lock (the route
    // would have rejected an active lock above, so any value here is
    // either zero or expired). Best-effort: an error here must not
    // roll back the password update that already committed.
    try {
      await storage.resetFailedPasswordChangeAttempts(user.id);
    } catch (err) {
      log.error('Failed to reset failed-password-change counter after rotation', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Defense-in-depth: any in-flight email-change tokens for this user
    // may belong to an attacker who recently had access. Invalidating
    // them is part of the security contract of password change — if it
    // fails we surface the error and the caller can retry, rather than
    // silently leaving a stolen confirmation link active.
    const invalidated = await storage.invalidatePendingEmailChangeRequestsForUser(user.id);
    if (invalidated > 0) {
      log.info('Invalidated pending email-change requests on password change', {
        userId: user.id,
        count: invalidated,
      });
    }

    // Force-log-out every other session for this user. The user is
    // typically rotating their password BECAUSE they suspect another
    // device or browser was compromised; leaving stale cookies alive
    // until they expire defeats the purpose. We keep the caller's
    // current session (req.sessionID) so they don't immediately get
    // bounced from the page that just made this request.
    try {
      const currentSid = req.sessionID ?? null;
      const dropped = await destroyOtherSessionsForUser(user.id, currentSid);
      if (dropped > 0) {
        log.info('Destroyed other sessions on password change', {
          userId: user.id,
          count: dropped,
        });
      }
    } catch (err) {
      // Best-effort: a session-store failure shouldn't roll back the
      // password update that already committed. Log loudly so this
      // shows up in monitoring.
      log.error('Failed to destroy other sessions on password change', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Industry-standard "your password was just changed" notification
    // (task #353). Sent AFTER the destroy-other-sessions step so the
    // recipient's mental model lines up with what just happened: any
    // open tab that wasn't this one has been logged out, and they're
    // getting a heads-up about the change. Best-effort — a SendGrid
    // failure must not roll back the password rotation that already
    // committed; we log loudly and move on.
    try {
      // Express's `req.ip` already honors `trust proxy`. Truncate the
      // UA to a sane bound — the helper truncates again for the email
      // body, but keeping the bound tight at the call site avoids
      // logging absurdly long UAs into our own log lines.
      const rawUa = (req.get('user-agent') ?? '').slice(0, 256);
      void sendPasswordChangedNotification(existingUser.email, existingUser.name, {
        changedAt: new Date(),
        ipAddress: req.ip ?? null,
        userAgent: rawUa || null,
        // Render in the recipient's preferred language (task #410);
        // resolver falls back to English when null/unknown.
        locale: existingUser.preferredLanguage ?? null,
      })
        .then(ok => {
          if (!ok) {
            log.warn('Password-changed notification helper returned false', {
              userId: user.id,
            });
          }
        })
        .catch(err => {
          log.error('Password-changed notification threw unexpectedly', {
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      // Synchronous throw before the helper runs — extremely
      // unlikely (the helper is async and self-contained) but
      // belt-and-suspenders so a bug here can't 500 the request
      // after the password already rotated.
      log.error('Failed to dispatch password-changed notification', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return sendSuccess(res, { message: 'Password updated successfully' });
  } catch (error) {
    log.error('Error changing password:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

export default router;
