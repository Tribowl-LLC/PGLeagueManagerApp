export interface ScoreReadRequest {
  queryKey: readonly [string, number, number, string];
  url: string;
}

function scopedUrl(path: string, organizationId: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}organizationId=${organizationId}`;
}

export function leagueLatestScoresRequest(leagueId: number, organizationId: number): ScoreReadRequest {
  const url = scopedUrl(
    `/api/scores?leagueId=${leagueId}&selection=latest_scored_session`,
    organizationId,
  );
  return {
    queryKey: ["/api/scores/latest-scored-session", leagueId, organizationId, url],
    url,
  };
}

export function bowlerScoreHistoryRequest(bowlerId: number, organizationId: number): ScoreReadRequest {
  const url = scopedUrl(`/api/scores/history?bowlerId=${bowlerId}`, organizationId);
  return {
    queryKey: ["/api/scores/history", bowlerId, organizationId, url],
    url,
  };
}
