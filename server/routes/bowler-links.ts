import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import * as links from "../storage/bowler-payment-links";
import { sendSuccess, sendError, handleZodError } from "../utils/api.js";
import { adminWriteLimiter, inviteLimiter } from "../middleware/rate-limit.js";
import { isOrgOrHigher, isPaymentManager, isSystemAdmin } from "../utils/access-control.js";
import { signLinkActionToken } from "../utils/bowler-link-tokens.js";
import { getBaseUrl, sendTemplatedEmail } from "../services/email";
import { env } from "../config";
import { createLogger } from "../logger";

type InviteEmailReason = "NO_EMAIL_ON_FILE" | "TEMPLATE_NOT_CONFIGURED" | "SEND_FAILED";

const PARTNER_INVITE_TEMPLATE_SLUG = "bowler_payment_link_invite";

const inviteEmailLog = createLogger("BowlerLinks.InviteEmail");

async function sendPartnerInviteEmail(opts: {
  linkId: number;
  inviter: { name: string | null; email: string | null };
  invitee: { name: string | null; email: string | null };
  organizationId: number;
}): Promise<{ emailSent: boolean; reason?: InviteEmailReason }> {
  const toEmail = opts.invitee.email?.trim() ?? "";
  if (!toEmail) {
    inviteEmailLog.info("Skipping partner-invite email: invitee has no email on file", {
      linkId: opts.linkId,
      organizationId: opts.organizationId,
      reason: "NO_EMAIL_ON_FILE",
    });
    return { emailSent: false, reason: "NO_EMAIL_ON_FILE" };
  }

  const template = await storage.getEmailTemplateBySlug(PARTNER_INVITE_TEMPLATE_SLUG);
  if (!template || !template.active) {
    inviteEmailLog.warn("Skipping partner-invite email: template missing or inactive", {
      linkId: opts.linkId,
      organizationId: opts.organizationId,
      slug: PARTNER_INVITE_TEMPLATE_SLUG,
      reason: "TEMPLATE_NOT_CONFIGURED",
    });
    return { emailSent: false, reason: "TEMPLATE_NOT_CONFIGURED" };
  }

  if (!env.SENDGRID_API_KEY) {
    inviteEmailLog.warn("Skipping partner-invite email: SENDGRID_API_KEY not configured", {
      linkId: opts.linkId,
      organizationId: opts.organizationId,
      reason: "SEND_FAILED",
    });
    return { emailSent: false, reason: "SEND_FAILED" };
  }

  const org = await storage.getOrganization(opts.organizationId);
  const baseUrl = getBaseUrl(org ?? null);
  const acceptToken = signLinkActionToken(opts.linkId, "accept");
  const declineToken = signLinkActionToken(opts.linkId, "decline");
  const acceptLink = `${baseUrl}/api/bowler-link-respond/accept?token=${encodeURIComponent(acceptToken)}`;
  const declineLink = `${baseUrl}/api/bowler-link-respond/decline?token=${encodeURIComponent(declineToken)}`;
  const appLink = `${baseUrl}/bowler-dashboard`;

  const inviterName = opts.inviter.name?.trim() || opts.inviter.email || "A bowler";
  const inviteeName = opts.invitee.name?.trim() || "there";
  const variables: Record<string, string> = {
    inviter_name: inviterName,
    invitee_name: inviteeName,
    organization_name: org?.name ?? "your league",
    accept_link: acceptLink,
    decline_link: declineLink,
    app_link: appLink,
  };

  try {
    const sent = await sendTemplatedEmail(PARTNER_INVITE_TEMPLATE_SLUG, toEmail, variables);
    if (!sent) {
      inviteEmailLog.warn("Partner-invite email send returned false", {
        linkId: opts.linkId,
        organizationId: opts.organizationId,
        reason: "SEND_FAILED",
      });
      return { emailSent: false, reason: "SEND_FAILED" };
    }
    return { emailSent: true };
  } catch (err) {
    inviteEmailLog.warn("Partner-invite email send threw", {
      linkId: opts.linkId,
      organizationId: opts.organizationId,
      reason: "SEND_FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
    return { emailSent: false, reason: "SEND_FAILED" };
  }
}

const log = createLogger("BowlerLinks");
const router = Router();

// Payment managers are staff operators, never bowlers. This route manages
// bowler-to-bowler payment links and therefore must not become reachable from
// a stale bowlerId on a staff account while identity data is being migrated.
router.use((req, res, next) => {
  if (isPaymentManager(req.user)) {
    return sendError(res, "Bowler link access is not available to staff accounts", 403, "FORBIDDEN");
  }
  next();
});

const inviteSchema = z
  .object({
    inviteeEmail: z.string().trim().toLowerCase().email().optional(),
    inviteeBowlerId: z.number().int().positive().optional(),
  })
  .refine((d) => !!d.inviteeEmail !== !!d.inviteeBowlerId, {
    message: "Provide exactly one of inviteeEmail or inviteeBowlerId",
  });

const adminLinkSchema = z.object({
  bowlerAId: z.number().int().positive(),
  bowlerBId: z.number().int().positive(),
});

router.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user?.bowlerId) {
      return sendSuccess(res, { links: [], hasAny: false });
    }
    const all = await links.listLinksForBowler(user.bowlerId);
    const scoped = user.organizationId
      ? all.filter((l) => l.organizationId === user.organizationId)
      : [];

    const enriched = await Promise.all(
      scoped.map(async (l) => {
        const inviter = l.createdByUserId
          ? await storage.getUser(l.createdByUserId)
          : undefined;
        const inviterBowlerId = inviter?.bowlerId ?? null;
        const partnerId =
          l.bowlerAId === user.bowlerId ? l.bowlerBId : l.bowlerAId;
        const partner = await storage.getBowler(partnerId);
        const partnerName = partner
          ? partner.name?.trim() || partner.email || `Bowler #${partnerId}`
          : `Bowler #${partnerId}`;
        return { ...l, inviterBowlerId, partnerBowlerId: partnerId, partnerName };
      }),
    );
    return sendSuccess(res, { links: enriched, hasAny: enriched.length > 0 });
  } catch (err) {
    log.error("list error", err);
    return sendError(res, "Failed to list links");
  }
});

router.post("/invite", inviteLimiter, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.bowlerId) {
      return sendError(res, "Only bowlers can invite a partner", 403, "FORBIDDEN");
    }
    if (!user.organizationId) {
      return sendError(res, "Organization required", 400, "ORG_REQUIRED");
    }
    const { inviteeEmail, inviteeBowlerId } = inviteSchema.parse(req.body);

    const inviter = await storage.getBowler(user.bowlerId);
    if (!inviter || inviter.organizationId === null) {
      return sendError(res, "Inviter bowler is org-less", 403, "ORG_REQUIRED");
    }

    let invitee;
    if (inviteeBowlerId) {
      if (inviteeBowlerId === user.bowlerId) {
        return sendError(res, "Cannot link a bowler to themselves", 400, "SELF_LINK");
      }
      invitee = await storage.getBowler(inviteeBowlerId);
      if (!invitee) {
        return sendError(res, "Bowler not found", 404, "NOT_FOUND");
      }
      // Reject unclaimed bowlers — an invite is only actionable if the
      // target bowler has a linked user account who can accept it.
      const inviteeUser = await storage.getUserByBowlerId(invitee.id);
      if (!inviteeUser) {
        return sendError(
          res,
          "That bowler hasn't claimed their account yet, so they can't accept an invite.",
          400,
          "UNCLAIMED_BOWLER",
        );
      }
    } else {
      const email = inviteeEmail ?? "";
      if ((inviter.email ?? "").toLowerCase() === email) {
        return sendError(res, "Cannot link a bowler to themselves", 400, "SELF_LINK");
      }
      invitee = await storage.getBowlerByEmailInOrg(email, user.organizationId);
      if (!invitee) {
        return sendError(res, "No bowler in your organization has that email", 404, "NOT_FOUND");
      }
    }
    if (invitee.id === user.bowlerId) {
      return sendError(res, "Cannot link a bowler to themselves", 400, "SELF_LINK");
    }
    if (invitee.organizationId !== inviter.organizationId) {
      return sendError(res, "Cross-org links are not allowed", 403, "CROSS_ORG_DENIED");
    }

    const existing = await links.getLinkBetween(inviter.id, invitee.id);
    if (existing) {
      return sendError(
        res,
        existing.status === "accepted" ? "Already linked" : "Invite already pending",
        409,
        "CONFLICT",
      );
    }

    const created = await links.createLinkInvite({
      inviterBowlerId: inviter.id,
      inviteeBowlerId: invitee.id,
      organizationId: user.organizationId,
      createdByUserId: user.id,
    });

    // Email send must NEVER roll back the invite (task #704). Failures
    // are surfaced via `emailSent` / `reason` so the client can show a
    // contextual hint, but the link row stays put.
    let emailResult: { emailSent: boolean; reason?: InviteEmailReason } = {
      emailSent: false,
      reason: "SEND_FAILED",
    };
    try {
      emailResult = await sendPartnerInviteEmail({
        linkId: created.id,
        inviter: { name: inviter.name, email: inviter.email },
        invitee: { name: invitee.name, email: invitee.email },
        organizationId: user.organizationId,
      });
    } catch (emailErr) {
      log.error("invite email error (non-fatal)", emailErr);
    }

    return sendSuccess(res, { ...created, ...emailResult }, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return handleZodError(res, err);
    log.error("invite error", err);
    return sendError(res, "Failed to create invite");
  }
});

router.post("/:id/accept", async (req, res) => {
  try {
    const user = req.user;
    const id = parseInt(req.params.id, 10);
    if (!user?.bowlerId) {
      return sendError(res, "Only bowlers can respond to invites", 403, "FORBIDDEN");
    }
    if (!Number.isFinite(id)) {
      return sendError(res, "Invalid id", 400, "INVALID_ID");
    }
    const link = await links.getLinkById(id);
    if (!link) return sendError(res, "Link not found", 404, "NOT_FOUND");
    if (link.status !== "pending") {
      return sendError(res, "Invite is not pending", 409, "CONFLICT");
    }
    if (!link.createdByUserId) {
      return sendError(res, "Invite is no longer valid", 410, "GONE");
    }
    const inviter = await storage.getUser(link.createdByUserId);
    const inviterBowlerId = inviter?.bowlerId ?? null;
    if (
      inviterBowlerId !== link.bowlerAId &&
      inviterBowlerId !== link.bowlerBId
    ) {
      return sendError(res, "Invite is no longer valid", 410, "GONE");
    }
    const inviteeBowlerId =
      inviterBowlerId === link.bowlerAId ? link.bowlerBId : link.bowlerAId;
    if (user.bowlerId !== inviteeBowlerId) {
      return sendError(res, "Only the invitee can accept", 403, "FORBIDDEN");
    }
    if (user.organizationId !== link.organizationId) {
      return sendError(res, "Cross-org accept", 403, "CROSS_ORG_DENIED");
    }
    const accepted = await links.acceptLink(id);
    if (!accepted) return sendError(res, "Invite no longer pending", 409, "CONFLICT");
    return sendSuccess(res, accepted);
  } catch (err) {
    log.error("accept error", err);
    return sendError(res, "Failed to accept invite");
  }
});

router.post("/:id/decline", async (req, res) => {
  try {
    const user = req.user;
    const id = parseInt(req.params.id, 10);
    if (!user?.bowlerId) {
      return sendError(res, "Only bowlers can respond to invites", 403, "FORBIDDEN");
    }
    if (!Number.isFinite(id)) return sendError(res, "Invalid id", 400, "INVALID_ID");
    const link = await links.getLinkById(id);
    if (!link) return sendError(res, "Link not found", 404, "NOT_FOUND");
    if (link.status !== "pending") {
      return sendError(res, "Invite is not pending", 409, "CONFLICT");
    }
    if (user.organizationId !== link.organizationId) {
      return sendError(res, "Cross-org decline", 403, "CROSS_ORG_DENIED");
    }
    if (user.bowlerId !== link.bowlerAId && user.bowlerId !== link.bowlerBId) {
      return sendError(res, "Not your invite", 403, "FORBIDDEN");
    }
    await links.deleteLink(id);
    log.info("audit:bowler_link_decline", {
      actorUserId: user.id,
      organizationId: link.organizationId,
      linkId: id,
      bowlerAId: link.bowlerAId,
      bowlerBId: link.bowlerBId,
    });
    return sendSuccess(res, { id });
  } catch (err) {
    log.error("decline error", err);
    return sendError(res, "Failed to decline invite");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const user = req.user;
    const id = parseInt(req.params.id, 10);
    if (!user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
    if (!Number.isFinite(id)) return sendError(res, "Invalid id", 400, "INVALID_ID");
    const link = await links.getLinkById(id);
    if (!link) return sendError(res, "Link not found", 404, "NOT_FOUND");

    const isAdmin =
      isSystemAdmin(user) ||
      (isOrgOrHigher(user) && user.organizationId === link.organizationId);
    const isParty =
      !!user.bowlerId &&
      user.organizationId === link.organizationId &&
      (user.bowlerId === link.bowlerAId || user.bowlerId === link.bowlerBId);
    if (!isAdmin && !isParty) {
      return sendError(res, "Not allowed", 403, "FORBIDDEN");
    }
    await links.deleteLink(id);
    if (isAdmin) {
      log.info("admin_audit:bowler_link_remove", {
        adminUserId: user.id,
        organizationId: link.organizationId,
        linkId: id,
        bowlerAId: link.bowlerAId,
        bowlerBId: link.bowlerBId,
      });
    }
    return sendSuccess(res, { id });
  } catch (err) {
    log.error("delete error", err);
    return sendError(res, "Failed to remove link");
  }
});

router.get("/admin", async (req, res) => {
  try {
    const user = req.user;
    if (!user || !isOrgOrHigher(user)) {
      return sendError(res, "Admin access required", 403, "FORBIDDEN");
    }
    let orgId = user.organizationId ?? null;
    if (isSystemAdmin(user)) {
      const raw = req.query.organizationId;
      const parsed = typeof raw === "string" ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) orgId = parsed;
    }
    if (!orgId) {
      return sendError(res, "Organization required", 400, "ORG_REQUIRED");
    }
    const all = await links.listLinksForOrg(orgId);
    const enriched = await Promise.all(
      all.map(async (l) => {
        const [a, b] = await Promise.all([
          storage.getBowler(l.bowlerAId),
          storage.getBowler(l.bowlerBId),
        ]);
        const labelOf = (id: number, bowler: typeof a) =>
          bowler ? bowler.name?.trim() || bowler.email || `Bowler #${id}` : `Bowler #${id}`;
        return {
          ...l,
          bowlerAName: labelOf(l.bowlerAId, a),
          bowlerBName: labelOf(l.bowlerBId, b),
        };
      }),
    );
    return sendSuccess(res, { links: enriched });
  } catch (err) {
    log.error("admin list error", err);
    return sendError(res, "Failed to list links");
  }
});

router.post("/admin", adminWriteLimiter, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !isOrgOrHigher(user)) {
      return sendError(res, "Admin access required", 403, "FORBIDDEN");
    }
    if (!user.organizationId && !isSystemAdmin(user)) {
      return sendError(res, "Organization required", 400, "ORG_REQUIRED");
    }
    const { bowlerAId, bowlerBId } = adminLinkSchema.parse(req.body);
    if (bowlerAId === bowlerBId) {
      return sendError(res, "Cannot link a bowler to themselves", 400, "SELF_LINK");
    }

    const [a, b] = await Promise.all([
      storage.getBowler(bowlerAId),
      storage.getBowler(bowlerBId),
    ]);
    if (!a || !b) return sendError(res, "Bowler not found", 404, "NOT_FOUND");
    if (a.organizationId === null || b.organizationId === null) {
      return sendError(res, "Org-less bowler cannot be linked", 403, "ORG_REQUIRED");
    }
    if (a.organizationId !== b.organizationId) {
      return sendError(res, "Cross-org links are not allowed", 403, "CROSS_ORG_DENIED");
    }
    if (a.organizationId !== user.organizationId && !isSystemAdmin(user)) {
      return sendError(res, "Outside your organization", 403, "CROSS_ORG_DENIED");
    }

    const existing = await links.getLinkBetween(a.id, b.id);
    if (existing) {
      if (existing.status === "pending") {
        const accepted = await links.acceptLink(existing.id);
        return sendSuccess(res, accepted ?? existing);
      }
      return sendSuccess(res, existing);
    }

    const created = await links.createAcceptedLink({
      bowlerAId: a.id,
      bowlerBId: b.id,
      organizationId: a.organizationId,
      createdByUserId: user.id,
    });
    log.info("admin_audit:bowler_link_create", {
      adminUserId: user.id,
      organizationId: a.organizationId,
      linkId: created.id,
      bowlerAId: a.id,
      bowlerBId: b.id,
    });
    return sendSuccess(res, created, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return handleZodError(res, err);
    log.error("admin create error", err);
    return sendError(res, "Failed to create link");
  }
});

export default router;
