import type { Request } from "express";
import { storage } from "../storage";
import * as links from "../storage/bowler-payment-links";

/**
 * Partner-pay: pay-for-partner authorization.
 *
 * Returns true when the request's session user is allowed to initiate
 * a charge whose target bowler is `targetBowlerId`. Allowed when:
 *   - the user is linked to that bowler directly (own bowler), OR
 *   - the user owns a bowler in the same org that has an ACCEPTED
 *     bowler_payment_link with the target bowler.
 *
 * The payer's own vault (paymentCustomerId) is the only one ever
 * resolved by call sites — the helper does NOT touch the target
 * bowler's vault. That invariant lives in the caller; this helper
 * just answers "may this user pay for that bowler?".
 *
 * Org-less bowlers are denied even for system_admin, mirroring the
 * org-less data policy in `server/utils/access-control.ts`.
 */
export async function canUserPayForBowler(
  req: Request,
  targetBowlerId: number,
): Promise<{ allowed: boolean; payerBowlerId?: number; reason?: string }> {
  const user = req.user;
  if (!user) return { allowed: false, reason: "unauthenticated" };

  const target = await storage.getBowler(targetBowlerId);
  if (!target) return { allowed: false, reason: "target_not_found" };
  if (target.organizationId === null) return { allowed: false, reason: "orgless_target" };

  // System-admins can pay for any bowler in any org through the admin
  // payment-record path, but NOT through the pay-for-partner saved-card
  // / wallet path — they have no payerBowler / vault. Caller treats
  // missing payerBowlerId as "no vault available" and rejects.
  if (user.role === "system_admin" && !user.bowlerId) {
    return { allowed: false, reason: "system_admin_no_bowler" };
  }

  if (!user.bowlerId) {
    return { allowed: false, reason: "no_payer_bowler" };
  }

  // Cross-org never allowed.
  if (user.organizationId !== target.organizationId) {
    return { allowed: false, reason: "cross_org" };
  }

  // Self.
  if (user.bowlerId === targetBowlerId) {
    return { allowed: true, payerBowlerId: user.bowlerId };
  }

  const partners = await links.getAcceptedPartnerBowlerIds(user.bowlerId, target.organizationId);
  if (partners.includes(targetBowlerId)) {
    return { allowed: true, payerBowlerId: user.bowlerId };
  }

  return { allowed: false, reason: "not_linked" };
}
