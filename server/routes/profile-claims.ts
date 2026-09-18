import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../config.js";
import { safeTokenCompare } from "../lib/password.js";
import { sendError, sendSuccess, handleZodError } from "../utils/api.js";
import { createLogger } from "../logger.js";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";
import { destroyAllSessionsForUser } from "../auth.js";
import {
  consumeProfileClaimReportAndCreateHold,
  getProfileClaimReportByHash,
} from "../storage/profile-claim-notifications.js";

const log = createLogger("ProfileClaims");
const router = Router();

const REPORT_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Stateless CSRF proof: GET does not write a session/cookie or database row. */
export function profileClaimReportCsrfToken(rawToken: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`profile-claim-report-csrf:${rawToken}`, "utf8")
    .digest("hex");
}

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createSharedRateLimitStore("profile-claim-report"),
  keyGenerator: (req: Request) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  handler: (_req, res) => sendError(res, "Too many report attempts. Please try again later.", 429, "RATE_LIMITED"),
});

function readToken(req: Request): string {
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const bodyToken = typeof req.body?.token === "string" ? req.body.token : "";
  return bodyToken || queryToken;
}

function validToken(token: string): boolean {
  return REPORT_TOKEN_PATTERN.test(token);
}

// Public, read-only report page. Reading a token never consumes it, creates a
// session, or creates a hold; the browser uses the returned stateless CSRF
// value for the explicit POST below.
router.get("/report", async (req: Request, res: Response) => {
  const token = readToken(req);
  if (!validToken(token)) return sendError(res, "Report link is invalid or expired", 404, "INVALID_TOKEN");
  try {
    const found = await getProfileClaimReportByHash(tokenHash(token));
    if (!found) return sendError(res, "Report link is invalid or expired", 404, "INVALID_TOKEN");
    if (found.token.usedAt) return sendError(res, "This report link has already been used", 409, "TOKEN_USED");
    if (Date.parse(found.token.expiresAt) <= Date.now()) return sendError(res, "Report link has expired", 410, "TOKEN_EXPIRED");
    return sendSuccess(res, {
      profileName: found.notification.bowlerName,
      status: "ready",
      csrfToken: profileClaimReportCsrfToken(token),
    });
  } catch (error) {
    log.error("Failed to load profile-claim report", { errorCode: error instanceof Error ? error.name : "unknown" });
    return sendError(res, "Unable to load this report link", 500, "SERVER_ERROR");
  }
});

router.post("/report", reportLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({
    token: z.string().regex(REPORT_TOKEN_PATTERN),
    confirm: z.literal(true),
    reason: z.string().trim().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return handleZodError(res, parsed.error);
  const csrfHeader = req.headers["x-claim-report-csrf"];
  const csrf = typeof csrfHeader === "string" ? csrfHeader : "";
  if (!safeTokenCompare(csrf, profileClaimReportCsrfToken(parsed.data.token))) {
    return sendError(res, "CSRF validation failed", 403, "CSRF_ERROR");
  }

  try {
    const result = await consumeProfileClaimReportAndCreateHold({
      tokenHash: tokenHash(parsed.data.token),
      reason: parsed.data.reason?.trim() || null,
    });
    if (result.kind === "invalid") return sendError(res, "Report link is invalid or expired", 404, "INVALID_TOKEN");
    if (result.kind === "expired") return sendError(res, "Report link has expired", 410, "TOKEN_EXPIRED");
    if (result.kind === "obsolete") return sendError(res, "This profile assignment is no longer active", 410, "ASSIGNMENT_OBSOLETE");
    if (result.kind === "used") return sendError(res, "This report link has already been used", 409, "TOKEN_USED");

    // A report is deliberately anonymous and never adopts the target account.
    // Destroy every session after the hold commits; the middleware check below
    // remains authoritative if a store outage prevents immediate cleanup.
    try {
      await destroyAllSessionsForUser(result.userId);
    } catch (sessionError) {
      log.error("Failed to destroy sessions after profile-claim report", {
        userId: result.userId,
        errorCode: sessionError instanceof Error ? sessionError.name : "unknown",
      });
    }
    return sendSuccess(res, {
      reported: true,
      holdStatus: result.hold.status,
      ...(result.kind === "existing" ? { alreadyReported: true } : {}),
    });
  } catch (error) {
    log.error("Failed to record profile-claim report", { errorCode: error instanceof Error ? error.name : "unknown" });
    return sendError(res, "Unable to record this report right now", 500, "SERVER_ERROR");
  }
});

export default router;
