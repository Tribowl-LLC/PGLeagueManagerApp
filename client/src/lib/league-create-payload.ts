import type { InsertLeague } from "@shared/schema";

type CanonicalLeagueCreatePayload = Omit<
  InsertLeague,
  | "seasonEnd"
  | "seasonNumber"
  | "previousSeasonId"
  | "finalTwoWeeksDueWeek"
  | "organizationId"
> & { organizationId?: number };

export function buildCanonicalLeagueCreatePayload(
  data: InsertLeague,
  systemAdminOrganizationId?: number | null,
): CanonicalLeagueCreatePayload {
  const {
    seasonEnd: _derivedSeasonEnd,
    seasonNumber: _serverOwnedSeasonNumber,
    previousSeasonId: _serverOwnedPreviousSeasonId,
    finalTwoWeeksDueWeek: _retiredFinalTwoWeeksDueWeek,
    organizationId: _untrustedOrganizationId,
    ...target
  } = data;

  return systemAdminOrganizationId == null
    ? target
    : { ...target, organizationId: systemAdminOrganizationId };
}
