import { z } from "zod";
import { Router } from "express";
import { sendError, sendSuccess } from "../utils/api.js";
import { createLogger } from "../logger.js";
import { positiveId } from "./games-scores-scope.js";
import { hasAdminAccessToLeague } from "../utils/access-control.js";
import { hasConfiguredOrganizationMembership } from "../middleware/organization.js";
import { configuredOrganizationId } from "../services/single-tenant-context.js";
import { adminWriteLimiter } from "../middleware/rate-limit.js";
import {
  ManagePaymentsWorksheetReadError,
  isManagePaymentsWorksheetReadAborted,
  readManagePaymentsSeasonSnapshot,
  readManagePaymentsWorksheetSnapshot,
} from "../services/manage-payments-worksheet-read.js";
import {
  ManagePaymentsWorksheetWriteError,
  saveManagePaymentsWorksheet,
} from "../services/manage-payments-worksheet-write.js";
import { managePaymentsSaveRequestSchema } from "@shared/manage-payments-contract";

const router = Router();
const log = createLogger("ManagePayments");
const occurrenceQuerySchema = z.string().uuid();

const POSTGRES_CODE_PATTERN = /^[0-9A-Z]{5}$/;
const POSTGRES_CONSTRAINT_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_ERROR_DIAGNOSTIC_DEPTH = 32;
const SAFE_ERROR_KIND_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AggregateError",
  "ZodError",
  "DrizzleQueryError",
  "DatabaseError",
  "PostgresError",
  "ManagePaymentsWorksheetReadError",
  "ManagePaymentsWorksheetWriteError",
  "ManagePaymentsReconciliationError",
  "OwnedPaymentLedgerError",
  "PaymentObligationOwnerError",
  "RotatingCreditLedgerError",
  "ManualPaymentReceiptError",
]);
const WEEKLY_LEDGER_INVARIANT_PATTERN = /^LV_WEEKLY_LEDGER_INVARIANT: ([a-z_]{1,80})$/;

function readErrorProperty(error: object, key: "name" | "message" | "cause" | "code" | "constraint"): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function collectSafeErrorDiagnostics(error: unknown): {
  errorCode: string;
  errorConstraint: string;
  errorKind: string;
  invariant: string;
} {
  const seen = new Set<object>();
  let current = error;
  let errorCode = "unknown";
  let errorConstraint = "unknown";
  let errorKind = "unknown";
  let genericErrorKind = "unknown";
  let invariant = "unknown";

  for (let depth = 0; depth < MAX_ERROR_DIAGNOSTIC_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);

    const code = readErrorProperty(current, "code");
    if (errorCode === "unknown" && typeof code === "string" && POSTGRES_CODE_PATTERN.test(code)) {
      errorCode = code;
    }

    const constraint = readErrorProperty(current, "constraint");
    if (errorConstraint === "unknown"
      && typeof constraint === "string"
      && POSTGRES_CONSTRAINT_PATTERN.test(constraint)) {
      errorConstraint = constraint;
    }

    const name = readErrorProperty(current, "name");
    if (typeof name === "string" && SAFE_ERROR_KIND_NAMES.has(name)) {
      if (name === "Error") genericErrorKind = name;
      else if (errorKind === "unknown") errorKind = name;
    }

    const message = readErrorProperty(current, "message");
    if (invariant === "unknown" && typeof message === "string") {
      const match = WEEKLY_LEDGER_INVARIANT_PATTERN.exec(message);
      if (match?.[1]) invariant = match[1];
    }

    // Do not evaluate a getter on the final object at the depth limit.
    if (depth + 1 === MAX_ERROR_DIAGNOSTIC_DEPTH) break;
    current = readErrorProperty(current, "cause");
  }

  return {
    errorCode,
    errorConstraint,
    errorKind: errorKind === "unknown" ? genericErrorKind : errorKind,
    invariant,
  };
}

function reportUnexpectedSaveFailure(error: unknown): void {
  let diagnostics = {
    errorCode: "unknown",
    errorConstraint: "unknown",
    errorKind: "unknown",
    invariant: "unknown",
  };
  try {
    diagnostics = collectSafeErrorDiagnostics(error);
  } catch {
    // Error causes and accessors are untrusted diagnostic input.
  }

  // Drizzle errors can include SQL and query parameters in their message/cause.
  // Report a new error with a fresh stack instead of forwarding that chain.
  const safeError = new Error("Unexpected weekly payment worksheet save failure");
  safeError.name = "ManagePaymentsSaveError";
  try {
    log.captureException(safeError);
  } catch {
    // Error capture must not change the client response.
  }
  try {
    log.error("Unexpected weekly payment worksheet save failure", {
      operation: "manage_payments_save",
      errorCode: diagnostics.errorCode,
      errorConstraint: diagnostics.errorConstraint,
      errorKind: diagnostics.errorKind,
      invariant: diagnostics.invariant,
    });
  } catch {
    // Server logging must not change the client response.
  }
}

router.get("/leagues/:leagueId/manage-payments/1", async (req, res) => {
  if (!req.user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
  if (req.user.role !== "org_admin" && req.user.role !== "system_admin") {
    return sendError(res, "Administrator access required", 403, "ADMIN_ACCESS_REQUIRED");
  }

  const leagueId = positiveId(req.params.leagueId);
  if (leagueId === null) return sendError(res, "Invalid league id", 400, "INVALID_LEAGUE_ID");

  const organizationId = configuredOrganizationId();
  if (organizationId === undefined
    || req.organizationContextId === undefined
    || req.organizationContextId !== organizationId
    || !hasConfiguredOrganizationMembership(req.user, organizationId)) {
    return sendError(res, "Configured business access is unavailable", 403, "ORG_ACCESS_DENIED");
  }

  const rawOccurrenceId = req.query.occurrenceId;
  let occurrenceId: string | undefined;
  if (rawOccurrenceId !== undefined) {
    const parsed = occurrenceQuerySchema.safeParse(rawOccurrenceId);
    if (!parsed.success) return sendError(res, "Invalid canonical week id", 400, "INVALID_OCCURRENCE_ID");
    occurrenceId = parsed.data;
  }

  if (!(await hasAdminAccessToLeague(req, leagueId))) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const abortController = new AbortController();
  const abortOnRequestAborted = () => abortController.abort();
  const abortOnPrematureResponseClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", abortOnRequestAborted);
  res.once("close", abortOnPrematureResponseClose);
  if (req.aborted || res.destroyed) abortController.abort();

  try {
    const snapshot = await readManagePaymentsWorksheetSnapshot({
      organizationId,
      leagueId,
      ...(occurrenceId === undefined ? {} : { occurrenceId }),
      signal: abortController.signal,
    });
    if (abortController.signal.aborted || req.aborted || res.destroyed) return;
    return sendSuccess(res, snapshot);
  } catch (caught) {
    if (isManagePaymentsWorksheetReadAborted(caught)) return;
    if (req.aborted || res.destroyed) throw caught;
    if (caught instanceof ManagePaymentsWorksheetReadError) {
      if (caught.code === "league_not_found") return sendError(res, "Not found", 404, "NOT_FOUND");
      if (caught.code === "ledger_not_adopted") {
        return sendError(res, "This league's payment ledger is not ready for weekly worksheet reads", 409, "WEEKLY_PAYMENT_LEDGER_NOT_ADOPTED");
      }
      if (caught.code === "invalid_occurrence") return sendError(res, "The selected week is unavailable", 400, "INVALID_OCCURRENCE_ID");
      return sendError(res, "Weekly payment evidence requires review", 409, "WEEKLY_PAYMENT_EVIDENCE_INCOMPATIBLE");
    }
    return sendError(res, "Unable to read the weekly payment worksheet", 500, "INTERNAL_ERROR");
  } finally {
    req.off("aborted", abortOnRequestAborted);
    res.off("close", abortOnPrematureResponseClose);
  }
});

router.get("/leagues/:leagueId/manage-payments/1/season", async (req, res) => {
  if (!req.user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
  if (req.user.role !== "org_admin" && req.user.role !== "system_admin") {
    return sendError(res, "Administrator access required", 403, "ADMIN_ACCESS_REQUIRED");
  }

  const leagueId = positiveId(req.params.leagueId);
  if (leagueId === null) return sendError(res, "Invalid league id", 400, "INVALID_LEAGUE_ID");

  const organizationId = configuredOrganizationId();
  if (organizationId === undefined
    || req.organizationContextId === undefined
    || req.organizationContextId !== organizationId
    || !hasConfiguredOrganizationMembership(req.user, organizationId)) {
    return sendError(res, "Configured business access is unavailable", 403, "ORG_ACCESS_DENIED");
  }
  if (!(await hasAdminAccessToLeague(req, leagueId))) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const abortController = new AbortController();
  const abortOnRequestAborted = () => abortController.abort();
  const abortOnPrematureResponseClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", abortOnRequestAborted);
  res.once("close", abortOnPrematureResponseClose);
  if (req.aborted || res.destroyed) abortController.abort();

  try {
    const snapshot = await readManagePaymentsSeasonSnapshot({
      organizationId,
      leagueId,
      signal: abortController.signal,
    });
    if (abortController.signal.aborted || req.aborted || res.destroyed) return;
    return sendSuccess(res, snapshot);
  } catch (caught) {
    if (isManagePaymentsWorksheetReadAborted(caught)) return;
    if (req.aborted || res.destroyed) throw caught;
    if (caught instanceof ManagePaymentsWorksheetReadError) {
      if (caught.code === "league_not_found") return sendError(res, "Not found", 404, "NOT_FOUND");
      if (caught.code === "ledger_not_adopted") {
        return sendError(res, "This league's payment ledger is not ready for weekly worksheet reads", 409, "WEEKLY_PAYMENT_LEDGER_NOT_ADOPTED");
      }
      if (caught.code === "invalid_occurrence") return sendError(res, "The league has no available billable weeks", 400, "INVALID_OCCURRENCE_ID");
      return sendError(res, "Weekly payment evidence requires review", 409, "WEEKLY_PAYMENT_EVIDENCE_INCOMPATIBLE");
    }
    return sendError(res, "Unable to read the weekly payment worksheet", 500, "INTERNAL_ERROR");
  } finally {
    req.off("aborted", abortOnRequestAborted);
    res.off("close", abortOnPrematureResponseClose);
  }
});

router.post("/leagues/:leagueId/manage-payments/1", adminWriteLimiter, async (req, res) => {
  if (!req.user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
  if (req.user.role !== "org_admin" && req.user.role !== "system_admin") {
    return sendError(res, "Administrator access required", 403, "ADMIN_ACCESS_REQUIRED");
  }

  const leagueId = positiveId(req.params.leagueId);
  if (leagueId === null) return sendError(res, "Invalid league id", 400, "INVALID_LEAGUE_ID");

  const organizationId = configuredOrganizationId();
  if (organizationId === undefined
    || req.organizationContextId === undefined
    || req.organizationContextId !== organizationId
    || !hasConfiguredOrganizationMembership(req.user, organizationId)) {
    return sendError(res, "Configured business access is unavailable", 403, "ORG_ACCESS_DENIED");
  }
  if (!(await hasAdminAccessToLeague(req, leagueId))) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const parsed = managePaymentsSaveRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "The weekly payment changes are invalid", 400, "INVALID_WEEKLY_PAYMENT_REQUEST");
  try {
    return sendSuccess(res, await saveManagePaymentsWorksheet({
      organizationId,
      leagueId,
      actorUserId: req.user.id,
      request: parsed.data,
    }));
  } catch (caught) {
    if (caught instanceof ManagePaymentsWorksheetWriteError) {
      switch (caught.code) {
        case "invalid_request": return sendError(res, caught.message, 400, "INVALID_WEEKLY_PAYMENT_REQUEST");
        case "state_conflict": return sendError(res, caught.message, 409, "WEEKLY_PAYMENT_STATE_CONFLICT");
        case "idempotency_conflict": return sendError(res, caught.message, 409, "IDEMPOTENCY_CONFLICT");
        case "ledger_not_adopted": return sendError(res, caught.message, 409, "WEEKLY_PAYMENT_LEDGER_NOT_ADOPTED");
        case "manual_receipt_conflict": return sendError(res, caught.message, 409, "MANUAL_RECEIPT_CONFLICT");
        case "incompatible_evidence": return sendError(res, caught.message, 409, "WEEKLY_PAYMENT_EVIDENCE_INCOMPATIBLE");
        case "league_not_found": return sendError(res, "Not found", 404, "NOT_FOUND");
        default:
          reportUnexpectedSaveFailure(caught);
          return sendError(res, "Unable to save weekly payments", 500, "INTERNAL_ERROR");
      }
    }
    reportUnexpectedSaveFailure(caught);
    return sendError(res, "Unable to save weekly payments", 500, "INTERNAL_ERROR");
  }
});

export default router;
