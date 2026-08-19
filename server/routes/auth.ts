import { Express, Router } from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { storage } from "../storage";
import { db } from "../db.js";
import { ACCOUNT_ACTION_TYPES, User as SelectUser, insertUserSchema } from "@shared/schema";
import { passwordSchema } from "@shared/password-validation";
import { sanitizeUser, sendSuccess, sendError, handleUserOrgError } from "../utils/api.js";
import { isDev } from "../config";
import { checkUserBelongsToOrg } from "../middleware/subdomain";
import { csrfProtection } from "../middleware/csrf";
import { createLogger } from "../logger";
import { hashPassword } from "../lib/password";
import { destroyOtherSessionsForUser } from "../auth";
import { sendTemplatedEmail, getBaseUrl, getOrgLogoUrl, sendPasswordChangedNotification } from "../services/email.js";
import { syncUserPhoneToBowler } from "../services/bowler-phone-sync.js";
import { fireBowlerExternalResync } from "../services/bowler-resync.js";
import { maskEmail } from "../utils/pii.js";
import { cacheInvalidate } from "../utils/cache.js";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";
import {
  linkUserToBowler as linkIdentityUserToBowler,
  isIdentityLinkError,
} from "../services/identity-link.js";
import { withAccountActionDeliveryLock } from "../storage/account-action-requests.js";
import { isNormalizedUserEmailConflict } from "../utils/db-errors.js";
// Same allowlist account.ts uses for /api/account/profile (task #420).
// We pull it from the password-changed email bundle directly rather
// than re-importing it from `./account` so the unauthenticated
// set-password handler doesn't drag the entire account-routes
// dependency graph (and its env-required modules) into mocked unit
// tests. Adding a translation in `password-changed.ts` automatically
// widens BOTH endpoints — same single source of truth.
import { PASSWORD_CHANGED_I18N } from "../services/email-i18n/password-changed";

const SUPPORTED_PREFERRED_LANGUAGES = Object.keys(
  PASSWORD_CHANGED_I18N,
) as ReadonlyArray<string>;

const log = createLogger("AuthRoutes");

// Task #356: every limiter below is backed by the shared Postgres
// store so quotas hold across multiple app processes / replicas.
// Each limiter MUST pass a unique `prefix` to keep its key
// namespace isolated from sibling limiters.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // The test suite logs in many times per run; rate-limiting locally
  // also makes development painful. Production keeps the limit enforced.
  skip: () => isDev,
  store: createSharedRateLimitStore('login'),
  message: {
    success: false,
    error: { message: "Too many login attempts, please try again later", code: "RATE_LIMITED" },
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  store: createSharedRateLimitStore('register'),
  message: {
    success: false,
    error: { message: "Too many requests, please try again later", code: "RATE_LIMITED" },
  },
});

const setPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Mirror the loginLimiter/registerLimiter pattern in this same file:
  // the test suite (especially the email-change suite at task #475/#494)
  // calls /api/auth/set-password multiple times per run, and at max=5 per
  // 15min the shared-IP bucket drains under heavy parallel CI load,
  // causing unrelated tests to receive 429 instead of their expected
  // status. Production keeps the limit enforced (isDev is false there);
  // no test in tests/api/ asserts a 429 from this route.
  skip: () => isDev,
  store: createSharedRateLimitStore('set-password'),
  message: {
    success: false,
    error: { message: "Too many requests, please try again later", code: "RATE_LIMITED" },
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('forgot-password'),
  message: {
    success: false,
    error: { message: "Too many password reset requests, please try again later", code: "RATE_LIMITED" },
  },
});

const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('claim'),
  message: {
    success: false,
    error: { message: "Too many requests, please try again later", code: "RATE_LIMITED" },
  },
});

export function registerAuthRoutes(app: Express): void {
  const authRouter = Router();

  authRouter.post("/register", registerLimiter, async (req, res) => {
    try {
      const organizationId = req.body.organizationId ? parseInt(req.body.organizationId) : undefined;
      if (!organizationId || Number.isNaN(organizationId)) {
        // Self-signup must always happen in an org context (subdomain).
        // The DB-side `users_role_org_required` CHECK constraint forbids
        // org-less non-admin users.
        return sendError(res, "Sign-up requires an organization context.", 400, "ORG_REQUIRED");
      }

      // Require a recognized subdomain org — registration must arrive through
      // a known tenant context (set by subdomainDetection middleware).
      if (!req.subdomainOrg) {
        return sendError(res, "Sign-up requires a valid organization context.", 400, "ORG_REQUIRED");
      }
      if (organizationId !== req.subdomainOrg.id) {
        return sendError(res, "Organization does not match the current context.", 400, "ORG_MISMATCH");
      }

      // Public-signup policy: require the org to have at least one active
      // league with allowPublicSignup=true. If the client supplies a leagueId
      // it must belong to this org and be publicly joinable.
      const leagueIdRaw = req.body.leagueId ? parseInt(req.body.leagueId) : undefined;
      const allOrgLeagues = await storage.getLeagues(organizationId);
      const publicLeagues = allOrgLeagues.filter(l => l.active !== false && l.allowPublicSignup === true);
      if (publicLeagues.length === 0) {
        return sendError(res, "This organization does not currently allow public sign-up.", 403, "SIGNUP_NOT_ALLOWED");
      }
      if (leagueIdRaw && !Number.isNaN(leagueIdRaw)) {
        const targetLeague = publicLeagues.find(l => l.id === leagueIdRaw);
        if (!targetLeague) {
          return sendError(res, "The selected league does not allow public sign-up.", 403, "SIGNUP_NOT_ALLOWED");
        }
      }

      const registrationData = {
        email: req.body.email,
        password: req.body.password,
        name: req.body.name,
        phone: req.body.phone,
        role: 'user' as const,
        organizationId,
      };

      const result = insertUserSchema.safeParse(registrationData);

      if (!result.success) {
        const validationErrors = result.error.issues.map(error => ({
          field: error.path.join('.'),
          message: error.message,
        }));
        return sendError(res, "Registration validation failed", 400, "VALIDATION_ERROR", validationErrors);
      }

      const existingUser = await storage.getUserByEmail(result.data.email);
      if (existingUser) {
        return sendError(res, "Email already registered", 400, "DUPLICATE_EMAIL");
      }

      const hashedPassword = await hashPassword(result.data.password);
      const matchingBowler = await storage.getBowlerByEmail(result.data.email, organizationId);

      let user;
      let bowlerLinked = false;
      try {
        user = await db.transaction(async (tx) => {
          let createdUser = await storage.createUser({
            ...result.data,
            password: hashedPassword,
            role: 'user',
            organizationId,
          }, tx);

          if (matchingBowler) {
            try {
              const linked = await linkIdentityUserToBowler({
                organizationId,
                userId: createdUser.id,
                bowlerId: matchingBowler.id,
                actorUserId: createdUser.id,
                source: "auth.register",
                reason: "email_match_auto_link",
                eventType: "link",
                requireEmailMatch: true,
              }, tx);
              // Return the row updated by the identity service so the new
              // login session and registration response immediately reflect
              // the committed bowler claim.
              createdUser = linked.user;
              bowlerLinked = true;
            } catch (linkError) {
              // A racing registration/invite may claim the roster row first.
              // Keep this new account unlinked, matching the historical
              // behavior, while all successful create+link writes remain one
              // transaction.
              if (!isIdentityLinkError(linkError)
                || !["BOWLER_TAKEN", "ALREADY_LINKED", "EMAIL_MISMATCH"].includes(linkError.code)) {
                throw linkError;
              }
            }
          }
          return createdUser;
        });
      } catch (createError) {
        if (isNormalizedUserEmailConflict(createError)) {
          return sendError(res, "Email already registered", 400, "DUPLICATE_EMAIL");
        }
        if (handleUserOrgError(res, createError)) return;
        throw createError;
      }
      if (bowlerLinked) {
        // The link was performed with the registration transaction's
        // executor, so the identity service deliberately deferred cache
        // invalidation until the caller's commit completed.
        cacheInvalidate(`user:${user.id}`);
      }

      try {
        if (matchingBowler && bowlerLinked) {
            // Task #677: copy the freshly-registered user's phone
            // onto the linked bowler row (user wins, since the
            // bowler typed it themselves at sign-up). Then kick the
            // existing external-resync path so payment-provider
            // attributes stay current. Both calls absorb
            // their own errors — they must NEVER block the
            // registration response.
            try {
              const syncResult = await syncUserPhoneToBowler(user.id, matchingBowler.id);
              if (syncResult.outcome === 'updated') {
                fireBowlerExternalResync(matchingBowler.id, matchingBowler.organizationId);
              }
            } catch (phoneErr) {
              log.error('Failed to sync user phone to bowler at registration:', phoneErr);
            }

            const bowlerLeagueEntries = await storage.getBowlerLeagues({ bowlerId: matchingBowler.id });
            if (bowlerLeagueEntries.length > 0) {
              const league = await storage.getLeague(bowlerLeagueEntries[0].leagueId);
              if (league?.organizationId) {
                const org = await storage.getOrganization(league.organizationId);
                const baseUrl = getBaseUrl(org ?? req.orgSlug);
                sendTemplatedEmail('self_register_linked', result.data.email, {
                  bowler_name: matchingBowler.name,
                  organization_name: org?.name || '',
                  organization_logo_url: org?.logo ? getOrgLogoUrl(org) : '',
                  league_name: league.name,
                  dashboard_link: `${baseUrl}/bowler-dashboard`,
                }).catch(err => log.error('Failed to send self_register_linked email:', err));
              }
            }
        }

        if (!bowlerLinked) {
          const baseUrl = getBaseUrl(req.orgSlug);
          sendTemplatedEmail('self_register_unlinked', result.data.email, {
            bowler_name: result.data.name,
            login_link: `${baseUrl}/login`,
          }).catch(err => log.error('Failed to send self_register_unlinked email:', err));
        }
      } catch (linkError) {
        log.error('Auto-link bowler after registration failed:', linkError);
      }

      req.login(user, (err) => {
        if (err) {
          log.error('Session creation after registration failed:', err);
          return sendError(res, "Failed to login after registration", 500, "SESSION_ERROR");
        }
        sendSuccess(res, sanitizeUser(user), 201);
      });
    } catch (error) {
      log.error('Registration error:', error);
      if (error instanceof z.ZodError) {
        return sendError(res, "Validation failed", 400, "VALIDATION_ERROR", error.issues.map(err => ({
          field: err.path.join('.'),
          message: err.message,
        })));
      }
      sendError(res, "Failed to register user", 500, "SERVER_ERROR");
    }
  });

  authRouter.post("/login", loginLimiter, (req, res, next) => {
    passport.authenticate("local", (err: unknown, user: Express.User | false, info: { message?: string } | undefined) => {
      if (err) {
        log.error('Login error:', err);
        return sendError(res, "Internal server error", 500, "SERVER_ERROR");
      }
      if (!user) {
        return sendError(res, info?.message || "Invalid credentials", 401, "INVALID_CREDENTIALS");
      }
      req.login(user, async (err) => {
        if (err) {
          log.error('Session creation error:', err);
          return sendError(res, "Failed to create session", 500, "SESSION_ERROR");
        }

        if (req.subdomainOrg && !user.organizationId) {
          try {
            await checkUserBelongsToOrg(user, req.subdomainOrg.id);
          } catch (orgErr) {
            log.error('Failed to check org on login:', orgErr);
          }
        }

        if (isDev) {
          log.info('Login successful', { userId: user.id, email: maskEmail(user.email), hostname: req.hostname, cookieDomain: req.session?.cookie?.domain || 'not set' });
        } else {
          log.info('Login successful', { userId: user.id });
        }
        sendSuccess(res, sanitizeUser(user));
      });
    })(req, res, next);
  });

  authRouter.post("/logout", csrfProtection, (req, res, next) => {
    req.logout((err) => {
      if (err) {
        log.error('Logout error:', err);
        return next(err);
      }
      sendSuccess(res, null);
    });
  });

  authRouter.get("/user", async (req, res) => {
    try {
      if (!req.isAuthenticated() || !req.user) {
        if (isDev) log.info('/api/user unauthenticated request', { hasSession: !!req.session, hasCookie: !!req.headers.cookie, hostname: req.hostname });
        return sendError(res, "Not authenticated", 401, "AUTH_REQUIRED");
      }

      const user = req.user as SelectUser;
      const subdomainOrg = req.subdomainOrg;

      if (subdomainOrg) {
        const belongs = await checkUserBelongsToOrg(user, subdomainOrg.id);
        if (!belongs) {
          return new Promise<void>((resolve) => {
            req.logout((err) => {
              if (err) log.error('Logout error in /api/auth/user org guard:', err);
              sendError(res, "Not authenticated", 401, "AUTH_REQUIRED");
              resolve();
            });
          });
        }
      }

      // Surface a persistent "payment sync pending" flag for the
      // self-serve retry button on ProfileInfoCard (#323/#363). The
      // button used to live entirely in component state, so closing
      // the tab while `payment_sync_pending_at` was set on the linked
      // bowler row hid the action on next visit even though the
      // background sweep was still trying. Hydrating from this field
      // means the button reappears on every page load until the
      // pending flag actually clears.
      //
      // Failure mode: if the bowler lookup throws (DB blip), we log
      // and return `null` rather than failing the whole /api/user
      // request — the rest of the auth response is more important
      // than the retry hint, and the next refetch will recover.
      let paymentSyncStatus: 'pending_retry' | null = null;
      if (user.bowlerId !== null && user.bowlerId !== undefined) {
        try {
          const bowler = await storage.getBowler(user.bowlerId);
          if (bowler?.paymentSyncPendingAt) {
            paymentSyncStatus = 'pending_retry';
          }
        } catch (err) {
          log.error('Failed to look up bowler for /api/user paymentSyncStatus', {
            userId: user.id,
            bowlerId: user.bowlerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      sendSuccess(res, { ...sanitizeUser(user), paymentSyncStatus });
    } catch (error) {
      log.error('Error in /api/user route:', error);
      sendError(res, "Internal server error", 500, "SERVER_ERROR");
    }
  });

  authRouter.post("/set-password", setPasswordLimiter, async (req, res) => {
    try {
      const { token, password } = req.body;

      if (typeof token !== "string" || token.length === 0 || !password) {
        return sendError(res, "Token and password are required", 400, "VALIDATION_ERROR");
      }

      const passwordResult = passwordSchema.safeParse(password);
      if (!passwordResult.success) {
        return sendError(
          res,
          passwordResult.error.issues[0]?.message ?? "Password validation failed",
          400,
          "VALIDATION_ERROR",
        );
      }

      // Task #420: invited bowlers can pick their preferred language
      // on the set-password page so the very first onboarding email
      // (the password-changed notice fired below) renders in their
      // chosen locale instead of always defaulting to English.
      //
      // Tri-state body field, mirroring the account-settings PATCH:
      //   undefined            → field omitted (legacy clients), leave the column untouched
      //   null                 → caller picked "auto / no preference", clear the column
      //   known locale code    → write the chosen language
      //
      // Anything else gets a 400 instead of being silently persisted
      // — keeps the column clean of garbage that the email helper
      // would otherwise English-fallback on, exactly like #417.
      const preferredLanguageRaw = (req.body as { preferredLanguage?: unknown })
        ?.preferredLanguage;
      let preferredLanguage: string | null | undefined;
      if (preferredLanguageRaw === undefined) {
        preferredLanguage = undefined;
      } else if (preferredLanguageRaw === null) {
        preferredLanguage = null;
      } else if (
        typeof preferredLanguageRaw === "string" &&
        SUPPORTED_PREFERRED_LANGUAGES.includes(preferredLanguageRaw)
      ) {
        preferredLanguage = preferredLanguageRaw;
      } else {
        return sendError(
          res,
          "Unsupported preferred language",
          400,
          "VALIDATION_ERROR",
        );
      }

      const actionRecord = await storage.getAccountActionByToken(token);
      if (
        !actionRecord ||
        !ACCOUNT_ACTION_TYPES.includes(actionRecord.request.action)
      ) {
        return sendError(res, "Invalid or expired invitation link", 400, "INVALID_TOKEN");
      }

      if (
        actionRecord.request.status === "expired" ||
        (actionRecord.request.status === "pending" && new Date(actionRecord.request.expiresAt) <= new Date())
      ) {
        return sendError(res, "This invitation link has expired. Please ask your administrator to resend the invite.", 400, "TOKEN_EXPIRED");
      }
      if (actionRecord.request.status !== "pending") {
        return sendError(res, "Invalid or expired invitation link", 400, "INVALID_TOKEN");
      }

      const hashedPassword = await hashPassword(password);
      // Claiming the action and rotating the password are one transaction.
      // This also supersedes every other pending credential action and
      // invalidates pending email changes. Legacy invite columns are
      // deliberately untouched during this compatibility release.
      const completed = await storage.consumeAccountActionAndSetPassword({
        token,
        passwordHash: hashedPassword,
        ...(preferredLanguage !== undefined ? { preferredLanguage } : {}),
      });
      if (!completed) {
        return sendError(res, "Invalid or expired invitation link", 400, "INVALID_TOKEN");
      }
      const user = completed.user;
      let authenticatedUser = user;

      // Task #352: force-log-out every existing session for this user.
      // The reset/set-password flow runs unauthenticated, so unlike the
      // change-password handler (#318) we have no current session to
      // preserve — the user is most likely here BECAUSE they suspect
      // a stolen device or a leaked credential, so any leftover
      // cookies must die. We pass `keepSid = null` to nuke them all;
      // the auto-login below (`req.login`) creates a fresh session
      // for the device that just completed the reset. Best-effort: a
      // session-store hiccup must not roll back the password rotation
      // that already committed.
      try {
        const dropped = await destroyOtherSessionsForUser(user.id, null);
        if (dropped > 0) {
          log.info('Destroyed all existing sessions on set-password', {
            userId: user.id,
            count: dropped,
          });
        }
      } catch (err) {
        log.error('Failed to destroy sessions on set-password', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Task #409: best-effort "your password was just changed" notice,
      // mirroring the authenticated change-password path (#353). Not
      // awaited — an outbound email failure must never roll back a
      // password rotation that already committed.
      try {
        const rawUa = (req.get('user-agent') ?? '').slice(0, 256);
        void sendPasswordChangedNotification(user.email, user.name, {
          changedAt: new Date(),
          ipAddress: req.ip ?? null,
          userAgent: rawUa || null,
          // Render in the recipient's preferred language. Prefer the
          // value the caller just submitted on this same request
          // (task #420 — invited bowlers pick their language on the
          // set-password page) over the row we loaded BEFORE the
          // update; otherwise a brand-new user who chose Spanish
          // here would still get the first email in English because
          // their stored column was null at load time. Falls back
          // to whatever was already on the row when the body
          // omits the field, and the resolver itself falls back to
          // English on null/unknown (task #410).
          locale: preferredLanguage !== undefined
            ? preferredLanguage
            : user.preferredLanguage ?? null,
        }).then(ok => {
          if (!ok) {
            log.warn('Password-changed notification returned false (set-password)', { userId: user.id });
          }
        }).catch(err => {
          log.error('Password-changed notification threw (set-password)', {
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (notifyError) {
        log.error('Failed to schedule password-changed notification (set-password)', {
          userId: user.id,
          error: notifyError instanceof Error ? notifyError.message : String(notifyError),
        });
      }

      try {
        const bowler = user.organizationId
          ? await storage.getBowlerByEmail(user.email, user.organizationId)
          : await storage.getBowlerByEmailSystemAdmin(user.email);
        if (bowler) {
          const alreadyLinked = await storage.isBowlerLinked(bowler.id);
          if (!alreadyLinked) {
            const linkOrganizationId = user.organizationId ?? bowler.organizationId;
            if (!linkOrganizationId) {
              throw new Error("Cannot auto-link a bowler without organization context");
            }
            const linkInput = {
              organizationId: linkOrganizationId,
              userId: user.id,
              bowlerId: bowler.id,
              actorUserId: user.id,
              source: "auth.set-password",
              reason: "email_match_auto_link",
              eventType: "link",
              requireEmailMatch: true,
            } as const;
            if (user.organizationId) {
              authenticatedUser = (await linkIdentityUserToBowler(linkInput)).user;
            } else {
              // One-release legacy recovery: tenant assignment, bowler link,
              // and audit event commit together instead of leaving an
              // org-bound but unlinked half-state on failure.
              authenticatedUser = await db.transaction(async (tx) => {
                await storage.setUserOrganization(user.id, linkOrganizationId, tx);
                return (await linkIdentityUserToBowler(linkInput, tx)).user;
              });
              // The identity service cannot invalidate while it is using a
              // caller-owned transaction. Invalidate only after the outer
              // transaction has committed so readers do not observe a stale
              // org/bowler association.
              cacheInvalidate(`user:${authenticatedUser.id}`);
            }
          }
        }
      } catch (linkError) {
        log.error('Auto-link bowler after set-password failed:', linkError);
      }

      req.login(authenticatedUser, (err) => {
        if (err) {
          log.error('Auto-login after password set failed:', err);
          return sendSuccess(res, { message: "Password set successfully. Please log in." });
        }
        sendSuccess(res, sanitizeUser(authenticatedUser));
      });
    } catch (error) {
      log.error('Set password error:', error);
      sendError(res, "Failed to set password", 500, "SERVER_ERROR");
    }
  });

  authRouter.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return sendError(res, "Email is required", 400, "VALIDATION_ERROR");
      }

      sendSuccess(res, { message: "If an account exists with that email, a password reset link has been sent." });

      try {
        const user = await storage.getUserByEmail(email.trim().toLowerCase());
        if (!user) return;
        if (!user.password) return;

        await withAccountActionDeliveryLock(user.id, "password_reset", async () => {
          const expiry = new Date(Date.now() + 60 * 60 * 1000);
          const issued = await storage.issueAccountAction({
            userId: user.id,
            action: "password_reset",
            expiresAt: expiry,
            organizationId: user.organizationId,
          });
          const token = issued.token;

          const org = user.organizationId ? await storage.getOrganization(user.organizationId) : null;
          const baseUrl = getBaseUrl(org);
          const resetUrl = `${baseUrl}/set-password?token=${token}`;
          const firstName = user.name?.split(' ')[0] || user.email;

          let sent = false;
          try {
            sent = await sendTemplatedEmail('password_reset', user.email, {
              bowler_name: firstName,
              reset_link: resetUrl,
              // Existing password_reset templates may use the legacy invite
              // variable shared with onboarding emails.
              invite_link: resetUrl,
              organization_name: org?.name || 'LeagueVault',
            });
          } catch (deliveryError) {
            log.error('Password reset templated delivery failed:', deliveryError);
          }

          if (!sent) {
            const { sendPasswordResetFallbackEmail } = await import('../services/email.js');
            try {
              sent = await sendPasswordResetFallbackEmail(user.email, firstName || 'there', token, org?.subdomain || org?.slug);
            } catch (deliveryError) {
              log.error('Password reset fallback delivery failed:', deliveryError);
            }
          }

          await storage.updateAccountActionDeliveryStatus(
            issued.request.id,
            sent ? "sent" : "failed",
          );
          log.info('Password reset delivery attempted', { userId: user.id, sent });
        });
      } catch (bgError) {
        log.error('Failed to process forgot-password request:', bgError);
      }
    } catch (error) {
      log.error('Forgot password error:', error);
      sendError(res, "Something went wrong", 500, "SERVER_ERROR");
    }
  });

  authRouter.post("/claim-bowler", claimLimiter, csrfProtection, async (req, res) => {
    try {
      if (!req.isAuthenticated() || !req.user) {
        return sendError(res, "Not authenticated", 401, "AUTH_REQUIRED");
      }

      const user = req.user as SelectUser;

      if (user.bowlerId) {
        return sendError(res, "You are already linked to a bowler", 400, "ALREADY_LINKED");
      }

      const { bowlerId } = req.body;
      if (!bowlerId || typeof bowlerId !== 'number') {
        return sendError(res, "Valid bowler ID is required", 400, "VALIDATION_ERROR");
      }

      const bowler = await storage.getBowler(bowlerId);
      if (!bowler) {
        return sendError(res, "Bowler not found", 404, "NOT_FOUND");
      }

      // Org membership gate.
      if (!user.organizationId || bowler.organizationId !== user.organizationId) {
        return sendError(res, "You don't have access to this bowler", 403, "FORBIDDEN");
      }

      // Email ownership proof — required for all targets, including blank-email
      // bowlers. Without an email match, there is no shared secret to verify
      // the caller owns this profile. An admin must set the bowler's email first.
      if (!bowler.email || bowler.email.trim() === '') {
        return sendError(res, "This bowler profile has no email address on record. Please contact your league administrator to link your account.", 403, "FORBIDDEN");
      }
      if (bowler.email.toLowerCase().trim() !== user.email.toLowerCase().trim()) {
        return sendError(res, "You can only claim a bowler profile that matches your email address", 403, "FORBIDDEN");
      }

      const alreadyLinked = await storage.isBowlerLinked(bowlerId);
      if (alreadyLinked) {
        return sendError(res, "This bowler is already linked to another account", 400, "ALREADY_LINKED");
      }

      try {
        await linkIdentityUserToBowler({
          organizationId: user.organizationId,
          userId: user.id,
          bowlerId,
          actorUserId: user.id,
          source: "auth.claim-bowler",
          reason: "email_ownership_claim",
          eventType: "link",
          requireEmailMatch: true,
        });
      } catch (linkError) {
        if (isIdentityLinkError(linkError)) {
          if (linkError.code === "BOWLER_TAKEN" || linkError.code === "ALREADY_LINKED") {
            return sendError(res, "This bowler is already linked to another account", 400, "ALREADY_LINKED");
          }
          if (linkError.code === "CROSS_ORG_DENIED" || linkError.code === "ORG_REQUIRED" || linkError.code === "ELEVATED_ROLE_DENIED" || linkError.code === "EMAIL_MISMATCH") {
            return sendError(res, "You don't have access to this bowler", 403, "FORBIDDEN");
          }
          if (linkError.code === "BOWLER_NOT_FOUND") {
            return sendError(res, "Bowler not found", 404, "NOT_FOUND");
          }
        }
        throw linkError;
      }
      await storage.updateBowler(bowlerId, { ...bowler, email: user.email });

      const bowlerLeagueEntries = await storage.getBowlerLeagues({ bowlerId });
      if (bowlerLeagueEntries.length > 0) {
        const league = await storage.getLeague(bowlerLeagueEntries[0].leagueId);
        if (league?.organizationId) {
          const [, org] = await Promise.all([
            !user.organizationId
              ? storage.setUserOrganization(user.id, league.organizationId)
              : Promise.resolve(null),
            storage.getOrganization(league.organizationId),
          ]);
          const baseUrl = getBaseUrl(org ?? req.orgSlug);
          sendTemplatedEmail('bowler_claimed', user.email, {
            bowler_name: bowler.name,
            organization_name: org?.name || '',
            organization_logo_url: org?.logo ? getOrgLogoUrl(org) : '',
            league_name: league.name,
            dashboard_link: `${baseUrl}/bowler-dashboard`,
          }).catch(err => log.error('Failed to send bowler_claimed email:', err));
        }
      }

      const updatedUser = await storage.getUser(user.id);
      sendSuccess(res, sanitizeUser(updatedUser!));
    } catch (error) {
      log.error('Claim bowler error:', error);
      sendError(res, "Failed to claim bowler", 500, "SERVER_ERROR");
    }
  });

  authRouter.get("/validate-invite", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (typeof token !== "string" || token.length === 0) {
        return sendError(res, "Token is required", 400, "VALIDATION_ERROR");
      }

      const actionRecord = await storage.getAccountActionByToken(token);
      if (
        !actionRecord ||
        actionRecord.request.action !== "account_invite"
      ) {
        return sendError(res, "Invalid invitation link", 400, "INVALID_TOKEN");
      }

      if (
        actionRecord.request.status === "expired" ||
        (actionRecord.request.status === "pending" && new Date(actionRecord.request.expiresAt) <= new Date())
      ) {
        return sendError(res, "This invitation link has expired", 400, "TOKEN_EXPIRED");
      }
      if (actionRecord.request.status !== "pending") {
        return sendError(res, "Invalid invitation link", 400, "INVALID_TOKEN");
      }

      // Token-gated, but the link can still be forwarded (family
      // member, browser sync, support-ticket screenshot). Return
      // only the masked email so the form can confirm "this link
      // is for you" without disclosing the full address or the
      // user's name to anyone who reads the URL over their
      // shoulder. The bearer of a valid token can already complete
      // signup; this avoids broadening that disclosure.
      return sendSuccess(res, { email: maskEmail(actionRecord.user.email) });
    } catch (error) {
      log.error('Validate invite error:', error);
      sendError(res, "Failed to validate invite", 500, "SERVER_ERROR");
    }
  });

  app.use('/api/auth', authRouter);
}
