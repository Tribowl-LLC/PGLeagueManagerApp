import { Express, Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import passport from "passport";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { storage } from "../storage";
import { db } from "../db.js";
import { ACCOUNT_ACTION_TYPES, User as SelectUser, emailSchema, nameSchema, accountActionRequests, accountActionDeliveryJobs, accountEmailDeliveryEvents } from "@shared/schema";
import { passwordSchema } from "@shared/password-validation";
import { sanitizeUser, sendSuccess, sendError, handleUserOrgError } from "../utils/api.js";
import { isDev } from "../config";
import { checkUserBelongsToOrg } from "../middleware/subdomain";
import { csrfProtection } from "../middleware/csrf";
import { createLogger } from "../logger";
import { hashPassword } from "../lib/password";
import { destroyOtherSessionsForUser } from "../auth";
import { sendTemplatedEmail, getBaseUrl, getOrgLogoUrl, sendPasswordChangedNotification } from "../services/email.js";
import { maskEmail } from "../utils/pii.js";
import { cacheInvalidate } from "../utils/cache.js";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";
import {
  linkUserToBowler as linkIdentityUserToBowler,
  isIdentityLinkError,
} from "../services/identity-link.js";
import {
  type AccountActionWithUser,
} from "../storage/account-action-requests.js";
import { enqueuePasswordResetDelivery, enqueueAccountRegistrationDelivery } from "../storage/account-action-delivery-jobs.js";
import { notifyAccountActionDeliveryChanged } from "../services/account-action-delivery-scheduler.js";
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
const MAX_ACCOUNT_ACTION_TOKEN_LENGTH = 256;

type AccountActionErrorCode =
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "TOKEN_USED"
  | "TOKEN_SUPERSEDED"
  | "TOKEN_REVOKED";

type AccountActionEligibility =
  | {
      valid: true;
      record: AccountActionWithUser;
      action: (typeof ACCOUNT_ACTION_TYPES)[number];
    }
  | {
      valid: false;
      record?: AccountActionWithUser;
      code: AccountActionErrorCode;
    };

const ACCOUNT_ACTION_ERROR_MESSAGES: Record<AccountActionErrorCode, string> = {
  INVALID_TOKEN: "Invalid or expired link",
  TOKEN_EXPIRED: "This link has expired",
  TOKEN_USED: "This link has already been used",
  TOKEN_SUPERSEDED: "This link has been replaced",
  TOKEN_REVOKED: "This link has been revoked",
};

/**
 * Apply the same allowlist and lifecycle rules to both the landing-page
 * validator and the password-submission route. The storage transaction still
 * rechecks these rules when it consumes the action; this helper only decides
 * what a caller may be told before that transaction runs.
 */
function getAccountActionEligibility(
  record: AccountActionWithUser | undefined,
): AccountActionEligibility {
  if (!record || !ACCOUNT_ACTION_TYPES.includes(record.request.action)) {
    return { valid: false, record, code: "INVALID_TOKEN" };
  }

  if (record.request.status === "expired") {
    return { valid: false, record, code: "TOKEN_EXPIRED" };
  }

  if (
    record.request.status === "pending"
    && new Date(record.request.expiresAt) <= new Date()
  ) {
    return { valid: false, record, code: "TOKEN_EXPIRED" };
  }

  switch (record.request.status) {
    case "consumed":
      return { valid: false, record, code: "TOKEN_USED" };
    case "superseded":
      return { valid: false, record, code: "TOKEN_SUPERSEDED" };
    case "revoked":
      return { valid: false, record, code: "TOKEN_REVOKED" };
    case "pending":
      return { valid: true, record, action: record.request.action };
    default:
      return { valid: false, record, code: "INVALID_TOKEN" };
  }
}

function sendAccountActionError(
  res: Parameters<typeof sendError>[0],
  eligibility: Extract<AccountActionEligibility, { valid: false }>,
) {
  return sendError(
    res,
    ACCOUNT_ACTION_ERROR_MESSAGES[eligibility.code],
    400,
    eligibility.code,
  );
}

function logAccountActionOutcome(
  event: "validation" | "consumption",
  record: AccountActionWithUser | undefined,
  reason: string,
): void {
  // Action IDs are operational identifiers, not bearer material. Keep these
  // events free of raw tokens, email addresses, and user IDs.
  log.info(`Account action ${event}`, {
    actionId: record?.request.id ?? null,
    reason,
  });
}

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

const validateInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Validation is safe to retry while a page is loading, but a bounded
  // shared quota keeps this token lookup from becoming an oracle or a cheap
  // database amplifier. Keep it above the submission quota for shared links.
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  store: createSharedRateLimitStore('validate-invite'),
  message: {
    success: false,
    error: { message: "Too many validation requests, please try again later", code: "RATE_LIMITED" },
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

  const registrationSession = (req: Request) => req.session.pendingRegistration;
  const registrationGenericMessage = "If this email can be used for registration, a setup link will be sent.";

  // Email-first registration deliberately has no password field. The
  // placeholder hash makes the account non-loginable until the email action
  // is consumed; it is never returned to the browser or sent to a provider.
  authRouter.post("/register", registerLimiter, async (req, res) => {
    try {
      const organizationId = req.body?.organizationId ? Number.parseInt(String(req.body.organizationId), 10) : undefined;
      if (!organizationId || !Number.isSafeInteger(organizationId)) {
        return sendError(res, "Sign-up requires an organization context.", 400, "ORG_REQUIRED");
      }
      if (!req.subdomainOrg) {
        return sendError(res, "Sign-up requires a valid organization context.", 400, "ORG_REQUIRED");
      }
      if (organizationId !== req.subdomainOrg.id) {
        return sendError(res, "Organization does not match the current context.", 400, "ORG_MISMATCH");
      }

      const leagueId = req.body?.leagueId ? Number.parseInt(String(req.body.leagueId), 10) : undefined;
      const publicLeagues = (await storage.getLeagues(organizationId))
        .filter((league) => league.active !== false && league.allowPublicSignup === true);
      if (publicLeagues.length === 0) {
        return sendError(res, "This organization does not currently allow public sign-up.", 403, "SIGNUP_NOT_ALLOWED");
      }
      if (!leagueId || !Number.isSafeInteger(leagueId) || !publicLeagues.some((league) => league.id === leagueId)) {
        return sendError(res, "The selected league does not allow public sign-up.", 403, "SIGNUP_NOT_ALLOWED");
      }

      const registrationSchema = z.object({
        email: emailSchema,
        name: nameSchema,
        phone: z.string().min(1).max(50),
      });
      const result = registrationSchema.safeParse({
        email: typeof req.body?.email === "string" ? req.body.email.trim() : req.body?.email,
        name: req.body?.name,
        phone: req.body?.phone,
      });
      if (!result.success) {
        return sendError(res, "Registration validation failed", 400, "VALIDATION_ERROR", result.error.issues.map((error) => ({
          field: error.path.join('.'),
          message: error.message,
        })));
      }
      const email = result.data.email.trim().toLowerCase();
      // A new form submission replaces any prior anonymous capability. This
      // prevents the waiting page from resurfacing an older address after a
      // user corrects it or submits an address already belonging to an
      // account.
      req.session.pendingRegistration = undefined;

      // Existing accounts are protected and indistinguishable from unknown
      // addresses. No action is created and no account/profile is mutated.
      if (await storage.getUserByEmail(email)) {
        return sendSuccess(res, { status: "pending", email: maskEmail(email), message: registrationGenericMessage }, 202);
      }

      const placeholderPassword = await hashPassword(randomBytes(32).toString("hex"));
      let user: SelectUser;
      let delivery: Awaited<ReturnType<typeof enqueueAccountRegistrationDelivery>>;
      try {
        ({ user, delivery } = await db.transaction(async (tx) => {
          const createdUser = await storage.createUser({
            email,
            name: result.data.name,
            phone: result.data.phone,
            password: placeholderPassword,
            role: "user",
            organizationId,
            bowlerId: null,
          }, tx);
          const queued = await enqueueAccountRegistrationDelivery({
            userId: createdUser.id,
            organizationId,
            credentialGeneration: createdUser.credentialGeneration,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }, tx);
          return { user: createdUser, delivery: queued };
        }));
      } catch (createError) {
        if (isNormalizedUserEmailConflict(createError)) {
          return sendSuccess(res, { status: "pending", email: maskEmail(email), message: registrationGenericMessage }, 202);
        }
        if (handleUserOrgError(res, createError)) return;
        throw createError;
      }

      req.session.pendingRegistration = {
        userId: user.id,
        organizationId,
        credentialGeneration: user.credentialGeneration,
        createdAt: Date.now(),
      };
      if (delivery.kind === "enqueued") notifyAccountActionDeliveryChanged();
      return sendSuccess(res, {
        status: "pending",
        email: maskEmail(email),
        message: registrationGenericMessage,
      }, 202);
    } catch (error) {
      log.error("Registration error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, "Unable to start registration. Please try again.", 503, "RETRYABLE_ERROR");
    }
  });

  async function getRegistrationContext(req: Request) {
    const pending = registrationSession(req);
    if (
      !pending
      || !Number.isSafeInteger(pending.userId)
      || !Number.isSafeInteger(pending.organizationId)
      || !Number.isSafeInteger(pending.credentialGeneration)
      || pending.createdAt < Date.now() - 7 * 24 * 60 * 60 * 1000
      || !req.subdomainOrg
      || req.subdomainOrg.id !== pending.organizationId
    ) return undefined;
    const user = await storage.getUser(pending.userId);
    if (
      !user
      || user.role !== "user"
      || user.organizationId !== pending.organizationId
      || user.credentialGeneration !== pending.credentialGeneration
    ) return undefined;
    const [origin] = await db
      .select({
        jobId: accountActionDeliveryJobs.id,
        userId: accountActionDeliveryJobs.userId,
        organizationId: accountActionDeliveryJobs.organizationId,
        credentialGeneration: accountActionDeliveryJobs.credentialGeneration,
        action: accountActionDeliveryJobs.action,
        status: accountActionDeliveryJobs.status,
        attemptCount: accountActionDeliveryJobs.attemptCount,
        lastErrorCode: accountActionDeliveryJobs.lastErrorCode,
        expiresAt: accountActionDeliveryJobs.expiresAt,
      })
      .from(accountActionDeliveryJobs)
      .where(and(
        eq(accountActionDeliveryJobs.userId, user.id),
        eq(accountActionDeliveryJobs.action, "account_registration"),
      ))
      .orderBy(desc(accountActionDeliveryJobs.createdAt), desc(accountActionDeliveryJobs.id))
      .limit(1);
    if (
      !origin
      || origin.userId !== user.id
      || origin.action !== "account_registration"
      || origin.organizationId !== pending.organizationId
      || origin.credentialGeneration !== user.credentialGeneration
    ) return undefined;
    return { pending, user, origin };
  }

  authRouter.get("/registration/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const context = await getRegistrationContext(req);
      if (!context) {
        res.set("Cache-Control", "no-store");
        return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
      }
      const [latestAction] = await db
        .select({
          id: accountActionRequests.id,
          status: accountActionRequests.status,
          deliveryStatus: accountActionRequests.deliveryStatus,
          expiresAt: accountActionRequests.expiresAt,
          deliveryJobId: accountActionRequests.deliveryJobId,
        })
        .from(accountActionRequests)
        .where(and(
          eq(accountActionRequests.deliveryJobId, context.origin.jobId),
          eq(accountActionRequests.action, "account_registration"),
        ))
        .orderBy(desc(accountActionRequests.createdAt), desc(accountActionRequests.id))
        .limit(1);
      const [latestEvent] = latestAction?.deliveryJobId
        ? await db
          .select({ eventType: accountEmailDeliveryEvents.eventType, providerEventAt: accountEmailDeliveryEvents.providerEventAt })
          .from(accountEmailDeliveryEvents)
          .where(and(
            eq(accountEmailDeliveryEvents.accountActionId, latestAction.id),
            eq(accountEmailDeliveryEvents.accountDeliveryJobId, latestAction.deliveryJobId),
          ))
          .orderBy(desc(accountEmailDeliveryEvents.providerEventAt), desc(accountEmailDeliveryEvents.id))
          .limit(1)
        : [];
      const providerEvent = latestEvent?.eventType ?? null;
      // A provider callback is the strongest signal. Without one, only the
      // bounded known-unsent classifications may be shown as confirmed
      // failure; timeouts, network errors, and server failures stay unknown.
      const knownUnsentRegistrationFailures = new Set([
        "not_configured",
        "render_error",
        "provider_rejected",
        "provider_rate_limited",
      ]);
      const knownUnsentFailure = knownUnsentRegistrationFailures.has(
        context.origin.lastErrorCode?.trim().toLowerCase() ?? "",
      );
      const deliveryState = providerEvent
        ?? (context.origin.status === "retry_scheduled" ? "unknown" : null)
        ?? (context.origin.status === "failed" && latestAction?.deliveryStatus !== "sent"
          ? knownUnsentFailure ? "failed" : "unknown"
          : null)
        ?? latestAction?.deliveryStatus
        ?? "not_attempted";
      return sendSuccess(res, {
        status: "pending",
        email: maskEmail(context.user.email),
        actionStatus: latestAction?.status ?? "pending",
        deliveryStatus: deliveryState,
        deliveryEvidence: providerEvent,
        expiresAt: latestAction?.expiresAt ?? context.origin.expiresAt,
        deliveryJobStatus: context.origin.status,
        deliveryAttemptCount: context.origin.attemptCount,
        deliveryLastErrorCode: context.origin.lastErrorCode,
        providerDeliveryEvent: latestEvent?.eventType ?? null,
        providerDeliveryEventAt: latestEvent?.providerEventAt ?? null,
      });
    } catch (error) {
      log.error("Registration status error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, "Registration status is temporarily unavailable.", 503, "RETRYABLE_ERROR");
    }
  });

  authRouter.post("/registration/resend", registerLimiter, async (req, res) => {
    try {
      const context = await getRegistrationContext(req);
      if (!context) {
        res.set("Cache-Control", "no-store");
        return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
      }
      const delivery = await enqueueAccountRegistrationDelivery({
        userId: context.user.id,
        organizationId: context.pending.organizationId,
        credentialGeneration: context.user.credentialGeneration,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      if (delivery.kind === "suppressed" && delivery.reason === "recently_delivered") {
        res.set("Cache-Control", "no-store");
        res.set("Retry-After", "300");
        return sendError(res, "Please wait before requesting another setup link.", 429, "RESEND_COOLDOWN");
      }
      if (delivery.kind === "enqueued") notifyAccountActionDeliveryChanged();
      res.set("Cache-Control", "no-store");
      return sendSuccess(res, { status: "pending", message: registrationGenericMessage }, 202);
    } catch (error) {
      log.error("Registration resend error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, "Unable to resend the setup link. Please try again.", 503, "RETRYABLE_ERROR");
    }
  });

  // Correcting an address starts a fresh public registration. The original
  // pending account remains untouched: in particular, this route never
  // changes its email, profile fields, credential generation, or delivery
  // actions. Clearing this narrowly scoped session capability is all that is
  // needed before the client returns to the sign-up form.
  authRouter.post("/registration/abandon", csrfProtection, async (req, res) => {
    req.session.pendingRegistration = undefined;
    res.set("Cache-Control", "no-store");
    return sendSuccess(res, { status: "abandoned" });
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
        log.error('Logout error:', { name: err instanceof Error ? err.name : 'UnknownError' });
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

      // Passport deserializes the session from a cached snapshot. Re-read
      // the authoritative row before any tenant check or serialization so a
      // deleted account cannot continue to authenticate with stale session
      // data, and pending/link state is visible immediately after an admin
      // assignment.
      const sessionUser = req.user as SelectUser;
      const user = await storage.getUser(sessionUser.id);
      if (!user) {
        return new Promise<void>((resolve) => {
          req.logout((err) => {
            if (err) log.error('Logout error in /api/auth/user deleted-account guard:', err);
            sendError(res, "Not authenticated", 401, "AUTH_REQUIRED");
            resolve();
          });
        });
      }
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
      const body = req.body && typeof req.body === "object"
        ? req.body as { token?: unknown; password?: unknown; preferredLanguage?: unknown }
        : {};
      const { token, password } = body;

      if (
        typeof token !== "string"
        || token.length === 0
        || token.length > MAX_ACCOUNT_ACTION_TOKEN_LENGTH
        || !password
      ) {
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
      const preferredLanguageRaw = body.preferredLanguage;
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
      const eligibility = getAccountActionEligibility(actionRecord);
      if (!eligibility.valid) {
        logAccountActionOutcome("consumption", eligibility.record, eligibility.code);
        return sendAccountActionError(res, eligibility);
      }

      const hashedPassword = await hashPassword(passwordResult.data);
      // Claiming the action and rotating the password are one transaction.
      // This also supersedes every other pending credential action and
      // invalidates pending email changes.
      const completed = await storage.consumeAccountActionAndSetPassword({
        token,
        passwordHash: hashedPassword,
        ...(preferredLanguage !== undefined ? { preferredLanguage } : {}),
      });
      if (!completed) {
        logAccountActionOutcome("consumption", eligibility.record, "no_longer_eligible");
        return sendError(res, ACCOUNT_ACTION_ERROR_MESSAGES.INVALID_TOKEN, 400, "INVALID_TOKEN");
      }
      const user = completed.user;
      const isInvitation = completed.request.action === "account_invite";
      const isRegistration = completed.request.action === "account_registration";
      let authenticatedUser = user;

      // Task #352: force-log-out every existing session for this user.
      // The reset/set-password flow runs unauthenticated, so unlike the
      // change-password handler (#318) we have no current session to
      // preserve — the user is most likely here BECAUSE they suspect
      // a stolen device or a leaked credential, so any leftover
      // cookies must die. We pass `keepSid = null` to nuke them all.
      // Best-effort: a session-store hiccup must not roll back the password
      // rotation that already committed.
      if (!isRegistration) try {
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

      if (isInvitation) {
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
      }

      if (isRegistration) {
        // The anonymous pending capability has served its purpose. Do not
        // leave it alongside the authenticated Passport session.
        req.session.pendingRegistration = undefined;
      }

      logAccountActionOutcome("consumption", completed, "password_changed");
      if (!isInvitation && !isRegistration) {
        return sendSuccess(res, { message: "Password set successfully. Please log in." });
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
    // Bound ordinary lookup/enqueue timing differences without holding a DB
    // connection while waiting. The rate limiter remains the abuse boundary.
    const responseNotBefore = Date.now() + 250;
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return sendError(res, "Email is required", 400, "VALIDATION_ERROR");
      }

      const user = await storage.getUserByEmail(email.trim().toLowerCase());
      if (user?.password) {
        // Commit the non-secret intent before acknowledging the request. A
        // process crash after the response cannot silently lose this email.
        const result = await enqueuePasswordResetDelivery({
          userId: user.id,
          organizationId: user.organizationId,
          credentialGeneration: user.credentialGeneration,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        if (result.kind === "enqueued") {
          notifyAccountActionDeliveryChanged();
          log.info("Password-reset delivery queued", { jobId: result.job.id });
        } else {
          log.info("Password-reset delivery suppressed", { reason: result.reason });
        }
      }
      const remaining = responseNotBefore - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      sendSuccess(res, { message: "If an account exists with that email, a password reset link will be sent." });
    } catch (error) {
      log.error('Forgot password request failed', { errorType: error instanceof Error ? error.name : 'unknown' });
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

  authRouter.get("/validate-invite", validateInviteLimiter, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (
        typeof token !== "string"
        || token.length === 0
        || token.length > MAX_ACCOUNT_ACTION_TOKEN_LENGTH
      ) {
        return sendError(res, "Token is required", 400, "VALIDATION_ERROR");
      }

      const actionRecord = await storage.getAccountActionByToken(token);
      const eligibility = getAccountActionEligibility(actionRecord);
      if (!eligibility.valid) {
        logAccountActionOutcome("validation", eligibility.record, eligibility.code);
        return sendAccountActionError(res, eligibility);
      }

      // Token-gated, but the link can still be forwarded (family
      // member, browser sync, support-ticket screenshot). Return
      // only the masked email so the form can confirm "this link
      // is for you" without disclosing the full address or the
      // user's name to anyone who reads the URL over their
      // shoulder. The bearer of a valid token can already complete
      // signup; this avoids broadening that disclosure.
      logAccountActionOutcome("validation", eligibility.record, "eligible");
      return sendSuccess(res, {
        email: maskEmail(eligibility.record.user.email),
        action: eligibility.action,
      });
    } catch (error) {
      log.error('Validate invite error:', error);
      sendError(res, "Failed to validate invite", 500, "SERVER_ERROR");
    }
  });

  app.use('/api/auth', authRouter);
}
