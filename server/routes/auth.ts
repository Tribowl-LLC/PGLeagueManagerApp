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
import { env, isDev, isSingletonOrganizationMode } from "../config";
import { checkUserBelongsToOrg } from "../middleware/subdomain";
import { hasConfiguredOrganizationMembership } from "../middleware/organization";
import { csrfProtection } from "../middleware/csrf";
import { createLogger } from "../logger";
import { hashPassword } from "../lib/password";
import { destroyOtherSessionsForUser } from "../auth";
import { sendPasswordChangedNotification } from "../services/email.js";
import { maskEmail } from "../utils/pii.js";
import { cacheInvalidate } from "../utils/cache.js";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";
import {
  linkUserToBowler as linkIdentityUserToBowler,
  isIdentityLinkError,
} from "../services/identity-link.js";
import { notifyPaymentSyncRetryChanged } from "../services/payment-sync-retry-scheduler";
import {
  type AccountActionWithUser,
} from "../storage/account-action-requests.js";
import {
  enqueuePasswordResetDelivery,
  enqueueAccountRegistrationDelivery,
  resumePendingAccountRegistration,
} from "../storage/account-action-delivery-jobs.js";
import { enqueueAccountGuidanceNotice } from "../storage/account-guidance-delivery-jobs.js";
import { notifyAccountActionDeliveryChanged } from "../services/account-action-delivery-scheduler.js";
import { isNormalizedUserEmailConflict } from "../utils/db-errors.js";
import { phoneSchema } from "@shared/schema/constants";
import {
  createRegistrationChallenge,
  acquireRegistrationProviderLease,
  releaseRegistrationProviderLease,
  getRegistrationChallengeForSession,
  markRegistrationChallengeVerified,
  markRegistrationVerificationSent,
  markRegistrationRecoverySent,
  cancelRegistrationChallenge,
  recordRegistrationVerificationAttempt,
  registrationChallengePhase,
  challengeResendCooldownSeconds,
  RegistrationDeliveryLimitExceededError,
  RegistrationVerificationAttemptsExceededError,
  RegistrationChallengeError,
} from "../storage/registration-verification-challenges.js";
import {
  completeRegistration,
  isPasswordValidForRegistration,
  maskRegistrationPhone,
  normalizeRegistrationPhone,
  RegistrationExistingAccountError,
  RegistrationPasswordError,
} from "../services/registration-verification.js";
import { getTwilioVerifyAdapter, TwilioVerifyError } from "../services/twilio-verify.js";
import { hasActiveIdentitySecurityHold } from "../storage/profile-claim-notifications.js";
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

function requestHostname(req: Request): string {
  const hostname = (req.hostname || req.get("host") || "").trim().toLowerCase();
  // Express normally removes the port from req.hostname. Keep the fallback
  // safe for the direct-router/unit-test case and for IPv6 loopback.
  if (hostname.startsWith("[")) {
    const closingBracket = hostname.indexOf("]");
    return closingBracket >= 0 ? hostname.slice(1, closingBracket) : hostname;
  }
  return hostname.replace(/:\d+$/, "");
}

function isCanonicalRegistrationHost(req: Request): boolean {
  const hostname = requestHostname(req);
  const appDomain = typeof env.APP_DOMAIN === "string" ? env.APP_DOMAIN.toLowerCase() : null;
  if (appDomain && (hostname === appDomain || hostname === `www.${appDomain}`)) return true;

  // Local development/test traffic has no DNS subdomain, so loopback is the
  // explicit equivalent of the canonical root. Never extend this exception to
  // production or to arbitrary hosts.
  return isDev && ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function registrationHostMatchesOrganization(req: Request, organizationId: number): boolean {
  if (req.subdomainOrg) return req.subdomainOrg.id === organizationId;
  // subdomainDetection leaves an unknown tenant slug in orgSlug. It must not
  // fall through as if it were the root host when the lookup returned null.
  if (req.orgSlug) return false;
  return isCanonicalRegistrationHost(req);
}

const registrationUnavailableMessage = "Sign-up is temporarily unavailable. Please try again later.";

/**
 * Resolve the registration tenant from trusted request context only. A tenant
 * hostname is reloaded so an archived organization cannot continue to accept
 * registrations through a stale middleware object. The canonical root has no
 * tenant hint, so it is usable only while exactly one active organization is
 * configured; the bounded lookup deliberately does not reveal the count.
 */
async function resolveRegistrationOrganization(req: Request) {
  if (req.subdomainOrg) {
    const organization = await storage.getOrganization(req.subdomainOrg.id);
    return organization?.id === req.subdomainOrg.id && organization.active === true
      ? organization
      : undefined;
  }
  if (req.orgSlug || !isCanonicalRegistrationHost(req)) return undefined;

  const activeOrganizations = await storage.getActiveOrganizations();
  return activeOrganizations.length === 1 && activeOrganizations[0]?.active === true
    ? activeOrganizations[0]
    : undefined;
}

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

type SmsRegistrationSession = {
  challengeId: string;
  organizationId: number;
  bindingSecret: string;
  createdAt: number;
};

function smsRegistrationSession(req: Request): SmsRegistrationSession | undefined {
  const capability = req.session.registrationChallenge;
  if (
    !capability
    || typeof capability.challengeId !== "string"
    || !/^[a-f0-9]{64}$/i.test(capability.challengeId)
    || !Number.isSafeInteger(capability.organizationId)
    || capability.organizationId <= 0
    || typeof capability.bindingSecret !== "string"
    || !/^[a-f0-9]{64}$/i.test(capability.bindingSecret)
    || !Number.isSafeInteger(capability.createdAt)
  ) return undefined;
  return capability;
}

function registrationChallengeErrorResponse(
  res: Parameters<typeof sendError>[0],
  error: unknown,
): boolean {
  if (!(error instanceof RegistrationChallengeError)) return false;
  switch (error.code) {
    case "EXPIRED":
    case "SETUP_EXPIRED":
      sendError(res, "This registration session has expired. Please start again.", 410, "CHALLENGE_EXPIRED");
      return true;
    case "CONSUMED":
      sendError(res, "This registration session has already been completed.", 409, "CHALLENGE_CONSUMED");
      return true;
    case "NOT_VERIFIED":
      sendError(res, "Verify your phone before setting a password.", 409, "PHONE_NOT_VERIFIED");
      return true;
    case "RESEND_COOLDOWN":
      res.set("Retry-After", "30");
      sendError(res, "Please wait before requesting another code.", 429, "RESEND_COOLDOWN");
      return true;
    case "PROVIDER_BUSY":
      res.set("Retry-After", "5");
      sendError(res, "Another verification request is still being processed. Please try again shortly.", 429, "PROVIDER_BUSY");
      return true;
    case "PROVIDER_LEASE_LOST":
      sendError(res, "That verification request is no longer current. Please request a new code and try again.", 409, "VERIFICATION_RETRY");
      return true;
    case "REPLACED":
    case "CANCELLED":
    case "NOT_FOUND":
    case "ORG_MISMATCH":
    case "SESSION_MISMATCH":
      sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
      return true;
    default:
      return false;
  }
}

async function getSmsRegistrationChallenge(req: Request) {
  const capability = smsRegistrationSession(req);
  if (!capability || !registrationHostMatchesOrganization(req, capability.organizationId)) return undefined;
  return getRegistrationChallengeForSession(
    capability.bindingSecret,
    capability.challengeId,
    capability.organizationId,
  );
}

function smsRegistrationStatus(
  row: Awaited<ReturnType<typeof getRegistrationChallengeForSession>>,
  existingAccount: boolean,
) {
  if (!row) return undefined;
  const phase = existingAccount ? "email" : registrationChallengePhase(row);
  const expiresAt = existingAccount
    ? null
    : phase === "set_password" ? row.setupExpiresAt : row.expiresAt;
  return {
    status: existingAccount ? "email" : row.status,
    registrationMode: "sms_otp",
    phase,
    delivery: existingAccount ? "email" : "sms",
    // The phone is the value the person just submitted in this anonymous
    // server-bound flow. Returning the normalized value lets the UI show the
    // complete destination while never exposing roster contact details or a
    // provider identifier. Existing-account recovery deliberately returns no
    // phone because that number is not a trusted recovery destination.
    phone: existingAccount ? null : row.phone,
    phoneMasked: existingAccount ? null : maskRegistrationPhone(row.phone),
    verificationExpiresAt: existingAccount ? null : row.expiresAt,
    passwordSetupExpiresAt: existingAccount ? null : row.setupExpiresAt,
    expiresAt,
    cooldownSeconds: existingAccount ? 0 : challengeResendCooldownSeconds(row),
    resendAvailableAt: existingAccount && row.lastSentAt
      ? new Date(Date.parse(row.lastSentAt) + 30_000).toISOString()
      : row.lastSentAt
        ? new Date(Date.parse(row.lastSentAt) + 30_000).toISOString()
        : null,
  };
}

/**
 * A user can win the email-ownership race after the completion transaction's
 * preflight lookup but before its unique index insert. Treat that loser the
 * same as the ordinary existing-account branch: enqueue recovery guidance,
 * retire the anonymous capability, and never mutate the winning account.
 */
async function recoverRegistrationEmailConflict(
  req: Request,
  capability: SmsRegistrationSession | undefined,
  email: string | undefined,
): Promise<void> {
  if (email) {
    try {
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser?.password) {
        const reset = await enqueuePasswordResetDelivery({
          userId: existingUser.id,
          organizationId: existingUser.organizationId,
          credentialGeneration: existingUser.credentialGeneration,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        if (reset.kind === "enqueued") notifyAccountActionDeliveryChanged();
      }
    } catch (error) {
      // The account-conflict response remains safe even if a provider/job
      // enqueue is temporarily unavailable. The challenge is still retired
      // below, and the user can use the normal recovery page later.
      log.warn("Failed to queue password recovery after registration conflict", {
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (capability) {
    await cancelRegistrationChallenge({
      challengeId: capability.challengeId,
      bindingSecret: capability.bindingSecret,
      organizationId: capability.organizationId,
    }).catch((error) => {
      log.warn("Failed to cancel registration challenge after email conflict", {
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    });
  }
  req.session.registrationChallenge = undefined;
  req.session.pendingRegistration = undefined;
}

type RegistrationSmsSendStage = "lease" | "recovery" | "provider" | "persistence" | "route";
type RegistrationSmsSendErrorCode =
  | RegistrationChallengeError["code"]
  | TwilioVerifyError["code"]
  | "delivery_limit"
  | "unknown";

function registrationSmsSendErrorCode(error: unknown): RegistrationSmsSendErrorCode {
  if (error instanceof RegistrationChallengeError) return error.code;
  if (error instanceof TwilioVerifyError) return error.code;
  if (error instanceof RegistrationDeliveryLimitExceededError) return "delivery_limit";
  return "unknown";
}

async function sendSmsRegistrationCode(req: Request, res: Parameters<typeof sendSuccess>[0]) {
  const capability = smsRegistrationSession(req);
  const row = await getSmsRegistrationChallenge(req);
  if (!row || !capability) {
    res.set("Cache-Control", "no-store");
    return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
  }
  const existingUser = row.existingUserId
    ? await storage.getUser(row.existingUserId)
    : await storage.getUserByEmail(row.email);
  let lease: Awaited<ReturnType<typeof acquireRegistrationProviderLease>> | undefined;
  let stage: RegistrationSmsSendStage = "lease";
  try {
    lease = await acquireRegistrationProviderLease({
      challengeId: capability.challengeId,
      bindingSecret: capability.bindingSecret,
      organizationId: capability.organizationId,
      operation: "send",
    });
    if (existingUser) {
      stage = "recovery";
      // Existing accounts do not receive an SMS to an untrusted number. Queue
      // the ordinary reset flow and expose only the deliberate email branch.
      if (existingUser.password) {
        const reset = await enqueuePasswordResetDelivery({
          userId: existingUser.id,
          organizationId: existingUser.organizationId,
          credentialGeneration: existingUser.credentialGeneration,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        if (reset.kind === "enqueued") notifyAccountActionDeliveryChanged();
      }
      const updated = await markRegistrationRecoverySent({
        challengeId: capability.challengeId,
        bindingSecret: capability.bindingSecret,
        organizationId: capability.organizationId,
        leaseToken: lease.leaseToken,
      });
      lease = undefined;
      return sendSuccess(res, {
        status: "pending",
        registrationMode: "sms_otp",
        phase: "email",
        delivery: "email",
        message: "This email already has an account. Check your email for password-reset instructions.",
        cooldownSeconds: challengeResendCooldownSeconds(updated),
      }, 202);
    }

    stage = "provider";
    const sent = await getTwilioVerifyAdapter().sendSmsVerification(lease.row.phone);
    stage = "persistence";
    const updated = await markRegistrationVerificationSent({
      challengeId: capability.challengeId,
      bindingSecret: capability.bindingSecret,
      organizationId: capability.organizationId,
      leaseToken: lease.leaseToken,
      providerVerificationSid: sent.sid,
    });
    lease = undefined;
    res.set("Cache-Control", "no-store");
    return sendSuccess(res, {
      status: "pending",
      registrationMode: "sms_otp",
      phase: "verify_phone",
      delivery: "sms",
      phone: updated.phone,
      phoneMasked: maskRegistrationPhone(updated.phone),
      cooldownSeconds: challengeResendCooldownSeconds(updated),
      expiresAt: updated.expiresAt,
    }, 202);
  } catch (error) {
    if (lease) {
      await releaseRegistrationProviderLease({
        challengeId: capability.challengeId,
        bindingSecret: capability.bindingSecret,
        organizationId: capability.organizationId,
        leaseToken: lease.leaseToken,
      }).catch(() => undefined);
    }
    if (registrationChallengeErrorResponse(res, error)) return;
    if (error instanceof RegistrationDeliveryLimitExceededError) {
      res.set("Retry-After", "3600");
      return sendError(res, existingUser
        ? "Too many recovery messages were requested. Please try again later."
        : "Too many verification messages were requested. Please try again later.", 429, "DELIVERY_LIMIT");
    }
    if (stage === "persistence") {
      log.error("Registration SMS persistence failed", {
        stage,
        errorCode: registrationSmsSendErrorCode(error),
      });
      return sendError(res, "We could not finish starting phone verification. Please try again.", 503, "RETRYABLE_ERROR");
    }
    if (stage === "recovery") {
      log.error("Registration recovery persistence failed", {
        stage,
        errorCode: registrationSmsSendErrorCode(error),
      });
      return sendError(res, "Unable to send the recovery message. Please try again.", 503, "RETRYABLE_ERROR");
    }
    if (stage !== "provider") {
      log.error("Registration SMS lease failed", {
        stage,
        errorCode: registrationSmsSendErrorCode(error),
      });
      return sendError(res, "Unable to send the verification message. Please try again.", 503, "RETRYABLE_ERROR");
    }
    if (error instanceof TwilioVerifyError && error.code === "not_configured") {
      return sendError(res, "Text verification is temporarily unavailable. Please try again later.", 503, "SMS_NOT_CONFIGURED");
    }
    log.warn("Registration SMS delivery failed", {
      stage,
      errorCode: registrationSmsSendErrorCode(error),
    });
    return sendError(res, "We could not send a verification code. Please try again later.", 503, "SMS_UNAVAILABLE");
  }
}

async function startSmsRegistration(req: Request, res: Parameters<typeof sendSuccess>[0]) {
  const registrationOrganization = await resolveRegistrationOrganization(req);
  if (!registrationOrganization) {
    return sendError(res, registrationUnavailableMessage, 503, "SIGNUP_UNAVAILABLE");
  }
  const registrationSchema = z.object({
    email: emailSchema,
    name: nameSchema,
    phone: z.string().trim().min(1).max(50),
  });
  const result = registrationSchema.safeParse({
    email: typeof req.body?.email === "string" ? req.body.email.trim() : req.body?.email,
    name: req.body?.name,
    phone: req.body?.phone,
  });
  if (!result.success) {
    return sendError(res, "Registration validation failed", 400, "VALIDATION_ERROR", result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })));
  }
  const phone = normalizeRegistrationPhone(result.data.phone);
  if (!phone) {
    return sendError(res, "Enter a valid US or Canadian phone number.", 400, "INVALID_PHONE");
  }
  // A corrected submission supersedes the anonymous capability that was
  // already in this browser. Cancel it before creating the replacement so
  // the old phone/email cannot remain an active provider challenge.
  const previousCapability = smsRegistrationSession(req);
  if (previousCapability) {
    await cancelRegistrationChallenge({
      challengeId: previousCapability.challengeId,
      bindingSecret: previousCapability.bindingSecret,
      organizationId: previousCapability.organizationId,
    }).catch((error) => {
      log.warn("Failed to cancel superseded registration challenge", {
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    });
  }
  const bindingSecret = randomBytes(32).toString("hex");
  const existingUser = await storage.getUserByEmail(result.data.email.trim().toLowerCase());
  const challenge = await createRegistrationChallenge({
    bindingSecret,
    organizationId: registrationOrganization.id,
    existingUserId: existingUser?.id ?? null,
    email: result.data.email.trim().toLowerCase(),
    name: result.data.name,
    phone,
  });
  req.session.pendingRegistration = undefined;
  req.session.registrationChallenge = {
    challengeId: challenge.id,
    organizationId: challenge.organizationId,
    bindingSecret,
    createdAt: Date.now(),
  };
  res.set("Cache-Control", "no-store");
  return sendSuccess(res, {
    status: "pending",
    registrationMode: "sms_otp",
    phase: "verify_phone",
    delivery: "sms",
    phone: challenge.phone,
    phoneMasked: maskRegistrationPhone(challenge.phone),
    message: "Your registration is ready for phone verification.",
  }, 202);
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

const registrationVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore('registration-verification'),
  message: {
    success: false,
    error: { message: "Too many verification attempts, please try again later", code: "RATE_LIMITED" },
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
  const registrationGenericMessage = "If this email can be used for registration, an email with next steps will be sent.";

  authRouter.get("/registration/availability", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const registrationOrganization = await resolveRegistrationOrganization(req);
      return sendSuccess(res, {
        available: Boolean(registrationOrganization),
        registrationMode: env.REGISTRATION_MODE,
      });
    } catch (error) {
      log.error("Registration availability error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, registrationUnavailableMessage, 503, "SIGNUP_UNAVAILABLE");
    }
  });

  // Email-first registration deliberately has no password field. The
  // placeholder hash makes the account non-loginable until the email action
  // is consumed; it is never returned to the browser or sent to a provider.
  authRouter.post("/register", registerLimiter, csrfProtection, async (req, res) => {
    try {
      if (env.REGISTRATION_MODE === "sms_otp") {
        return await startSmsRegistration(req, res);
      }
      const registrationOrganization = await resolveRegistrationOrganization(req);
      if (!registrationOrganization) {
        return sendError(res, registrationUnavailableMessage, 503, "SIGNUP_UNAVAILABLE");
      }
      const registrationOrganizationId = registrationOrganization.id;

      const registrationSchema = z.object({
        email: emailSchema,
        name: nameSchema,
        phone: phoneSchema.min(1, "Phone number is required").max(50),
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

      // Hash every valid submission before the existing-account branch. The
      // placeholder hash is never used for a duplicate, but keeping the same
      // expensive password work on both paths avoids making valid duplicate
      // email probes distinguishable by timing. This is deliberately not a
      // sleep or a transaction-held delay.
      const placeholderPassword = await hashPassword(randomBytes(32).toString("hex"));

      // Existing accounts are protected and indistinguishable from unknown
      // addresses. A narrowly-defined pending registration is the only
      // exception: a user who lost the anonymous browser session may resume
      // delivery, but the durable helper rechecks the locked user, tenant,
      // role, generation, origin job, and completion state before doing so.
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        const resumed = await resumePendingAccountRegistration({
          email,
          organizationId: registrationOrganizationId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        if (resumed) {
          req.session.pendingRegistration = {
            userId: resumed.user.id,
            organizationId: registrationOrganizationId,
            credentialGeneration: resumed.user.credentialGeneration,
            createdAt: Date.now(),
          };
          if (resumed.delivery.kind === "enqueued") notifyAccountActionDeliveryChanged();
        } else {
          const guidance = await enqueueAccountGuidanceNotice({
            recipientEmail: email,
            noticeType: "account_exists",
            userId: existingUser.id,
            organizationId: existingUser.organizationId,
          });
          if (guidance.kind === "enqueued") notifyAccountActionDeliveryChanged();
        }
        return sendSuccess(res, {
          status: "pending",
          email: maskEmail(email),
          registrationMode: "email_link",
          message: registrationGenericMessage,
        }, 202);
      }

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
            organizationId: registrationOrganizationId,
            bowlerId: null,
          }, tx);
          const queued = await enqueueAccountRegistrationDelivery({
            userId: createdUser.id,
            organizationId: registrationOrganizationId,
            credentialGeneration: createdUser.credentialGeneration,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }, tx);
          return { user: createdUser, delivery: queued };
        }));
      } catch (createError) {
        if (isNormalizedUserEmailConflict(createError)) {
          return sendSuccess(res, {
            status: "pending",
            email: maskEmail(email),
            registrationMode: "email_link",
            message: registrationGenericMessage,
          }, 202);
        }
        if (handleUserOrgError(res, createError)) return;
        throw createError;
      }

      req.session.pendingRegistration = {
        userId: user.id,
        organizationId: registrationOrganizationId,
        credentialGeneration: user.credentialGeneration,
        createdAt: Date.now(),
      };
      if (delivery.kind === "enqueued") notifyAccountActionDeliveryChanged();
      return sendSuccess(res, {
        status: "pending",
        email: maskEmail(email),
        registrationMode: "email_link",
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
      || !registrationHostMatchesOrganization(req, pending.organizationId)
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

  authRouter.post("/registration/send", registrationVerificationLimiter, csrfProtection, async (req, res) => {
    if (env.REGISTRATION_MODE !== "sms_otp" && !smsRegistrationSession(req)) {
      return sendError(res, "Registration delivery is unavailable.", 404, "NOT_FOUND");
    }
    try {
      return await sendSmsRegistrationCode(req, res);
    } catch (error) {
      log.error("Registration verification send error", {
        stage: "route",
        errorCode: registrationSmsSendErrorCode(error),
      });
      return sendError(res, "Unable to send the verification message. Please try again.", 503, "RETRYABLE_ERROR");
    }
  });

  authRouter.post("/registration/verify", registrationVerificationLimiter, csrfProtection, async (req, res) => {
    if (env.REGISTRATION_MODE !== "sms_otp" && !smsRegistrationSession(req)) {
      return sendError(res, "Registration verification is unavailable.", 404, "NOT_FOUND");
    }
    try {
      const capability = smsRegistrationSession(req);
      const row = await getSmsRegistrationChallenge(req);
      if (!capability || !row) return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
      if (registrationChallengePhase(row) === "expired") {
        return sendError(res, "This verification session has expired. Please start again.", 410, "CHALLENGE_EXPIRED");
      }
      if (row.status === "verified") {
        return sendSuccess(res, {
          status: "verified",
          phase: "set_password",
          setupExpiresAt: row.setupExpiresAt,
          expiresAt: row.setupExpiresAt,
        });
      }
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the six-digit verification code") }).safeParse(req.body);
      if (!parsed.success) return sendError(res, "Enter the six-digit verification code.", 400, "INVALID_CODE");
      const existingUser = row.existingUserId
        ? await storage.getUser(row.existingUserId)
        : await storage.getUserByEmail(row.email);
      if (existingUser) {
        // The account may have been claimed after the challenge was prepared
        // but before this check. Retire the SMS capability and provide the
        // same recovery guidance as the normal existing-account branch.
        await recoverRegistrationEmailConflict(req, capability, row.email);
        return sendError(res, "This email already has an account. Check your email for password-reset instructions.", 409, "ACCOUNT_EXISTS");
      }
      let lease: Awaited<ReturnType<typeof acquireRegistrationProviderLease>> | undefined;
      try {
        lease = await acquireRegistrationProviderLease({
          challengeId: capability.challengeId,
          bindingSecret: capability.bindingSecret,
          organizationId: capability.organizationId,
          operation: "verify",
        });
        const providerVerificationSid = lease.row.providerVerificationSid;
        if (!providerVerificationSid) throw new RegistrationChallengeError("NOT_VERIFIED");
        const checked = await getTwilioVerifyAdapter().checkSmsVerification(
          lease.row.phone,
          parsed.data.code,
          providerVerificationSid,
        );
        if (checked.kind === "provider_not_found" || checked.kind === "provider_unavailable") {
          await releaseRegistrationProviderLease({
            challengeId: capability.challengeId,
            bindingSecret: capability.bindingSecret,
            organizationId: capability.organizationId,
            leaseToken: lease.leaseToken,
          });
          lease = undefined;
          return sendError(res, "Text verification is temporarily unavailable. Please try again later.", 503, "SMS_UNAVAILABLE");
        }
        if (checked.kind !== "approved") {
          const attempts = await recordRegistrationVerificationAttempt({
            challengeId: capability.challengeId,
            bindingSecret: capability.bindingSecret,
            organizationId: capability.organizationId,
            leaseToken: lease.leaseToken,
          });
          lease = undefined;
          if (attempts >= 5) {
            res.set("Retry-After", "900");
            return sendError(res, "Too many verification attempts. Request a new registration code later.", 429, "VERIFICATION_ATTEMPTS_EXCEEDED");
          }
          return sendError(res, "That code was not accepted. Request a new code and try again.", 400, "INVALID_CODE");
        }
        const verified = await markRegistrationChallengeVerified({
          challengeId: capability.challengeId,
          bindingSecret: capability.bindingSecret,
          organizationId: capability.organizationId,
          leaseToken: lease.leaseToken,
          expectedProviderVerificationSid: providerVerificationSid,
        });
        lease = undefined;
        res.set("Cache-Control", "no-store");
        return sendSuccess(res, {
          status: "verified",
          phase: "set_password",
          setupExpiresAt: verified.setupExpiresAt,
          expiresAt: verified.setupExpiresAt,
        });
      } catch (error) {
        if (lease) {
          await releaseRegistrationProviderLease({
            challengeId: capability.challengeId,
            bindingSecret: capability.bindingSecret,
            organizationId: capability.organizationId,
            leaseToken: lease.leaseToken,
          }).catch(() => undefined);
        }
        if (error instanceof RegistrationVerificationAttemptsExceededError) {
          res.set("Retry-After", "900");
          return sendError(res, "Too many verification attempts. Request a new registration code later.", 429, "VERIFICATION_ATTEMPTS_EXCEEDED");
        }
        if (registrationChallengeErrorResponse(res, error)) return;
        if (error instanceof TwilioVerifyError && error.code === "not_configured") {
          return sendError(res, "Text verification is temporarily unavailable. Please try again later.", 503, "SMS_NOT_CONFIGURED");
        }
        if (error instanceof TwilioVerifyError) {
          return sendError(res, "Text verification is temporarily unavailable. Please try again later.", 503, "SMS_UNAVAILABLE");
        }
        throw error;
      }
    } catch (error) {
      log.error("Registration verification error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, "Unable to verify the code. Please try again.", 503, "RETRYABLE_ERROR");
    }
  });

  authRouter.post("/registration/complete", registrationVerificationLimiter, csrfProtection, async (req, res) => {
    if (env.REGISTRATION_MODE !== "sms_otp" && !smsRegistrationSession(req)) {
      return sendError(res, "Registration completion is unavailable.", 404, "NOT_FOUND");
    }
    let capability: SmsRegistrationSession | undefined;
    let challengeEmail: string | undefined;
    try {
      capability = smsRegistrationSession(req);
      const row = await getSmsRegistrationChallenge(req);
      if (!capability || !row) return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
      challengeEmail = row.email;
      const password = req.body && typeof req.body.password === "string" ? req.body.password : undefined;
      if (!password || !isPasswordValidForRegistration(password)) {
        return sendError(res, "Password validation failed.", 400, "VALIDATION_ERROR");
      }
      const result = await completeRegistration({
        challengeId: capability.challengeId,
        organizationId: capability.organizationId,
        bindingSecret: capability.bindingSecret,
        password,
      });
      req.session.registrationChallenge = undefined;
      return new Promise<void>((resolve) => {
        req.login(result.user, (error) => {
          if (error) {
            log.error("Registration Passport login failed", { errorCode: error instanceof Error ? error.name : "unknown" });
            sendSuccess(res, { linked: result.linked, loginFailed: true });
          } else {
            sendSuccess(res, { linked: result.linked, user: sanitizeUser(result.user) });
          }
          resolve();
        });
      });
    } catch (error) {
      if (error instanceof RegistrationExistingAccountError) {
        await recoverRegistrationEmailConflict(req, capability, error.email ?? challengeEmail);
        return sendError(res, "This email already has an account. Check your email for password-reset instructions.", 409, "ACCOUNT_EXISTS");
      }
      // A concurrent completion can consume the challenge and commit the
      // account before this request reaches the challenge lock. Treat that
      // losing request like the normal email-ownership race so it cannot
      // surface a misleading "already completed" state without recovery
      // guidance.
      if (error instanceof RegistrationChallengeError
        && error.code === "CONSUMED"
        && challengeEmail) {
        const existingUser = await storage.getUserByEmail(challengeEmail);
        if (existingUser) {
          await recoverRegistrationEmailConflict(req, capability, challengeEmail);
          return sendError(res, "This email already has an account. Check your email for password-reset instructions.", 409, "ACCOUNT_EXISTS");
        }
      }
      if (error instanceof RegistrationPasswordError) {
        return sendError(res, "Password validation failed.", 400, "VALIDATION_ERROR");
      }
      if (registrationChallengeErrorResponse(res, error)) return;
      log.error("Registration completion error", { errorCode: error instanceof Error ? error.name : "unknown" });
      return sendError(res, "Unable to complete registration. Please try again.", 503, "RETRYABLE_ERROR");
    }
  });

  authRouter.get("/registration/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // A flag change controls only newly started registrations. If this
      // browser already carries an SMS capability, restore that flow even
      // after rollback; otherwise continue resolving any legacy email-link
      // capability that was issued before the flag changed.
      if (smsRegistrationSession(req)) {
        const row = await getSmsRegistrationChallenge(req);
        if (!row) return sendError(res, "Registration status is unavailable.", 404, "NOT_FOUND");
        const existingUser = row.existingUserId
          ? await storage.getUser(row.existingUserId)
          : await storage.getUserByEmail(row.email);
        return sendSuccess(res, smsRegistrationStatus(row, Boolean(existingUser)));
      }
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

  authRouter.post("/registration/resend", registerLimiter, csrfProtection, async (req, res) => {
    try {
      if (smsRegistrationSession(req)) {
        return await sendSmsRegistrationCode(req, res);
      }
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
    const capability = smsRegistrationSession(req);
    if (capability) {
      try {
        await cancelRegistrationChallenge({
          challengeId: capability.challengeId,
          bindingSecret: capability.bindingSecret,
          organizationId: capability.organizationId,
        });
      } catch (error) {
        log.warn("Failed to cancel registration challenge during abandon", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    req.session.pendingRegistration = undefined;
    req.session.registrationChallenge = undefined;
    res.set("Cache-Control", "no-store");
    return sendSuccess(res, { status: "abandoned" });
  });

  authRouter.post("/login", loginLimiter, (req, res, next) => {
    passport.authenticate("local", async (err: unknown, user: Express.User | false, info: { message?: string } | undefined) => {
      if (err) {
        log.error('Login error:', err);
        return sendError(res, "Internal server error", 500, "SERVER_ERROR");
      }
      if (!user) {
        return sendError(res, info?.message || "Invalid credentials", 401, "INVALID_CREDENTIALS");
      }
      if (await hasActiveIdentitySecurityHold(user.id)) {
        return sendError(res, "This account is temporarily restricted while a profile-security report is reviewed.", 423, "IDENTITY_SECURITY_HOLD");
      }

      if (
        isSingletonOrganizationMode
        && req.organizationContextId !== undefined
        && !hasConfiguredOrganizationMembership(user, req.organizationContextId)
      ) {
        return sendError(res, "You do not have access to this business", 403, "ORG_ACCESS_DENIED");
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

        // Owner rows created before organization membership was required may
        // remain unassigned in storage. Surface the deployment-resolved
        // business for this session without rewriting that historical row.
        if (
          user.role === 'system_admin'
          && user.organizationId == null
          && req.organizationContextId !== undefined
        ) {
          user.organizationId = req.organizationContextId;
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
      let user = await storage.getUser(sessionUser.id);
      if (!user) {
        return new Promise<void>((resolve) => {
          req.logout((err) => {
            if (err) log.error('Logout error in /api/auth/user deleted-account guard:', err);
            sendError(res, "Not authenticated", 401, "AUTH_REQUIRED");
            resolve();
          });
        });
      }
      if (
        isSingletonOrganizationMode
        && req.organizationContextId !== undefined
        && !hasConfiguredOrganizationMembership(user, req.organizationContextId)
      ) {
        return new Promise<void>((resolve) => {
          req.logout((err) => {
            if (err) log.error('Logout error in /api/auth/user organization guard:', err);
            sendError(res, "You do not have access to this business", 403, "ORG_ACCESS_DENIED");
            resolve();
          });
        });
      }
      if (
        user.role === 'system_admin'
        && user.organizationId == null
        && req.organizationContextId !== undefined
      ) {
        user = { ...user, organizationId: req.organizationContextId };
      }

      // `/api/user` is registered before the broader protected `/api/*`
      // middleware. Re-check a security hold here so a disputed identity
      // cannot continue to hydrate held profile data through the auth
      // bootstrap endpoint while still retaining the ability to log out.
      if (await hasActiveIdentitySecurityHold(user.id)) {
        return sendError(
          res,
          "This account is temporarily restricted while a profile-security report is reviewed.",
          423,
          "IDENTITY_SECURITY_HOLD",
        );
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
      if (await hasActiveIdentitySecurityHold(eligibility.record.user.id)) {
        return sendError(res, "This account is temporarily restricted while a profile-security report is reviewed.", 423, "IDENTITY_SECURITY_HOLD");
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
                cacheInvalidate("bowlers:");
                notifyPaymentSyncRetryChanged();
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
          return sendSuccess(res, {
            message: "Password set successfully. Please log in.",
            ...(isRegistration ? { loginFailed: true } : {}),
          });
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
      const parsed = z.object({
        email: z.string().trim().max(320, "Email address is too long").email("Invalid email address"),
      }).safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, "A valid email address is required", 400, "VALIDATION_ERROR");
      }

      const email = parsed.data.email.toLowerCase();
      const user = await storage.getUserByEmail(email);
      const userOnHold = user ? await hasActiveIdentitySecurityHold(user.id) : false;
      if (user?.password && !userOnHold) {
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
      } else if (!user) {
        const registrationOrganization = await resolveRegistrationOrganization(req);
        if (registrationOrganization) {
          const result = await enqueueAccountGuidanceNotice({
            recipientEmail: email,
            noticeType: "account_missing",
            organizationId: registrationOrganization.id,
          });
          if (result.kind === "enqueued") {
            notifyAccountActionDeliveryChanged();
            log.info("Account-guidance delivery queued", { jobId: result.job.id });
          } else {
            log.info("Account-guidance delivery suppressed", { reason: result.reason });
          }
        }
      }
      const remaining = responseNotBefore - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      sendSuccess(res, { message: "If this email can be used for a LeagueVault account, an email with next steps will be sent." });
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

      if (await hasActiveIdentitySecurityHold(user.id)) {
        return sendError(res, "This account is temporarily restricted while a profile-security report is reviewed.", 423, "IDENTITY_SECURITY_HOLD");
      }

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
          if (linkError.code === "SECURITY_HOLD") {
            return sendError(res, "This account is temporarily restricted while a profile-security report is reviewed.", 423, "IDENTITY_SECURITY_HOLD");
          }
        }
        throw linkError;
      }
      // Contact transfer is committed by the identity-link transaction above.

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
