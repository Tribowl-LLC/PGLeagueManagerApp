import { Router } from "express";
import { storage } from "../storage";
import * as links from "../storage/bowler-payment-links";
import { verifyLinkActionToken } from "../utils/bowler-link-tokens";
import { createLogger } from "../logger";

const log = createLogger("BowlerLinkRespond");
const router = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(opts: {
  status: number;
  title: string;
  heading: string;
  message: string;
  appUrl?: string | null;
}): { status: number; html: string } {
  const safeTitle = escapeHtml(opts.title);
  const safeHeading = escapeHtml(opts.heading);
  const safeMessage = escapeHtml(opts.message);
  const cta = opts.appUrl
    ? `<p style="margin-top:24px;"><a href="${escapeHtml(
        opts.appUrl,
      )}" style="display:inline-block;background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Open in app</a></p>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body style="font-family:Arial,sans-serif;background:#f6f6f9;margin:0;padding:40px 16px;"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><h1 style="color:#1a1a2e;margin:0 0 16px 0;font-size:22px;">${safeHeading}</h1><p style="color:#333;font-size:16px;line-height:1.5;margin:0;">${safeMessage}</p>${cta}<p style="margin-top:32px;font-size:12px;color:#999;text-align:center;">Powered by LeagueVault</p></div></body></html>`;
  return { status: opts.status, html };
}

async function appUrlForLink(linkOrgId: number | null): Promise<string> {
  if (linkOrgId == null) return "/bowler-dashboard";
  try {
    const org = await storage.getOrganization(linkOrgId);
    const { getBaseUrl } = await import("../services/email");
    return `${getBaseUrl(org ?? null)}/bowler-dashboard`;
  } catch {
    return "/bowler-dashboard";
  }
}

router.get("/accept", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const verified = verifyLinkActionToken(token);
  if (!verified.ok) {
    const page = renderPage({
      status: 400,
      title: "Invite link",
      heading: verified.reason === "EXPIRED" ? "This invite has expired" : "Invalid invite link",
      message:
        verified.reason === "EXPIRED"
          ? "Payment-partner invites expire after 14 days. Ask your partner to send a new invite."
          : "We couldn't verify this link. It may have been altered or already used.",
    });
    return res.status(page.status).type("html").send(page.html);
  }
  if (verified.data.action !== "accept") {
    const page = renderPage({
      status: 400,
      title: "Invite link",
      heading: "Invalid invite link",
      message: "This link is not an accept link.",
    });
    return res.status(page.status).type("html").send(page.html);
  }

  try {
    const link = await links.getLinkById(verified.data.linkId);
    if (!link) {
      const page = renderPage({
        status: 404,
        title: "Invite",
        heading: "Invite not found",
        message: "This invite no longer exists. It may have already been declined or removed.",
      });
      return res.status(page.status).type("html").send(page.html);
    }
    const appUrl = await appUrlForLink(link.organizationId);
    if (link.status === "accepted") {
      const page = renderPage({
        status: 200,
        title: "Already accepted",
        heading: "You're already partners",
        message: "This payment-partner invite has already been accepted.",
        appUrl,
      });
      return res.status(page.status).type("html").send(page.html);
    }
    if (link.status !== "pending") {
      const page = renderPage({
        status: 409,
        title: "Invite",
        heading: "Invite is no longer pending",
        message: "This invite can't be accepted in its current state.",
        appUrl,
      });
      return res.status(page.status).type("html").send(page.html);
    }
    const accepted = await links.acceptLink(link.id);
    if (!accepted) {
      const page = renderPage({
        status: 409,
        title: "Invite",
        heading: "Invite is no longer pending",
        message: "Someone else may have responded to this invite already.",
        appUrl,
      });
      return res.status(page.status).type("html").send(page.html);
    }
    log.info("audit:bowler_link_accept_via_email", {
      linkId: link.id,
      organizationId: link.organizationId,
      bowlerAId: link.bowlerAId,
      bowlerBId: link.bowlerBId,
    });
    const page = renderPage({
      status: 200,
      title: "Invite accepted",
      heading: "Invite accepted",
      message: "You're now linked as payment partners. You can pay each other's league fees from your saved cards.",
      appUrl,
    });
    return res.status(page.status).type("html").send(page.html);
  } catch (err) {
    log.error("accept-via-email error", err);
    const page = renderPage({
      status: 500,
      title: "Error",
      heading: "Something went wrong",
      message: "We couldn't process this invite right now. Please try again later or open the app to respond.",
    });
    return res.status(page.status).type("html").send(page.html);
  }
});

router.get("/decline", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const verified = verifyLinkActionToken(token);
  if (!verified.ok) {
    const page = renderPage({
      status: 400,
      title: "Invite link",
      heading: verified.reason === "EXPIRED" ? "This invite has expired" : "Invalid invite link",
      message:
        verified.reason === "EXPIRED"
          ? "Payment-partner invites expire after 14 days."
          : "We couldn't verify this link. It may have been altered or already used.",
    });
    return res.status(page.status).type("html").send(page.html);
  }
  if (verified.data.action !== "decline") {
    const page = renderPage({
      status: 400,
      title: "Invite link",
      heading: "Invalid invite link",
      message: "This link is not a decline link.",
    });
    return res.status(page.status).type("html").send(page.html);
  }

  try {
    const link = await links.getLinkById(verified.data.linkId);
    if (!link) {
      const page = renderPage({
        status: 200,
        title: "Invite declined",
        heading: "Invite declined",
        message: "This invite has already been removed. No further action is needed.",
      });
      return res.status(page.status).type("html").send(page.html);
    }
    if (link.status !== "pending") {
      const appUrl = await appUrlForLink(link.organizationId);
      const page = renderPage({
        status: 409,
        title: "Invite",
        heading: "Invite is no longer pending",
        message:
          link.status === "accepted"
            ? "This invite was already accepted. Open the app to remove the partnership if you no longer want it."
            : "This invite can't be declined in its current state.",
        appUrl,
      });
      return res.status(page.status).type("html").send(page.html);
    }
    await links.deleteLink(link.id);
    log.info("audit:bowler_link_decline_via_email", {
      linkId: link.id,
      organizationId: link.organizationId,
      bowlerAId: link.bowlerAId,
      bowlerBId: link.bowlerBId,
    });
    const page = renderPage({
      status: 200,
      title: "Invite declined",
      heading: "Invite declined",
      message: "We've let your partner know. No further action is needed.",
    });
    return res.status(page.status).type("html").send(page.html);
  } catch (err) {
    log.error("decline-via-email error", err);
    const page = renderPage({
      status: 500,
      title: "Error",
      heading: "Something went wrong",
      message: "We couldn't process this invite right now. Please try again later or open the app to respond.",
    });
    return res.status(page.status).type("html").send(page.html);
  }
});

export default router;
