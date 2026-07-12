import { Request } from 'express';
import { storage } from '../storage';
import { createLogger } from '../logger';

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
 * Task #735: returns true iff the requesting user has been granted the
 * League Secretary role for `leagueId` via the `league_secretaries`
 * join table. The lookup goes directly to the DB on every call — these
 * grants are intentionally NOT memoised on the `req.user` session so
 * that an org_admin's revoke takes effect immediately on the very next
 * request from the affected user (no session refresh required).
 *
 * Returns false for unauthenticated callers, system_admin (who already
 * has cross-tenant access via other gates), and for any user whose grant
 * row's organization_id does not match the league's organization_id.
 * The DB-level invariant in `server/db-invariants.ts` enforces the
 * matching-org constraint at write time, so a stamp mismatch is treated
 * as a data-integrity bug — the access check fails closed.
 */
export async function isLeagueSecretaryFor(req: Request, leagueId: number): Promise<boolean> {
  if (!req.user) return false;
  // System admin is intentionally NOT a secretary — they have wider
  // cross-tenant powers via other gates and `system_admin` is excluded
  // from `league_secretaries` to keep the per-league admin surface
  // strictly an org-level construct.
  if (req.user.role === 'system_admin') return false;
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null) return false;
  // Task #735 hardening: the caller's CURRENT org must also match the
  // league's org. `users.organization_id` is mutable (admins can move
  // a user between orgs); if a user is reassigned to a new org, any
  // stale `league_secretaries` rows pointing at their old org must NOT
  // continue to grant cross-tenant powers on the next request. The
  // BEFORE UPDATE trigger on `users` (see `server/db-invariants.ts`)
  // auto-revokes the rows in-transaction, but we also fail closed at
  // the auth layer in case a buggy migration or direct SQL operation
  // bypasses the trigger.
  if (req.user.organizationId !== league.organizationId) return false;
  // Defence in depth: even if a stale grant survives a league
  // org-reassignment, only honour grants whose stamped org matches the
  // league's current org.
  const grant = await storage.getLeagueSecretary(req.user.id, leagueId);
  if (!grant) return false;
  return grant.organizationId === league.organizationId;
}

/**
 * Task #735: combined "may act as an admin on this league" gate.
 * Returns true for: system_admin, org_admin of the league's owning org,
 * or any user with a current league-secretary grant for this league.
 *
 * Use this for read/write gates that should be open to all three admin
 * tiers but still respect the org-less deny rule. Sensitive surfaces
 * that must be HIDDEN from secretaries (saved cards, payment provider
 * config, league delete, location/payment-provider mutations) must
 * continue to use `requireOrganizationAccess` or `isOrgOrHigher` instead
 * of this helper.
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
  if (req.user.role === 'org_admin' && req.user.organizationId === league.organizationId) {
    return true;
  }
  // Task #735 hardening: caller's CURRENT org must also match the
  // league's org before honouring any secretary grant. See the
  // matching note in `isLeagueSecretaryFor` for the reasoning.
  if (req.user.organizationId !== league.organizationId) return false;
  // Fall through to the secretary check.
  const grant = await storage.getLeagueSecretary(req.user.id, leagueId);
  return !!grant && grant.organizationId === league.organizationId;
}

/**
 * Task #735: returns true iff the requesting user is a league secretary
 * for at least one league the bowler is rostered into (and that league's
 * org matches the secretary grant's stamped org). The secretary's view
 * of bowlers is strictly scoped to their granted leagues — a bowler in
 * a sibling league of the same org is NOT visible.
 *
 * Returns false for system_admin (use `hasAccessToBowler` instead) and
 * for any caller without at least one matching grant.
 */
async function hasSecretaryAccessToBowler(req: Request, bowlerId: number): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'system_admin') return false;
  const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(req.user.id);
  if (grantedLeagueIds.length === 0) return false;
  const bowlerLeagueEntries = await storage.getBowlerLeagues({ bowlerId });
  if (bowlerLeagueEntries.length === 0) return false;
  const grantedSet = new Set(grantedLeagueIds);
  const overlap = bowlerLeagueEntries.find((bl) => grantedSet.has(bl.leagueId));
  if (!overlap) return false;
  // Verify org match defensively.
  const league = await storage.getLeague(overlap.leagueId);
  if (!league || league.organizationId === null) return false;
  if (req.user.organizationId !== league.organizationId) return false;
  return true;
}

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

  // Task #735 hardening: org-match alone is NOT sufficient for plain
  // `user`-role callers. Previously any user whose `organizationId`
  // matched the league's org could see every league in the org, which
  // turned league_secretary grants into a no-op for visibility (the
  // secretary user already saw every other league). We restrict the
  // org-match shortcut to `org_admin`/`system_admin` and require
  // non-admin callers to either be a bowler in the league (handled
  // above) or to hold an explicit secretary grant for it.
  if (isOrgOrHigher(req.user) && req.user.organizationId === league.organizationId) {
    return true;
  }

  // Task #735: a user with an active League Secretary grant for this
  // league has league-scoped read+admin access. The grant carries its
  // own org_id == league.org_id invariant (DB trigger + defence-in-depth
  // check inside `isLeagueSecretaryFor`), so this never widens
  // cross-tenant access. Sensitive surfaces that must remain hidden
  // from secretaries (saved cards, payment-provider config, league
  // delete, location/payment-provider mutations) must continue to gate
  // on `requireOrganizationAccess` / `isOrgOrHigher` rather than this
  // helper.
  return await isLeagueSecretaryFor(req, leagueId);
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
    // Task #735 hardening: org-stamp match alone is NOT sufficient
    // for plain `user`-role callers. Previously any user whose
    // `organizationId` matched the bowler's org could read every
    // bowler in the org, which leaked sibling-league bowler data and
    // turned league_secretary scoping into a no-op. The org-match
    // shortcut is now restricted to org_admin/system_admin; non-admin
    // callers must qualify via the secretary scoping (below) or the
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
    // secretary check + league scan below.
    if (isOrgOrHigher(req.user)) {
      return false;
    }
  }

  // Task #735: a League Secretary may access a bowler iff the bowler
  // is rostered into one of their granted leagues (and that league's
  // org matches the grant's stamped org). Checked before the legacy
  // bowler-self league scan so a secretary who is not themselves a
  // bowler still gets access.
  if (await hasSecretaryAccessToBowler(req, bowlerId)) {
    return true;
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
    // Task #735 hardening: same rule as the bowler-row stamp gate
    // above — only org_admin / system_admin get the org-wide league
    // shortcut. Plain `user` callers must qualify via the bowler-self
    // membership rule (handled at the top of the loop) or the
    // secretary scoping rule (handled before this scan).
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
      // Task #735 hardening: org-stamp match shortcut restricted to
      // admins. Non-admin "user" callers must qualify via the league
      // self-membership rule below (or the secretary scoping rule
      // applied at the route layer / via hasAccessToBowler).
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
      // Task #735 hardening: only org_admin / system_admin get the
      // org-wide league shortcut. Plain `user` callers must qualify
      // via the userBowlerId league self-membership rule (handled at
      // the top of the loop) or the secretary scoping rule.
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

  // Task #735: a non-admin user may also access bowlers via a
  // league_secretary grant. Resolve the remaining `false`s through
  // the secretary scoping check, which itself confirms the bowler is
  // rostered into one of the caller's granted leagues. Single small
  // batched lookup keyed off the caller, not per-bowler.
  if (!callerIsSystemAdmin && !isOrgOrHigher(req.user)) {
    const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(req.user.id);
    if (grantedLeagueIds.length > 0) {
      const grantedSet = new Set(grantedLeagueIds);
      for (const bowlerId of stillToCheck) {
        if (result.get(bowlerId)) continue;
        const bowlerLeagueIds = leagueIdsByBowler.get(bowlerId);
        if (!bowlerLeagueIds) continue;
        for (const leagueId of bowlerLeagueIds) {
          if (!grantedSet.has(leagueId)) continue;
          const league = leagueMap.get(leagueId);
          if (!league || league.organizationId === null) continue;
          if (req.user.organizationId !== league.organizationId) continue;
          result.set(bowlerId, true);
          break;
        }
      }
    }
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

  try {
    const payment = await storage.getPaymentById(paymentId);
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

    // Task #735 hardening: org-match alone is NOT sufficient for a
    // plain `user`-role caller — they could otherwise update or delete
    // any same-org payment without an admin grant. Restrict the
    // org-match shortcut to org_admin/system_admin and require a
    // secretary grant for non-admin callers.
    if (
      isOrgOrHigher(req.user) &&
      req.user.organizationId &&
      req.user.organizationId === league.organizationId
    ) {
      return true;
    }

    // Task #735: a league secretary may act on payments for their
    // granted league. The grant carries its own org match invariant
    // (DB trigger + defence-in-depth check inside `isLeagueSecretaryFor`).
    return await isLeagueSecretaryFor(req, payment.leagueId);
  } catch (error) {
    log.error(`Error checking payment access:`, error);
    return false;
  }
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
