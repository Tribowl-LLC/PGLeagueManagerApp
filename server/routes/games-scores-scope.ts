import type { Request } from "express";
import { storage } from "../storage/index.js";
import { hasAccessToLeague } from "../utils/access-control.js";

export type AuthorizedLeagueScopeResult =
  | { kind: "authorized"; organizationId: number; leagueId: number }
  | { kind: "system_scope_required" }
  | { kind: "not_found" };

export function positiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function authorizedOrganizationId(req: Request): number | "system_scope_required" | null {
  if (!req.user) return null;
  if (req.user.role === "system_admin") {
    return positiveId(req.query.organizationId) ?? "system_scope_required";
  }
  const organizationId = req.user.organizationId;
  return organizationId && Number.isSafeInteger(organizationId) && organizationId > 0
    ? organizationId
    : null;
}

export async function authorizedLeagueScope(
  req: Request,
  leagueId: number,
): Promise<AuthorizedLeagueScopeResult> {
  const organizationId = authorizedOrganizationId(req);
  if (organizationId === "system_scope_required") return { kind: "system_scope_required" };
  if (organizationId === null) return { kind: "not_found" };
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId !== organizationId) return { kind: "not_found" };
  if (!(await hasAccessToLeague(req, leagueId))) return { kind: "not_found" };
  return { kind: "authorized", organizationId, leagueId };
}
