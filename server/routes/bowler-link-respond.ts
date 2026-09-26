import { Router } from "express";
import { storage } from "../storage";
import * as links from "../storage/bowler-payment-links";
import { verifyLinkActionToken } from "../utils/bowler-link-tokens";
import { createLogger } from "../logger";
import { renderPage } from "./bowler-link-response-page";

const log = createLogger("BowlerLinkRespond");
const router = Router();

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
        tone: "declined",
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
      tone: "declined",
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
