import { Request } from 'express';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { db } from '../db.js';
import { and, eq } from 'drizzle-orm';
import { leagues, paymentOccurrenceAllocations } from '@shared/schema';

const log = createLogger("AccessControl");

/**
 * Org-less resource policy
 * ------------------------
 * Resources with `organizationId === null` are treated as orphaned data — they
 * are usually the result of a bug or stale data. We deny access to them for
 * EVERY role, including `system_admin`, regardless of the surrounding context.
 *
 * If a system admin needs to inspect or repair orphaned rows, they must do so
 * through an explicit "orphaned data" admin tool (see
 * `GET /api/system-admin/orphaned-data-counts` and any future repair endpoints
 * built on top of it). The general-purpose CRUD/read paths must never expose
 * org-less rows. This keeps PII contained and surfaces data-integrity bugs
 * instead of silently absorbing them.
 *
 * Logging convention for the deny-on-null branches below
 * ------------------------------------------------------
 * The org-less drift signal is a development/debug aid, NOT a production
 * alarm: the access-deny is the actual safety behavior, and the message
 * pairs a user id with a resource id in plain text — exactly the kind of
 * correlatable PII we don't want shipped to a production log sink at warn
 * level. We therefore log these messages at `log.debug` so they only fire
 * when `LOG_LEVEL=debug` (the dev default per `server/logger.ts`); a
 * production deploy that sets `LOG_LEVEL=info` (or higher) will suppress
 * them entirely. The drift signal itself remains observable in production
 * via the system-admin "Data integrity" surface
 * (`GET /api/system-admin/orphaned-data-counts` and friends — see AGENTS.md
 * for the full route list). Any new deny-on-null branch added to this file
 * MUST follow the same `log.debug` convention.
 */

export function isSystemAdmin(user: Express.User | undefined): boolean {
  return user?.role === 'system_admin';
}

export function isOrgOrHigher(user: Express.User | undefined): boolean {
  return user?.role === 'org_admin' || user?.role === 'system_admin';
}

/**
 * Payment managers are location-scoped operators.  Keep this check separate
 * from `isOrgOrHigher`: a payment manager may operate the configured leagues
 * at their assigned location, but is not an organization administrator.
 *
 * The role is intentionally compared as a string so this helper remains
 * source-compatible while deployments roll out the shared role enum.
 */
export function isPaymentManager(user: Express.User | undefined): boolean {
  return (user?.role as string | undefined) === 'payment_manager';
}

function hasPaymentManagerScope(user: Express.User | undefined): user is Express.User {
  if (!isPaymentManager(user) || !user) return false;
  return Number.isSafeInteger(user.organizationId)
    && (user.organizationId ?? 0) > 0
    && Number.isSafeInteger(user.locationId)
    && (user.locationId ?? 0) > 0;
}

/** Return the configured league IDs a payment manager may operate. */
export async function getPaymentManagerAccessibleLeagueIds(req: Request): Promise<number[]> {
  const user = req.user;
  if (!hasPaymentManagerScope(user)) return [];
  const organizationId = user.organizationId;
  const locationId = user.locationId;
  if (organizationId === null || locationId === null) return [];
  const leagues = await storage.getLeagues(organizationId);
  return leagues
    .filter((league) =>
      league.organizationId !== null
      && league.locationId !== null
      && league.organizationId === organizationId
      && league.locationId === locationId,
    )
    .map((league) => league.id);
}

/**
 * Location-scoped league access for payment-manager operations.
 *
 * A missing organization, missing assigned location, null league location,
 * null league organization, or either tenant mismatch fails closed.  This is
 * deliberately not folded into `hasAdminAccessToLeague`, because financial
 * activation and other administrator-only routes must continue to reject
 * payment managers.
 */
export async function hasPaymentManagerAccessToLeague(req: Request, leagueId: number): Promise<boolean> {
  const user = req.user;
  if (!hasPaymentManagerScope(user)) return false;
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || league.locationId === null) {
    return false;
  }
  return league.organizationId === user.organizationId
    && league.locationId === user.locationId;
}

/** Access to a team whose parent league is assigned to the payment manager. */
export async function hasPaymentManagerAccessToTeam(req: Request, teamId: number): Promise<boolean> {
  if (!isPaymentManager(req.user)) return false;
  const team = await storage.getTeam(teamId);
  return !!team && hasPaymentManagerAccessToLeague(req, team.leagueId);
}

/**
 * Access to a rostered bowler for a payment manager.  A bowler is reachable
 * only through an active membership in a configured league at the assigned
 * location; an organization stamp alone is never sufficient.
 */
export async function hasPaymentManagerAccessToBowler(req: Request, bowlerId: number): Promise<boolean> {
  const user = req.user;
  if (!isPaymentManager(user)) return false;
  const bowler = await storage.getBowler(bowlerId);
  if (!bowler || bowler.organizationId === null || bowler.organizationId !== user?.organizationId) {
    return false;
  }
  const accessibleLeagueIds = new Set(await getPaymentManagerAccessibleLeagueIds(req));
  if (accessibleLeagueIds.size === 0) return false;
  const memberships = await storage.getBowlerLeagues({ bowlerId });
  return memberships.some((membership) => membership.active && accessibleLeagueIds.has(membership.leagueId));
}

/** Return rostered bowler IDs visible to a payment manager's location. */
export async function getPaymentManagerAccessibleBowlerIds(req: Request): Promise<number[]> {
  const user = req.user;
  if (!hasPaymentManagerScope(user)) return [];
  const leagueIds = await getPaymentManagerAccessibleLeagueIds(req);
  if (leagueIds.length === 0) return [];
  const memberships = (await Promise.all(
    leagueIds.map((leagueId) => storage.getBowlerLeagues({ leagueId })),
  )).flat();
  const ids = [...new Set(memberships.filter((membership) => membership.active).map((membership) => membership.bowlerId))];
  if (ids.length === 0) return [];
  const bowlers = await storage.getBowlersByIds(ids);
  return bowlers
    .filter((bowler) => bowler.organizationId === user.organizationId)
    .map((bowler) => bowler.id);
}

/** Payment-row access for location-scoped bookkeeping and receipts. */
export async function hasPaymentManagerAccessToPayment(req: Request, paymentId: number): Promise<boolean> {
  if (!isPaymentManager(req.user)) return false;
  const payment = req.user?.organizationId && typeof storage.getPaymentByIdForOrganization === "function"
    ? await storage.getPaymentByIdForOrganization(paymentId, req.user.organizationId)
    : await storage.getPaymentById(paymentId);
  return !!payment && hasPaymentManagerAccessToLeague(req, payment.leagueId);
}

/** Administrator or location-scoped payment-manager league operations. */
export async function hasLeagueOperationsAccess(req: Request, leagueId: number): Promise<boolean> {
  if (await hasAdminAccessToLeague(req, leagueId)) return true;
  return hasPaymentManagerAccessToLeague(req, leagueId);
}

export function requireOrganizationAccess(req: Request, resourceOrgId: number | null, resourceType?: string, resourceId?: number | string): boolean {
  if (!req.user) return false;
  if (resourceOrgId === null) {
    log.debug(`${resourceType ?? 'resource'} ${resourceId ?? '?'} has no organization — denying access to user ${req.user.id} (role=${req.user.role})`);
    return false;
  }
  if (isSystemAdmin(req.user)) return true;
  return req.user.organizationId === resourceOrgId;
}

/**
 * Returns true for system administrators or an organization administrator
 * in the league's organization.
 */
export async function hasAdminAccessToLeague(req: Request, leagueId: number): Promise<boolean> {
  if (!req.user) return false;
  const league = await storage.getLeague(leagueId);
  if (!league) return false;
  if (league.organizationId === null) {
    log.debug(`league ${leagueId} has no organization — denying admin access to user ${req.user.id} (role=${req.user.role})`);
    return false;
  }
  if (isSystemAdmin(req.user)) return true;
  return req.user.role === 'org_admin' && req.user.organizationId === league.organizationId;
}

/**
 * League reads remain limited to administrators and rostered bowlers.
 * Plain organization membership does not grant league access.
 */
export async function hasAccessToLeague(req: Request, leagueId: number): Promise<boolean> {
  if (!req.user) {
    return false;
  }

  const league = await storage.getLeague(leagueId);
  if (!league) {
    return false;
  }

  if (league.organizationId === null) {
    log.debug(`league ${leagueId} has no organization — denying access to user ${req.user.id} (role=${req.user.role})`);
    return false;
  }

  // Payment managers are not bowlers and therefore cannot qualify through
  // the rostered-bowler branch below. Their league visibility is explicitly
  // constrained to the assigned location.
  if (isPaymentManager(req.user)) {
    return league.locationId !== null
      && req.user.organizationId === league.organizationId
      && req.user.locationId === league.locationId
      && hasPaymentManagerScope(req.user);
  }

  if (isSystemAdmin(req.user)) {
    return true;
  }

  if (req.user.bowlerId) {
    const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId });
    if (bowlerLeagues.some((bl) => bl.leagueId === leagueId)) {
      return true;
    }
  }

  if (!req.user.organizationId) {
    return false;
  }

  // Organization match alone is NOT sufficient for plain
  // `user`-role callers. Previously any user whose `organizationId`
  // matched the league's org could see every league in the org, which
  // exposed every league in the organization. We restrict the
  // org-match shortcut to `org_admin`/`system_admin` and require
  // non-admin callers to either be a bowler in the league (handled
  // above).
  if (isOrgOrHigher(req.user) && req.user.organizationId === league.organizationId) {
    return true;
  }

  // Plain users without a roster membership have no league access.
  return false;
}

export async function hasAccessToTeam(req: Request, teamId: number): Promise<boolean> {
  if (!req.user) {
    return false;
  }

  const team = await storage.getTeam(teamId);
  if (!team) {
    return false;
  }

  return hasAccessToLeague(req, team.leagueId);
}

/**
 * Single-bowler access check. Use this only for endpoints that gate on a
 * single bowler ID. For any endpoint that operates on a list of bowler IDs
 * (request body or query), call `hasAccessToBowlers(req, bowlerIds)` instead
 * of looping this helper — looping causes N×3 query amplification, while the
 * batched helper does a constant number of storage reads regardless of input
 * size and matches the same access semantics exactly.
 */
export async function hasAccessToBowler(req: Request, bowlerId: number): Promise<boolean> {
  if (!req.user) {
    return false;
  }

  // Staff accounts must never be represented as bowlers. Do not let a stale
  // bowlerId on a payment-manager row activate the ordinary self-access path.
  if (isPaymentManager(req.user)) {
    return hasPaymentManagerAccessToBowler(req, bowlerId);
  }

  // Self-access shortcut: a user may always read their own linked bowler
  // record, even if every league assignment is currently org-less. This is
  // an intentional, narrowly scoped exception to the org-less deny rule so
  // bowlers are never locked out of their own profile.
  if (req.user.bowlerId === bowlerId) {
    return true;
  }

  // Owning-organization gate (task #342, tightened in task #407 once
  // `bowlers.organizationId` became NOT NULL). Every bowler row that
  // exists carries an authoritative org stamp; admin/sysadmin callers
  // are gated on it directly without falling back to the league-based
  // scan.
  //   - Sysadmin → allowed.
  //   - Org user matching the stamp → allowed.
  //   - Org user with a different stamp → DENIED (no league fallback
  //     for admins; this is the hardening the task explicitly required).
  //   - Caller is a non-admin "user" role with their own bowlerId →
  //     fall through to the league scan so the long-standing
  //     bowler-to-bowler same-league self-membership rule still holds
  //     (two bowlers who share a league can see each other regardless
  //     of stamps). This narrowly scoped fall-through preserves the
  //     bowler-self UX without widening admin access.
  // A missing bowler row (deleted concurrently) falls through to the
  // league-based scan, which will then deny because there are no
  // league entries for a non-existent bowler. A row whose
  // `organizationId` is NULL is treated as an org-less / orphaned row
  // per the file-level policy at the top of this module — the stamp
  // gate cannot decide it (no role may short-circuit-allow on a null
  // stamp), so it also falls through to the league scan, which will
  // skip every org-less league with a debug log and effectively deny.
  // The schema currently enforces NOT NULL on this column, but the
  // gate is hardened defensively so a future schema drift or stale
  // mock can't silently widen access.
  const bowlerRow = await storage.getBowler(bowlerId);
  if (bowlerRow && bowlerRow.organizationId !== null) {
    if (isSystemAdmin(req.user)) {
      return true;
    }

    // Organization stamp match alone is NOT sufficient
    // for plain `user`-role callers. Previously any user whose
    // `organizationId` matched the bowler's org could read every
    // bowler in the org, which leaked sibling-league bowler data and
    // exposed sibling-league bowler data. The org-match
    // shortcut is now restricted to org_admin/system_admin; non-admin
    // callers must qualify via the
    // bowler-self league overlap rule in the league scan.
    if (
      isOrgOrHigher(req.user) &&
      req.user.organizationId &&
      req.user.organizationId === bowlerRow.organizationId
    ) {
      return true;
    }
    // Admin from a different org → DENIED authoritatively (no league
    // fallback for admins). Non-admin "user" → fall through to the
    // league scan below.
    if (isOrgOrHigher(req.user)) {
      return false;
    }
  }

  const bowlerLeagueEntries = await storage.getBowlerLeagues({ bowlerId });

  if (bowlerLeagueEntries.length === 0) {
    return false;
  }

  const leagueIds = [...new Set(bowlerLeagueEntries.map(bl => bl.leagueId))];
  const fetchedLeagues = await storage.getLeaguesByIds(leagueIds);

  let userLeagueIds: number[] = [];
  if (req.user.bowlerId) {
    const userBowlerLeagues = await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId });
    userLeagueIds = userBowlerLeagues.map(bl => bl.leagueId);
  }

  const userIsSystemAdmin = isSystemAdmin(req.user);

  for (const league of fetchedLeagues) {
    if (req.user.bowlerId && userLeagueIds.includes(league.id)) {
      return true;
    }
    if (league.organizationId === null) {
      log.debug(`bowler ${bowlerId} via league ${league.id} has no organization — denying access to user ${req.user.id} (role=${req.user.role})`);
      continue;
    }
    if (userIsSystemAdmin) {
      return true;
    }
    // Same rule as the bowler-row stamp gate
    // above — only org_admin / system_admin get the org-wide league
    // shortcut. Plain `user` callers must qualify via the bowler-self
    // membership rule (handled at the top of the loop) or the
    // membership rule.
    if (
      isOrgOrHigher(req.user) &&
      req.user.organizationId &&
      req.user.organizationId === league.organizationId
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Batched access check: returns a Map<bowlerId, boolean> indicating whether
 * the requesting user may access each bowler. Uses a constant number of
 * storage reads (at most one batched bowler-leagues lookup and one batched
 * leagues lookup) regardless of how many bowler IDs are passed in. This is
 * the amplification-safe replacement for looping `hasAccessToBowler` over
 * an array.
 *
 * Semantics match `hasAccessToBowler` exactly:
 *  - Unauthenticated → all denied.
 *  - Self-access shortcut for `req.user.bowlerId`.
 *  - Bowlers with no league entries → denied for everyone (incl. system admin).
 *  - Org-less leagues are skipped (and debug-logged) for every role.
 *  - System admins are allowed via any non-org-less league entry.
 *  - Org users are allowed when their org matches a league's organizationId.
 *  - Users sharing a league with the target bowler are allowed.
 *
 * Duplicate IDs are de-duplicated; the returned map is keyed by the unique
 * input IDs. Empty input returns an empty map.
 */
export async function hasAccessToBowlers(
  req: Request,
  bowlerIds: number[],
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  const uniqueIds = [...new Set(bowlerIds)];

  if (uniqueIds.length === 0) {
    return result;
  }

  for (const id of uniqueIds) {
    result.set(id, false);
  }

  if (!req.user) {
    return result;
  }

  if (isPaymentManager(req.user)) {
    const accessibleIds = new Set(await getPaymentManagerAccessibleBowlerIds(req));
    for (const id of uniqueIds) result.set(id, accessibleIds.has(id));
    return result;
  }

  const userBowlerId = req.user.bowlerId ?? null;

  // Self-access shortcut: a user may always access their own linked bowler
  // record, even if every league assignment is currently org-less.
  const idsToCheck = new Set<number>();
  for (const id of uniqueIds) {
    if (userBowlerId !== null && id === userBowlerId) {
      result.set(id, true);
    } else {
      idsToCheck.add(id);
    }
  }

  if (idsToCheck.size === 0) {
    return result;
  }

  // Owning-organization gate (task #342, tightened in task #407 once
  // `bowlers.organizationId` became NOT NULL). Mirror the single-bowler
  // helper: batch-fetch the bowler rows and decide each id authoritatively
  // by its stamped `organizationId`:
  //   - Row present + sysadmin → allow (decided here, no fallthrough).
  //   - Row present + same org → allow (decided here, no fallthrough).
  //   - Row present + admin caller from a different org → DENY here
  //     (no league fallback for admins; this is the hardening required).
  //   - Row present + non-admin "user" caller with a stamp mismatch →
  //     fall through so the bowler-to-bowler same-league self-membership
  //     rule below can still grant access (two bowlers sharing a league
  //     can see each other regardless of stamps).
  //   - Row missing (deleted concurrently) → fall through to the league
  //     scan, which will deny because no league entries exist.
  const callerIsSystemAdmin = isSystemAdmin(req.user);
  const callerIsOrgOrHigher = isOrgOrHigher(req.user);
  const callerOrgIdShort = req.user.organizationId ?? null;
  const fetchedBowlers = await storage.getBowlersByIds([...idsToCheck]);
  // Map value is `number | null` defensively: the schema enforces
  // NOT NULL on `bowlers.organizationId` today, but a null stamp
  // (drift / stale data) must NOT short-circuit-allow per the
  // file-level org-less resource policy, and the gate below relies
  // on being able to distinguish "no row" (undefined) from "null
  // stamp" (null) so the latter falls through to the league scan.
  const stampedOrgByBowler = new Map<number, number | null>();
  for (const b of fetchedBowlers) {
    stampedOrgByBowler.set(b.id, b.organizationId);
  }
  const stillToCheck = new Set<number>();
  for (const id of idsToCheck) {
    const stamp = stampedOrgByBowler.get(id);
    if (stamp !== undefined && stamp !== null) {
      if (callerIsSystemAdmin) {
        result.set(id, true);
        continue;
      }
      // Organization-stamp match shortcut restricted to
      // admins. Non-admin "user" callers must qualify via the league
      // self-membership rule below.
      if (
        callerIsOrgOrHigher &&
        callerOrgIdShort !== null &&
        callerOrgIdShort === stamp
      ) {
        result.set(id, true);
        continue;
      }
      // Stamp mismatch (or non-admin same-org with no league
      // overlap). Admins are denied authoritatively. Non-admin users
      // fall through to the league scan for the self-membership rule.
      if (callerIsOrgOrHigher) {
        // result already initialized to false above; keep as-is and
        // do NOT add to stillToCheck.
        continue;
      }
    }
    stillToCheck.add(id);
  }
  if (stillToCheck.size === 0) {
    return result;
  }

  // Fold the requesting user's own bowlerId into the same batched lookup so
  // we can compute their league memberships in the same DB round-trip.
  const lookupIds = new Set<number>(stillToCheck);
  if (userBowlerId !== null) {
    lookupIds.add(userBowlerId);
  }

  const allBowlerLeagueEntries = await storage.getBowlerLeaguesByBowlerIds([...lookupIds]);

  const userLeagueIds = new Set<number>();
  const leagueIdsByBowler = new Map<number, number[]>();
  for (const entry of allBowlerLeagueEntries) {
    if (userBowlerId !== null && entry.bowlerId === userBowlerId) {
      userLeagueIds.add(entry.leagueId);
    }
    // Only collect league entries for IDs that ARE still in the
    // fallback pool. IDs already decided by the org-stamp gate above
    // (allowed for matching org, denied for admin/mismatch) must NOT
    // be re-evaluated here — otherwise an admin-denied stamped bowler
    // could be incorrectly re-allowed via a league overlap.
    if (stillToCheck.has(entry.bowlerId)) {
      const list = leagueIdsByBowler.get(entry.bowlerId);
      if (list) {
        list.push(entry.leagueId);
      } else {
        leagueIdsByBowler.set(entry.bowlerId, [entry.leagueId]);
      }
    }
  }

  const allLeagueIds = new Set<number>(userLeagueIds);
  for (const list of leagueIdsByBowler.values()) {
    for (const id of list) allLeagueIds.add(id);
  }

  if (allLeagueIds.size === 0) {
    return result;
  }

  const fetchedLeagues = await storage.getLeaguesByIds([...allLeagueIds]);
  const leagueMap = new Map(fetchedLeagues.map(l => [l.id, l]));

  const userIsSystemAdmin = isSystemAdmin(req.user);
  const userOrgId = req.user.organizationId ?? null;

  // Iterate ONLY the IDs that still need a fallback decision. IDs
  // already settled by the org-stamp gate above (allowed-on-match,
  // denied-on-admin-mismatch) must not be revisited here.
  for (const bowlerId of stillToCheck) {
    const bowlerLeagueIds = leagueIdsByBowler.get(bowlerId);
    if (!bowlerLeagueIds || bowlerLeagueIds.length === 0) {
      continue;
    }

    let allowed = false;
    for (const leagueId of bowlerLeagueIds) {
      const league = leagueMap.get(leagueId);
      if (!league) continue;

      if (userBowlerId !== null && userLeagueIds.has(league.id)) {
        allowed = true;
        break;
      }
      if (league.organizationId === null) {
        log.debug(`bowler ${bowlerId} via league ${league.id} has no organization — denying access to user ${req.user.id} (role=${req.user.role})`);
        continue;
      }
      if (userIsSystemAdmin) {
        allowed = true;
        break;
      }
      // Only org_admin / system_admin get the
      // org-wide league shortcut. Plain `user` callers must qualify
      // via the userBowlerId league self-membership rule (handled at
      // the top of the loop).
      if (
        isOrgOrHigher(req.user) &&
        userOrgId !== null &&
        userOrgId === league.organizationId
      ) {
        allowed = true;
        break;
      }
    }

    result.set(bowlerId, allowed);
  }

  return result;
}

/**
 * Strict single-bowler access check for WRITE operations and SENSITIVE READ
 * operations (payment data, saved cards, autopay schedules). This helper is
 * intentionally narrower than `hasAccessToBowler`: it denies ordinary
 * authenticated "user"-role callers who share the same organization as the
 * target bowler but are NOT the bowler themselves.
 *
 * Allowed:
 *  - Self-access: the caller's linked bowlerId matches the target.
 *  - org_admin whose organizationId matches the bowler's org stamp.
 *  - system_admin (unconditional, org stamp still must be non-null for
 *    org-less-row safety).
 *
 * Denied for everyone:
 *  - Unauthenticated callers.
 *  - Bowler row not found or org-less (null organizationId stamp) — treated
 *    as orphaned data per the file-level policy, even for system_admin.
 *  - Ordinary "user"-role callers accessing another user's bowler record,
 *    even if both belong to the same organization.
 *
 * Use this instead of `hasAccessToBowler` on all routes that expose
 * financial data, modify bowler profiles, or manage saved cards / autopay.
 */
export async function hasSelfOrAdminAccessToBowler(req: Request, bowlerId: number): Promise<boolean> {
  if (!req.user) return false;

  // Payment managers may read roster data through the dedicated location
  // helper, but never mutate a global bowler profile or manage its sensitive
  // vault/autopay data through this broad helper.
  if (isPaymentManager(req.user)) return false;

  // Self-access: the caller IS the target bowler — always allowed regardless
  // of role so a linked user can always manage their own record.
  if (req.user.bowlerId === bowlerId) return true;

  // Only org_admin and system_admin may access OTHER bowlers' sensitive data.
  if (!isOrgOrHigher(req.user)) return false;

  // system_admin is unconditionally allowed, but we still load the row to
  // apply the org-less deny policy (orphaned rows are blocked for all roles).
  const bowlerRow = await storage.getBowler(bowlerId);
  if (!bowlerRow) return false;
  if (bowlerRow.organizationId === null) {
    log.debug(`bowler ${bowlerId} has no organization — denying sensitive access to user ${req.user.id} (role=${req.user.role})`);
    return false;
  }

  if (isSystemAdmin(req.user)) return true;

  // org_admin: must share the same organization as the target bowler.
  return req.user.organizationId === bowlerRow.organizationId;
}

export async function hasAccessToPayment(req: Request, paymentId: number): Promise<boolean> {
  if (!req.user) {
    return false;
  }

  if (isPaymentManager(req.user)) {
    return hasPaymentManagerAccessToPayment(req, paymentId);
  }

  try {
    const payment = req.user.organizationId && typeof storage.getPaymentByIdForOrganization === "function"
      ? await storage.getPaymentByIdForOrganization(paymentId, req.user.organizationId)
      : await storage.getPaymentById(paymentId);
    if (!payment) {
      return false;
    }

    const league = await storage.getLeague(payment.leagueId);
    if (!league) {
      return false;
    }

    if (league.organizationId === null) {
      log.debug(`payment ${paymentId} via league ${payment.leagueId} has no organization — denying access to user ${req.user.id} (role=${req.user.role})`);
      return false;
    }

    if (isSystemAdmin(req.user)) {
      return true;
    }

    // Organization match alone is NOT sufficient for a
    // plain `user`-role caller — they could otherwise update or delete
    // any same-org payment without an admin grant. Restrict the
    // org-match shortcut to org_admin/system_admin and require a
    // admin role for non-admin callers.
    if (
      isOrgOrHigher(req.user) &&
      req.user.organizationId &&
      req.user.organizationId === league.organizationId
    ) {
      return true;
    }

    return false;
  } catch (error) {
    log.error(`Error checking payment access:`, error);
    return false;
  }
}

/**
 * Read-only receipt access. This intentionally remains separate from
 * hasAccessToPayment: payment PATCH/DELETE must never inherit payer or
 * allocation-participant read access.
 */
export async function hasReceiptReadAccessToPayment(req: Request, paymentId: number): Promise<boolean> {
  if (!req.user) return false;
  if (isSystemAdmin(req.user) || isOrgOrHigher(req.user) || isPaymentManager(req.user)) {
    return hasAccessToPayment(req, paymentId);
  }
  const organizationId = req.user.organizationId;
  if (!organizationId) return false;
  const payment = typeof storage.getPaymentByIdForOrganization === "function"
    ? await storage.getPaymentByIdForOrganization(paymentId, organizationId)
    : await storage.getPaymentById(paymentId);
  if (!payment || payment.paidByUserId === req.user.id || payment.bowlerId === req.user.bowlerId) return Boolean(payment);
  const [allocation] = await db.select({ id: paymentOccurrenceAllocations.id })
    .from(paymentOccurrenceAllocations)
    .innerJoin(leagues, and(
      eq(leagues.id, paymentOccurrenceAllocations.leagueId),
      eq(leagues.organizationId, organizationId),
    ))
    .where(and(
      eq(paymentOccurrenceAllocations.paymentId, paymentId),
      eq(paymentOccurrenceAllocations.organizationId, organizationId),
      eq(paymentOccurrenceAllocations.bowlerId, req.user.bowlerId ?? -1),
    )).limit(1);
  return Boolean(allocation);
}

/**
 * In-memory org/system-admin/org-less filter for a payment list the caller
 * already has in hand (e.g. a payload from a third-party provider, a CSV
 * import, or any other non-DB source).
 *
 * **Prefer `storage.getPayments({ organizationId })` or
 * `storage.getAllPaymentsSystemAdmin()` for lists that come from our own
 * database** (task #295). Those helpers push the same org/org-less filtering
 * into a single SQL query so we don't load rows the caller can never see.
 *
 * Behavior matrix (must match the SQL helpers above):
 *   - unauthenticated caller → `[]`
 *   - system_admin caller → all input payments whose parent league has a
 *     non-null `organization_id` (org-less leagues are excluded for every
 *     role, sysadmin included)
 *   - org user with no `organizationId` → `[]`
 *   - org user → input payments whose parent league belongs to the caller's
 *     org (org-less and cross-org leagues are excluded)
 */
export async function filterPaymentsByOrganization(req: Request, payments: { leagueId: number }[]): Promise<{ leagueId: number }[]> {
  if (!req.user) {
    return [];
  }

  // Resolve which leagueIds in the input set belong to a real organization.
  // Per the org-less resource policy, payments whose parent league is missing
  // or has organization_id IS NULL are excluded for every role, including
  // system_admin.
  const referencedLeagueIds = [...new Set(payments.map(p => p.leagueId))];
  const fetchedLeagues = referencedLeagueIds.length === 0
    ? []
    : await storage.getLeaguesByIds(referencedLeagueIds);
  const orgScopedLeagueIds = new Set(
    fetchedLeagues.filter(l => l.organizationId !== null).map(l => l.id),
  );

  if (isSystemAdmin(req.user)) {
    return payments.filter(p => orgScopedLeagueIds.has(p.leagueId));
  }

  if (!req.user.organizationId) {
    return [];
  }

  const userOrgId = req.user.organizationId;
  const userOrgLeagueIds = new Set(
    fetchedLeagues
      .filter(l => l.organizationId === userOrgId)
      .map(l => l.id),
  );
  return payments.filter(p => orgScopedLeagueIds.has(p.leagueId) && userOrgLeagueIds.has(p.leagueId));
}
