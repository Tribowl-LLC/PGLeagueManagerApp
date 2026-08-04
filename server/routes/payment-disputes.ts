import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { adminWriteLimiter } from "../middleware/rate-limit.js";
import {
  DisputeReplayError,
  InvalidDisputeCursorError,
  isPaymentDisputeState,
  listPaymentDisputeNotifications,
  listPaymentDisputeReplayAudits,
  listPaymentDisputes,
  listPendingPaymentDisputeEvents,
  replayPendingPaymentDisputeEvent,
} from "../storage/payment-dispute-operations.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { singleRouteParam } from "../utils/route-params.js";

const router = Router();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
  organizationId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  state: z.string().max(64).optional(),
});
const eventIdSchema = z.string().uuid();

function resolveOrganizationId(
  req: Request,
  requested: number | undefined,
): number | null {
  const user = req.user;
  if (!user) return null;
  if (user.role === "org_admin") return user.organizationId ?? null;
  if (user.role === "system_admin") return requested ?? null;
  return null;
}

function parseListRequest(req: Request, res: Response) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "Invalid dispute query", 400, "INVALID_DISPUTE_QUERY");
    return null;
  }
  const organizationId = resolveOrganizationId(req, parsed.data.organizationId);
  if (!organizationId) {
    sendError(
      res,
      req.user?.role === "system_admin"
        ? "System administrators must select an organization"
        : "Organization context is required",
      400,
      "ORGANIZATION_REQUIRED",
    );
    return null;
  }
  return { ...parsed.data, organizationId };
}

function sendListError(res: Response, error: unknown): void {
  if (error instanceof InvalidDisputeCursorError) {
    sendError(res, error.message, 400, "INVALID_DISPUTE_CURSOR");
    return;
  }
  sendError(res, "Unable to load dispute operations", 500, "SERVER_ERROR");
}

router.get("/", async (req, res) => {
  const input = parseListRequest(req, res);
  if (!input) return;
  if (input.state && !isPaymentDisputeState(input.state)) {
    return sendError(res, "Invalid dispute state", 400, "INVALID_DISPUTE_STATE");
  }
  const state = input.state && isPaymentDisputeState(input.state) ? input.state : undefined;
  try {
    sendSuccess(res, await listPaymentDisputes({
      organizationId: input.organizationId,
      limit: input.limit,
      cursor: input.cursor,
      locationId: input.locationId,
      state,
    }));
  } catch (error) {
    sendListError(res, error);
  }
});

router.get("/notifications", async (req, res) => {
  const input = parseListRequest(req, res);
  if (!input) return;
  try {
    sendSuccess(res, await listPaymentDisputeNotifications(input));
  } catch (error) {
    sendListError(res, error);
  }
});

router.get("/pending-events", async (req, res) => {
  const input = parseListRequest(req, res);
  if (!input) return;
  try {
    sendSuccess(res, await listPendingPaymentDisputeEvents(input));
  } catch (error) {
    sendListError(res, error);
  }
});

router.get("/replay-audits", async (req, res) => {
  const input = parseListRequest(req, res);
  if (!input) return;
  try {
    sendSuccess(res, await listPaymentDisputeReplayAudits(input));
  } catch (error) {
    sendListError(res, error);
  }
});

router.post("/pending-events/:eventId/replay", adminWriteLimiter, async (req, res) => {
  const parsedBody = z.object({
    organizationId: z.coerce.number().int().positive().optional(),
  }).safeParse(req.body ?? {});
  const eventId = eventIdSchema.safeParse(singleRouteParam(req.params.eventId));
  if (!parsedBody.success || !eventId.success) {
    return sendError(res, "Invalid replay request", 400, "INVALID_REPLAY_REQUEST");
  }
  const organizationId = resolveOrganizationId(req, parsedBody.data.organizationId);
  if (!organizationId || !req.user || (req.user.role !== "org_admin" && req.user.role !== "system_admin")) {
    return sendError(res, "Organization context is required", 400, "ORGANIZATION_REQUIRED");
  }
  try {
    const result = await replayPendingPaymentDisputeEvent({
      organizationId,
      eventId: eventId.data,
      actor: { userId: req.user.id, role: req.user.role },
    });
    if (!result.acknowledged) {
      return sendError(res, "Webhook event is not replayable", 409, result.code ?? "WEBHOOK_EVENT_NOT_REPLAYABLE");
    }
    sendSuccess(res, result);
  } catch (error) {
    if (error instanceof DisputeReplayError) {
      const status = error.code === "WEBHOOK_EVENT_NOT_FOUND" ? 404 : 409;
      return sendError(res, "Webhook event is not replayable", status, error.code);
    }
    sendError(res, "Unable to replay webhook event", 500, "SERVER_ERROR");
  }
});

export default router;
